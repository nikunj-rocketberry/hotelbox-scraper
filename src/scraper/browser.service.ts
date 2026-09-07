import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Browser, BrowserContext, Page, chromium } from 'playwright';
import { AppConfig } from '../config/configuration';
import { AntiBotGuardService } from './anti-bot-guard.service';
import { TrafficShaperService } from './traffic-shaper.service';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/** Recycle a pooled context after this many jobs so per-context heap/JS-listener growth can't accumulate indefinitely across a long-running worker. */
const MAX_USES_PER_CONTEXT = 100;

/** We only ever read src/data-src *attributes* off img/video tags, never pixel data — safe to abort these outright rather than just cache them. */
const BLOCKED_RESOURCE_TYPES = new Set(['image', 'media', 'font']);

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
      await pooled.context.clearCookies().catch(() => undefined);
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
      userAgent: USER_AGENT,
      viewport: { width: 1366, height: 900 },
      locale: 'en-IN',
    });

    if (this.blockNonEssentialResources) {
      // Set once per context (not per page/job) — Playwright applies a
      // context-level route to every page opened from it, including ones
      // created after this call, so pooled reuse keeps the same routing.
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
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
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
    const browser = await chromium.launch({
      headless: this.config.get('scraper.headless', { infer: true }),
    });
    browser.on('disconnected', () => this.logger.warn('Chromium process exited'));
    this.logger.log('Chromium launched');
    return browser;
  }
}
