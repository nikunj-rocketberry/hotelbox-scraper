import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Browser, BrowserContext, Page, chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { AppConfig } from '../config/configuration';
import { AntiBotGuardService } from './anti-bot-guard.service';
import { TrafficShaperService } from './traffic-shaper.service';

/** Recycle a pooled context after this many jobs so per-context heap/JS-listener growth can't accumulate indefinitely across a long-running worker. */
const MAX_USES_PER_CONTEXT = 100;

/**
 * Abort heavy media (audio/video).
 * NOTE: Do not block 'font' by default — modern anti-bot scripts (Akamai/Kasada)
 * check for font loading (document.fonts.ready) and can flag contexts where fonts fail.
 */
const BLOCKED_RESOURCE_TYPES = new Set(['media']);

interface PooledContext {
  context: BrowserContext;
  uses: number;
}

/**
 * Client-side stealth patches injected into every frame before page scripts run.
 * Neutralizes standard Playwright/CDP automation markers checked by Akamai Bot Manager.
 */
const STEALTH_INIT_SCRIPT = `
(() => {
  // 1. Remove navigator.webdriver
  try {
    const proto = Object.getPrototypeOf(navigator);
    if ('webdriver' in proto) {
      delete proto.webdriver;
    }
  } catch (e) {}
  try {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
      configurable: true,
      enumerable: true,
    });
  } catch (e) {}

  // 2. Mock window.chrome runtime & timing
  try {
    if (!window.chrome) {
      window.chrome = {};
    }
    if (!window.chrome.runtime) {
      window.chrome.runtime = {
        PlatformOs: { MAC: 'mac', WIN: 'win', ANDROID: 'android', CROS: 'cros', LINUX: 'linux', OPENBSD: 'openbsd' },
        PlatformArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64', MIPS: 'mips', MIPS64: 'mips64' },
        PlatformNaclArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64', MIPS: 'mips', MIPS64: 'mips64' },
        RequestUpdateCheckStatus: { THROTTLED: 'throttled', NO_UPDATE: 'no_update', UPDATE_AVAILABLE: 'update_available' },
        OnInstalledReason: { INSTALL: 'install', UPDATE: 'update', CHROME_UPDATE: 'chrome_update', SHARED_MODULE_UPDATE: 'shared_module_update' },
        OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
      };
    }
    if (!window.chrome.loadTimes) {
      window.chrome.loadTimes = () => ({
        requestTime: Date.now() / 1000,
        startLoadTime: Date.now() / 1000,
        commitLoadTime: Date.now() / 1000,
        finishDocumentLoadTime: Date.now() / 1000,
        firstPaintTime: Date.now() / 1000,
        firstPaintAfterLoadTime: 0,
        navigationType: 'Other',
        wasFetchedViaSpdy: false,
        wasNpnNegotiated: false,
        npnNegotiatedProtocol: '',
        wasAlternateProtocolAvailable: false,
        connectionInfo: 'http/1.1',
      });
    }
    if (!window.chrome.csi) {
      window.chrome.csi = () => ({
        startE: Date.now(),
        onloadT: Date.now() + 80,
        pageT: 80,
        tran: 15,
      });
    }
  } catch (e) {}

  // 3. Mock navigator.plugins & mimeTypes
  try {
    if (!navigator.plugins || navigator.plugins.length === 0) {
      const pluginData = [
        { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      ];
      const plugins = Object.create(PluginArray.prototype);
      pluginData.forEach((p, idx) => {
        const plugin = Object.create(Plugin.prototype);
        Object.defineProperties(plugin, {
          name: { value: p.name },
          filename: { value: p.filename },
          description: { value: p.description },
          length: { value: 0 },
        });
        plugins[idx] = plugin;
      });
      Object.defineProperty(plugins, 'length', { value: pluginData.length });
      Object.defineProperty(navigator, 'plugins', { get: () => plugins, configurable: true });
    }
  } catch (e) {}

  // 4. Mock languages
  try {
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-IN', 'en-GB', 'en-US', 'en'],
      configurable: true,
    });
  } catch (e) {}

  // 5. Notification permissions query
  try {
    if (window.navigator.permissions && window.navigator.permissions.query) {
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) =>
        parameters && parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission || 'default' })
          : originalQuery(parameters);
    }
  } catch (e) {}
})();
`;

@Injectable()
export class BrowserService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BrowserService.name);
  private browser: Browser;
  private launching?: Promise<Browser>;

  private readonly maxContexts: number;
  private readonly blockNonEssentialResources: boolean;
  private readonly navJitterMs: readonly [number, number];
  private readonly idle: PooledContext[] = [];
  private readonly waiters: Array<(pooled: PooledContext) => void> = [];
  private outstanding = 0;

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly antiBotGuard: AntiBotGuardService,
    private readonly trafficShaper: TrafficShaperService,
  ) {
    this.maxContexts = config.get('scraper.maxContexts', { infer: true });
    this.blockNonEssentialResources = config.get('scraper.blockNonEssentialResources', { infer: true });
    this.navJitterMs = [
      config.get('scraper.navJitterMinMs', { infer: true }),
      config.get('scraper.navJitterMaxMs', { infer: true }),
    ];
  }

  async onModuleInit(): Promise<void> {
    this.browser = await this.launch();
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(this.idle.map((p) => p.context.close().catch(() => undefined)));
    this.idle.length = 0;
    await this.browser?.close().catch(() => undefined);
  }

  async withContext<T>(fn: (context: BrowserContext) => Promise<T>): Promise<T> {
    const pooled = await this.acquire();
    try {
      return await fn(pooled.context);
    } finally {
      await this.release(pooled);
    }
  }

  private async acquire(): Promise<PooledContext> {
    const free = this.idle.pop();
    if (free) return free;

    if (this.outstanding < this.maxContexts) {
      this.outstanding++;
      return { context: await this.createContext(), uses: 0 };
    }

    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private async release(pooled: PooledContext): Promise<void> {
    pooled.uses++;
    const worthKeeping = pooled.uses < MAX_USES_PER_CONTEXT && this.browser?.isConnected();

    if (worthKeeping) {
      // Retain session/anti-bot cookies in the pooled context so Akamai verification tokens persist across jobs.
      await this.saveContextState(pooled.context).catch(() => undefined);
    } else {
      await this.saveContextState(pooled.context).catch(() => undefined);
      await pooled.context.close().catch(() => undefined);
      this.outstanding--;
    }

    const waiter = this.waiters.shift();
    if (!waiter) {
      if (worthKeeping) this.idle.push(pooled);
      return;
    }

    if (worthKeeping) {
      waiter(pooled);
    } else {
      this.outstanding++;
      waiter({ context: await this.createContext(), uses: 0 });
    }
  }

  private async createContext(): Promise<BrowserContext> {
    const browser = await this.getConnectedBrowser();

    const stateFile = this.getStorageStatePath();
    const hasState = stateFile && fs.existsSync(stateFile);

    const contextOptions: any = {
      viewport: { width: 1366, height: 768 },
      locale: 'en-IN',
      timezoneId: 'Asia/Kolkata',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
      extraHTTPHeaders: {
        'Accept-Language': 'en-IN,en-GB;q=0.9,en-US;q=0.8,en;q=0.7',
        'Sec-CH-UA': '"Google Chrome";v="129", "Not=A?Brand";v="8", "Chromium";v="129"',
        'Sec-CH-UA-Mobile': '?0',
        'Sec-CH-UA-Platform': '"Windows"',
      },
    };

    if (hasState) {
      try {
        contextOptions.storageState = stateFile;
        this.logger.log(`Restored persistent browser session state from ${stateFile}`);
      } catch (err) {
        this.logger.warn(`Could not read storage state from ${stateFile}: ${(err as Error).message}`);
      }
    }

    const context = await browser.newContext(contextOptions);
    await context.addInitScript(STEALTH_INIT_SCRIPT);

    if (this.blockNonEssentialResources) {
      await context.route('**/*', (route) => {
        const type = route.request().resourceType();
        return BLOCKED_RESOURCE_TYPES.has(type) ? route.abort() : route.continue();
      });
    }

    return context;
  }

  /**
   * Every navigation goes through here: fail fast if the fleet-wide anti-bot
   * cooldown is active, wait for the traffic shaper's token bucket plus jitter,
   * verify/warm up anti-bot session trust, then navigate and inspect response.
   */
  async safeGoto(page: Page, url: string, timeoutMs = 45_000): Promise<void> {
    await this.antiBotGuard.assertNotBlocked();
    await this.trafficShaper.acquire();
    await this.jitterDelay();

    const baseUrl = this.config.get('scraper.expediaBaseUrl', { infer: true });

    // Akamai Bot Manager blocks cold direct hits to /Hotel-Search if no session exists.
    // Verify whether context already has a validated Akamai trust cookie (_abck with ~0~).
    const cookies = await page.context().cookies();
    const hasTrustedCookie = cookies.some((c) => c.name === '_abck' && c.value.includes('~0~'));
    const isProtectedTarget = url.includes('/Hotel-Search') || url.includes('.Hotel-Information');

    if ((!hasTrustedCookie || cookies.length === 0) && isProtectedTarget) {
      await this.warmUpSession(page, baseUrl, timeoutMs);
    }

    this.logger.log(`Navigating to target: ${url}`);
    let response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
      referer: baseUrl,
    });
    this.logger.log(`Target responded with status: ${response?.status()}`);

    // If a 429 occurs on the target, attempt one active re-warmup and single retry before failing
    if (response?.status() === 429) {
      this.logger.warn(`Target responded with 429 — executing active human telemetry re-warmup before retry...`);
      await this.warmUpSession(page, baseUrl, timeoutMs);
      await this.jitterDelay();
      response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs,
        referer: baseUrl,
      });
      this.logger.log(`Retry target responded with status: ${response?.status()}`);
    }

    const blockReason = await this.antiBotGuard.checkPage(page, response?.status());
    if (blockReason) {
      throw new Error(`Blocked by Expedia anti-bot (${blockReason}) while loading ${url}`);
    }

    // Persist verified session cookies to disk
    await this.saveContextState(page.context()).catch(() => undefined);
  }

  /**
   * Active human telemetry handshake on the homepage:
   * 1. Loads homepage
   * 2. Simulates smooth human mouse movements (curve trajectory)
   * 3. Simulates gentle scrolling down and up
   * 4. Hovers near interactive elements
   * 5. Polls for Akamai's _abck cookie transitioning to ~0~ (trusted)
   */
  private async warmUpSession(page: Page, baseUrl: string, timeoutMs = 45_000): Promise<void> {
    this.logger.log(`Warming up session on homepage (${baseUrl}) with human telemetry simulation...`);
    try {
      const homeRes = await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      this.logger.log(`Homepage responded: ${homeRes?.status()} — generating human telemetry for Akamai sensor handshake...`);

      await page.waitForTimeout(1200);

      // 1. Natural mouse trajectory across the screen (interpolated easing steps)
      const startX = 220 + Math.floor(Math.random() * 80);
      const startY = 160 + Math.floor(Math.random() * 60);
      const endX = 620 + Math.floor(Math.random() * 120);
      const endY = 360 + Math.floor(Math.random() * 80);

      await page.mouse.move(startX, startY);
      const steps = 22;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const curX = Math.round(startX + (endX - startX) * t + Math.sin(t * Math.PI) * 45);
        const curY = Math.round(startY + (endY - startY) * t + Math.cos(t * Math.PI) * 20);
        await page.mouse.move(curX, curY);
        await page.waitForTimeout(25 + Math.floor(Math.random() * 20));
      }

      // 2. Gentle human scrolling down and up to fire scroll telemetry
      await page.evaluate(() => window.scrollBy({ top: 320, behavior: 'smooth' })).catch(() => undefined);
      await page.waitForTimeout(800);
      await page.evaluate(() => window.scrollBy({ top: -180, behavior: 'smooth' })).catch(() => undefined);
      await page.waitForTimeout(600);

      // 3. Hover over search field trigger to fire realistic focus / pointer events
      const searchBox = await page
        .$('button[aria-label*="Where"], button:has-text("Where to"), [data-stid*="destination"]')
        .catch(() => null);
      if (searchBox) {
        const rect = await searchBox.boundingBox().catch(() => null);
        if (rect) {
          await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
          await page.waitForTimeout(400);
        }
      }

      // 4. Poll for Akamai _abck cookie validation (~0~ indicates validated telemetry)
      let verified = false;
      for (let attempt = 0; attempt < 6; attempt++) {
        const currentCookies = await page.context().cookies();
        const abck = currentCookies.find((c) => c.name === '_abck');
        if (abck && abck.value.includes('~0~')) {
          this.logger.log(`Akamai anti-bot handshake verified (_abck validated with ~0~)`);
          verified = true;
          break;
        }
        await page.waitForTimeout(1000);
      }

      if (!verified) {
        this.logger.log('Warmup telemetry dispatched; proceeding to target navigation...');
      }

      await this.saveContextState(page.context()).catch(() => undefined);
    } catch (err) {
      this.logger.warn(`Homepage warm-up notice: ${(err as Error).message}`);
    }
  }

  private async saveContextState(context: BrowserContext): Promise<void> {
    const stateFile = this.getStorageStatePath();
    if (!stateFile) return;
    try {
      const dir = path.dirname(stateFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      await context.storageState({ path: stateFile });
    } catch (err) {
      this.logger.warn(`Failed to persist browser state to ${stateFile}: ${(err as Error).message}`);
    }
  }

  private getStorageStatePath(): string | null {
    const userDataDir = this.config.get('scraper.userDataDir', { infer: true });
    if (!userDataDir) return null;
    return path.resolve(process.cwd(), userDataDir, 'storage-state.json');
  }

  private jitterDelay(): Promise<void> {
    const [minMs, maxMs] = this.navJitterMs;
    if (maxMs <= 0) return Promise.resolve();
    const delay = minMs + Math.random() * (maxMs - minMs);
    return new Promise((resolve) => setTimeout(resolve, delay));
  }

  private async getConnectedBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (this.launching) return this.launching;

    this.logger.warn('Chromium disconnected — relaunching');
    this.idle.length = 0;
    this.outstanding = 0;

    this.launching = this.launch();
    this.browser = await this.launching;
    this.launching = undefined;
    return this.browser;
  }

  private async launch(): Promise<Browser> {
    const launchOptions = {
      channel: 'chrome',
      headless: this.config.get('scraper.headless', { infer: true }),
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-infobars',
        '--window-position=0,0',
        '--ignore-certificate-errors',
        '--ignore-certificate-errors-spki-list',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
    };

    try {
      const browser = await chromium.launch(launchOptions);
      browser.on('disconnected', () => this.logger.warn('Browser process exited'));
      this.logger.log('Google Chrome launched with stealth patches');
      return browser;
    } catch {
      delete (launchOptions as any).channel;
      const browser = await chromium.launch(launchOptions);
      browser.on('disconnected', () => this.logger.warn('Browser process exited'));
      this.logger.log('Bundled Chromium launched with stealth patches');
      return browser;
    }
  }
}
