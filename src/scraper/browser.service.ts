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

/**
 * Akamai Bot Manager's own trust cookies — the ONLY state we copy from the
 * manual-solve browser into the live pool. Deliberately narrow: syncing a
 * human's full cookie jar/localStorage into every pooled context would merge
 * 15 independent sessions into one, which is exactly the correlated-activity
 * signal the per-context pool exists to avoid. We just want the verified
 * "not a bot" token to propagate, nothing else about that session.
 */
const AKAMAI_TRUST_COOKIE_NAMES = new Set(['_abck', 'bm_sz', 'ak_bmsc', 'bm_sv', 'bm_mi']);

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

  // Every context currently alive in the pool, idle AND checked out by a job —
  // so a manual CAPTCHA solve can push the fresh trust cookie into all of
  // them, not just the ones sitting idle at that moment.
  private readonly liveContexts = new Set<BrowserContext>();

  private readonly manualSolveEnabled: boolean;
  private readonly manualSolveTimeoutMs: number;
  /** Keeps concurrent saveContextState() temp filenames from colliding within this process. */
  private stateWriteCounter = 0;
  /** Serializes cold-start warmups — see warmUpSerialized(). */
  private warmupPromise: Promise<void> | null = null;
  // In-process lock: if several contexts hit the block around the same time,
  // they all join the one solver session already in flight instead of each
  // popping open their own headed window.
  private solverPromise: Promise<void> | null = null;

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
    this.manualSolveEnabled = config.get('scraper.manualSolveEnabled', { infer: true });
    this.manualSolveTimeoutMs = config.get('scraper.manualSolveTimeoutMs', { infer: true });
  }

  async onModuleInit(): Promise<void> {
    // Must go through getConnectedBrowser() rather than calling launch()
    // directly: BullMQ starts pulling jobs immediately, and a job that reaches
    // getConnectedBrowser() before this first launch resolves would see both
    // `browser` and `launching` unset and start a SECOND Chrome — orphaning one
    // of them for the lifetime of the process (onModuleDestroy only closes
    // `this.browser`). Routing both paths through the same promise makes
    // concurrent callers join the launch already in flight.
    await this.getConnectedBrowser();
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(this.idle.map((p) => p.context.close().catch(() => undefined)));
    this.idle.length = 0;
    this.liveContexts.clear();
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

    // Two guards, because `outstanding` alone can drift: a browser crash
    // relaunches via getConnectedBrowser() (which zeroes the counter) WHILE the
    // release() calls for every context that died are still decrementing it.
    // `liveContexts` is ground truth for contexts that actually exist, so it
    // catches a counter that drifted low; `outstanding` covers what that set
    // can't see — creations still in flight, reserved synchronously here before
    // the await, so N concurrent acquires can't all race past the cap.
    if (this.outstanding < this.maxContexts && this.liveContexts.size < this.maxContexts) {
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
      this.liveContexts.delete(pooled.context);
      // Floor at 0: after a crash-triggered relaunch zeroes this counter, the
      // in-flight release() calls for the dead contexts still land here, and a
      // negative count would let acquire() create well past maxContexts.
      this.outstanding = Math.max(0, this.outstanding - 1);
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

  private buildContextOptions(): Record<string, unknown> {
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
        // Seed from the parsed object rather than the path so a CHALLENGED
        // _abck (`~-1~`) can be stripped first. Carrying one forward hands every
        // new context a token Akamai has already flagged; dropping it lets the
        // first request mint a clean one. Everything else in the session is kept.
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (Array.isArray(state.cookies)) {
          const before = state.cookies.length;
          state.cookies = state.cookies.filter((c: { name?: string; value?: string }) => !(c.name === '_abck' && !String(c.value ?? '').includes('~0~')));
          if (state.cookies.length < before) {
            this.logger.warn('Dropped an untrusted _abck from persisted state — new context will get a fresh token.');
          }
        }
        contextOptions.storageState = state;
        this.logger.log(`Restored persistent browser session state from ${stateFile}`);
      } catch (err) {
        this.logger.warn(`Could not read storage state from ${stateFile}: ${(err as Error).message}`);
      }
    }

    return contextOptions;
  }

  private async createContext(): Promise<BrowserContext> {
    const browser = await this.getConnectedBrowser();
    const context = await browser.newContext(this.buildContextOptions());
    await context.addInitScript(STEALTH_INIT_SCRIPT);

    if (this.blockNonEssentialResources) {
      await context.route('**/*', (route) => {
        const type = route.request().resourceType();
        return BLOCKED_RESOURCE_TYPES.has(type) ? route.abort() : route.continue();
      });
    }

    this.liveContexts.add(context);
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
      await this.warmUpSerialized(page, baseUrl, timeoutMs);
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
      // Serialized too: a 429 typically hits several contexts at once, and N
      // simultaneous re-warmups is the same burst that caused it.
      await this.warmUpSerialized(page, baseUrl, timeoutMs);
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
      if (this.manualSolveEnabled) {
        await this.resolveBlockManually(url).catch((err) =>
          this.logger.error(`Manual solve attempt failed: ${(err as Error).message}`),
        );
      }
      throw new Error(`Blocked by Expedia anti-bot (${blockReason}) while loading ${url}`);
    }

    // Persist verified session cookies to disk
    await this.saveContextState(page.context()).catch(() => undefined);
  }

  /**
   * Opens one headed Chrome window so a human can clear a CAPTCHA/challenge,
   * then propagates just the Akamai trust cookies (never the full session —
   * see AKAMAI_TRUST_COOKIE_NAMES) into every live pooled context so the
   * whole headless fleet resumes without each of them re-triggering their
   * own challenge. The fleet-wide Redis cooldown (AntiBotGuardService) is
   * already pausing every other worker while this runs.
   *
   * In-process only: whichever worker hits the block first opens the window;
   * concurrent callers just await the same in-flight solve.
   */
  private async resolveBlockManually(url: string): Promise<void> {
    if (this.solverPromise) {
      return this.solverPromise;
    }
    this.solverPromise = this.runManualSolve(url).finally(() => {
      this.solverPromise = null;
    });
    return this.solverPromise;
  }

  private async runManualSolve(url: string): Promise<void> {
    this.logger.warn(`Anti-bot challenge hit — opening a headed Chrome window for manual solve: ${url}`);

    let solverBrowser: Browser;
    try {
      solverBrowser = await this.launch(false);
    } catch (err) {
      this.logger.error(`Could not launch headed solver browser (no display available?): ${(err as Error).message}`);
      return;
    }

    try {
      const context = await solverBrowser.newContext(this.buildContextOptions());
      await context.addInitScript(STEALTH_INIT_SCRIPT);
      const page = await context.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch((err) => {
        this.logger.warn(`Solver window navigation notice: ${(err as Error).message}`);
      });

      this.logger.warn(
        `>>> Please solve the CAPTCHA/challenge in the opened Chrome window. Waiting up to ${Math.round(this.manualSolveTimeoutMs / 1000)}s...`,
      );

      const verified = await this.waitForManualSolve(context, page, url);
      if (!verified) {
        this.logger.warn('Manual solve did not verify (timed out, or the window was closed before the challenge cleared) — falling back to the normal cooldown wait.');
        return;
      }

      this.logger.log('Manual verification confirmed — propagating trust to the headless pool.');
      await this.saveContextState(context, { force: true }).catch(() => undefined);
      await this.syncAkamaiTrust(context);
      await this.antiBotGuard.clearBlock();
    } finally {
      await solverBrowser.close().catch(() => undefined);
    }
  }

  /**
   * Waits for a human to clear the challenge in the headed window.
   *
   * Does NOT rely solely on `_abck` flipping to ~0~: Akamai generally only
   * upgrades that cookie on a SUBSEQUENT request, so a solved challenge sitting
   * on a static page can leave it at ~-1~ indefinitely — which previously meant
   * the solve was never detected, the window hung open for the full timeout, and
   * the fleet cooldown was never cleared.
   *
   * So the real success signal is the one we actually care about: can this
   * session load the target page again? The cookie is kept only as a fast path.
   *
   * While waiting, the fleet-wide cooldown is deliberately kept fresh — its own
   * TTL is shorter than the solve timeout, so without this the other workers
   * would come charging back mid-solve and re-trip the block.
   */
  private async waitForManualSolve(context: BrowserContext, page: Page, targetUrl: string): Promise<boolean> {
    const deadline = Date.now() + this.manualSolveTimeoutMs;
    let lastCooldownRefresh = 0;
    let lastProbe = Date.now(); // the initial goto just happened; don't re-probe immediately

    while (Date.now() < deadline) {
      // Keep other workers parked while the human works, well inside the cooldown's own TTL.
      if (Date.now() - lastCooldownRefresh > 60_000) {
        await this.antiBotGuard.reportBlock('manual-solve-in-progress').catch(() => undefined);
        lastCooldownRefresh = Date.now();
      }

      if (page.isClosed()) {
        // Human closed the window — verify on a fresh page rather than assuming
        // either outcome, since the context (and its cookies) outlives the page.
        this.logger.log('Solver window closed — verifying whether the session works now.');
        return this.confirmSessionWorks(context, targetUrl);
      }

      const cookies = await context.cookies().catch(() => [] as Awaited<ReturnType<BrowserContext['cookies']>>);
      if (cookies.some((c) => c.name === '_abck' && c.value.includes('~0~'))) {
        this.logger.log('Akamai trust cookie observed in solver window.');
        return true;
      }

      // Challenge visibly gone from the window? Confirm with a real navigation.
      // Throttled: a challenge page whose wording doesn't match BLOCK_SIGNALS
      // would otherwise look "clear" and have us probing Expedia every few
      // seconds while the human is still working — more traffic during a block,
      // which is exactly the wrong thing to do.
      const stillBlocked = await this.antiBotGuard.detectBlockReason(page, undefined).catch(() => null);
      if (!stillBlocked && Date.now() - lastProbe > 20_000) {
        lastProbe = Date.now();
        if (await this.confirmSessionWorks(context, targetUrl)) return true;
      }

      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    return false;
  }

  /** Ground truth for "is this session usable again": load the target on a throwaway page and see if it comes back clean. */
  private async confirmSessionWorks(context: BrowserContext, targetUrl: string): Promise<boolean> {
    const probe = await context.newPage().catch(() => null);
    if (!probe) return false;
    try {
      const response = await probe.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => null);
      if (!response || response.status() >= 400) return false;
      const reason = await this.antiBotGuard.detectBlockReason(probe, response.status()).catch(() => 'probe-failed');
      return !reason;
    } finally {
      await probe.close().catch(() => undefined);
    }
  }

  /** Copies ONLY Akamai's own trust cookies into every live context — see AKAMAI_TRUST_COOKIE_NAMES. */
  private async syncAkamaiTrust(solvedContext: BrowserContext): Promise<void> {
    const cookies = await solvedContext.cookies();
    const trustCookies = cookies.filter((c) => AKAMAI_TRUST_COOKIE_NAMES.has(c.name));
    if (trustCookies.length === 0) return;

    await Promise.all(
      [...this.liveContexts].map((ctx) =>
        ctx.addCookies(trustCookies).catch((err) =>
          this.logger.warn(`Failed to sync trust cookie into a pooled context: ${(err as Error).message}`),
        ),
      ),
    );
    this.logger.log(`Synced ${trustCookies.length} Akamai trust cookie(s) into ${this.liveContexts.size} live context(s).`);
  }

  /** True when this context already holds a validated Akamai token. */
  private async contextHasTrust(context: BrowserContext): Promise<boolean> {
    const cookies = await context.cookies().catch(() => [] as Awaited<ReturnType<BrowserContext['cookies']>>);
    return cookies.some((c) => c.name === '_abck' && c.value.includes('~0~'));
  }

  /**
   * Warmup, but never more than one at a time across the whole pool.
   *
   * On a cold start every pooled context lacks a trusted token, so all of them
   * used to run warmUpSession() simultaneously — N unthrottled homepage hits in
   * the same instant (these don't draw a traffic-shaper token; only the target
   * navigation does). Observed live: that burst alone returns 429 and blocks the
   * fleet before it has scraped anything.
   *
   * Now the first caller does the handshake and, if it earns trust, propagates
   * it to every live context; the rest wake up already trusted and skip warmup
   * entirely — one homepage hit instead of N. If that handshake didn't earn
   * trust, the waiters fall through and take their turn one after another, so
   * the worst case is staggered rather than simultaneous.
   */
  private async warmUpSerialized(page: Page, baseUrl: string, timeoutMs: number): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const inFlight = this.warmupPromise;
      if (inFlight) {
        await inFlight.catch(() => undefined);
        if (await this.contextHasTrust(page.context())) return;
        continue; // that warmup didn't get us trust — take our own turn
      }

      // No await between reading warmupPromise above and assigning it here, so
      // concurrent callers can't both start a warmup.
      const run = this.warmUpSession(page, baseUrl, timeoutMs)
        .then(async () => {
          if (await this.contextHasTrust(page.context())) {
            await this.syncAkamaiTrust(page.context());
          }
        })
        .finally(() => {
          this.warmupPromise = null;
        });
      this.warmupPromise = run;
      await run.catch(() => undefined);
      return;
    }
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

  /**
   * Persists a context's session to the ONE shared state file that seeds every
   * newly created context. Two guards, because every context in the pool writes
   * to this same path concurrently:
   *
   *  - Only write when this context actually holds a verified Akamai token.
   *    Previously any context could save, so an untrusted one could overwrite
   *    the hard-won trusted session (including one a human just solved a CAPTCHA
   *    for) with a worse one, and every context created afterwards inherited the
   *    downgrade.
   *  - Write to a temp file and rename it into place, so a reader creating a
   *    context never sees a half-written file if another context is mid-save.
   */
  private async saveContextState(context: BrowserContext, opts?: { force?: boolean }): Promise<void> {
    const stateFile = this.getStorageStatePath();
    if (!stateFile) return;

    // `force` is for the manual-solve path: a human just proved the session
    // loads pages again, which is stronger evidence than the cookie shape —
    // and Akamai may not have upgraded _abck to ~0~ yet at that moment.
    if (!opts?.force) {
      const cookies = await context.cookies().catch(() => [] as Awaited<ReturnType<BrowserContext['cookies']>>);
      const hasTrustedCookie = cookies.some((c) => c.name === '_abck' && c.value.includes('~0~'));
      if (!hasTrustedCookie) return;
    }

    const tempFile = `${stateFile}.${process.pid}.${this.stateWriteCounter++}.tmp`;
    try {
      const dir = path.dirname(stateFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      await context.storageState({ path: tempFile });
      await fs.promises.rename(tempFile, stateFile);
    } catch (err) {
      await fs.promises.unlink(tempFile).catch(() => undefined);
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

    // Only a browser we HAD and lost is a relaunch — the very first launch
    // (from onModuleInit) has no pool state to discard and isn't a crash.
    if (this.browser) {
      this.logger.warn('Chromium disconnected — relaunching');
      this.idle.length = 0;
      this.outstanding = 0;
      this.liveContexts.clear();
    }

    this.launching = this.launch();
    try {
      this.browser = await this.launching;
    } finally {
      this.launching = undefined;
    }
    return this.browser;
  }

  private async launch(headless = this.config.get('scraper.headless', { infer: true })): Promise<Browser> {
    const launchOptions = {
      channel: 'chrome',
      headless,
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
