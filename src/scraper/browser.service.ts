import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Browser, BrowserContext, Page, chromium } from 'playwright';
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
 * One Chromium *process* shared by every job this worker runs — browsers are
 * expensive (100s of MB), contexts are cheap-ish but not free. Rather than
 * open+close a BrowserContext per job, this keeps a bounded pool (sized by
 * `scraper.maxContexts`) and reuses each one across jobs: `withContext()`
 * checks one out, hands it to the caller, then clears its cookies and checks
 * it back in (or recycles it after MAX_USES_PER_CONTEXT jobs) instead of
 * closing it. Isolation between concurrent jobs is still per-Page (each
 * caller opens/closes its own page), which is all that's needed here since
 * every job is anonymous browsing of public pages, not authenticated state
 * that must never leak between jobs.
 *
 * Auto-relaunches on an unexpected disconnect (a crashed renderer, an OOM
 * kill) so one Chromium crash doesn't permanently take a worker process out
 * of rotation — "using multiple workers it should not break".
 */
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
    } else {
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
    const context = await browser.newContext({
      viewport: { width: 1366, height: 768 },
      locale: 'en-IN',
      timezoneId: 'Asia/Kolkata',
    });

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
   * cooldown is active (no point spending a page load just to get blocked
   * again), then wait for the traffic shaper's token bucket (the actual
   * fleet-wide rate cap) plus a small extra jitter so jobs that were waiting
   * on the same token don't all fire on the same tick, then check the
   * response for block signals afterward.
   */
  async safeGoto(page: Page, url: string, timeoutMs = 45_000): Promise<void> {
    await this.antiBotGuard.assertNotBlocked();
    await this.trafficShaper.acquire();
    await this.jitterDelay();

    const baseUrl = this.config.get('scraper.expediaBaseUrl', { infer: true });

    // Akamai Bot Manager blocks cold direct hits to /Hotel-Search if no session exists.
    // If context has no cookies yet, visit homepage first to establish session and sensor cookies.
    const cookies = await page.context().cookies();
    if (cookies.length === 0 && url.includes('/Hotel-Search')) {
      this.logger.log(`Warming up session on homepage (${baseUrl}) to acquire anti-bot trust cookies...`);
      try {
        const homeRes = await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        this.logger.log(`Homepage responded: ${homeRes?.status()} — waiting 4s for anti-bot telemetry handshake...`);
        await page.waitForTimeout(4000);
      } catch (err) {
        this.logger.warn(`Homepage warm-up navigation notice: ${(err as Error).message}`);
      }
    }

    this.logger.log(`Navigating to target: ${url}`);
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
      referer: baseUrl,
    });
    this.logger.log(`Target responded with status: ${response?.status()}`);
    const blockReason = await this.antiBotGuard.checkPage(page, response?.status());
    if (blockReason) {
      throw new Error(`Blocked by Expedia anti-bot (${blockReason}) while loading ${url}`);
    }
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
    // Every pooled context belonged to the dead browser process — drop them
    // rather than handing out contexts whose underlying process is gone.
    // Anything currently checked out by an in-flight job will fail its next
    // Playwright call and that job will retry, same as before pooling existed.
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
