import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { Page } from 'playwright';
import { AppConfig } from '../config/configuration';

export class AntiBotBlockedError extends Error {
  constructor(remainingMs: number) {
    super(`Expedia anti-bot cooldown active for another ${Math.ceil(remainingMs / 1000)}s`);
    this.name = 'AntiBotBlockedError';
  }
}

const BLOCKED_UNTIL_KEY = 'expedia:anti-bot:blocked-until';

const BLOCK_SIGNALS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /captcha/i, reason: 'captcha' },
  { pattern: /robot check/i, reason: 'robot-check' },
  { pattern: /access denied/i, reason: 'access-denied' },
  { pattern: /too many requests/i, reason: 'rate-limited' },
  { pattern: /just a moment/i, reason: 'cloudflare-challenge' },
  { pattern: /unusual traffic/i, reason: 'unusual-traffic' },
  { pattern: /bot or not/i, reason: 'expedia-bot-challenge' },
  { pattern: /show us your human side/i, reason: 'expedia-bot-challenge' },
];

/**
 * A block from Expedia (429/403/CAPTCHA) means the shared IP is compromised
 * for EVERY worker, not just the job that hit it — so this is a Redis-backed
 * circuit breaker shared across the whole fleet, not a per-job retry. Once
 * tripped, every worker fails fast (no navigation attempted) until the
 * cooldown expires, instead of every concurrent job independently hammering
 * Expedia and getting itself blocked too.
 */
@Injectable()
export class AntiBotGuardService implements OnModuleDestroy {
  private readonly logger = new Logger(AntiBotGuardService.name);
  private readonly redis: Redis;
  private readonly cooldownMs: number;

  constructor(config: ConfigService<AppConfig, true>) {
    this.cooldownMs = config.get('antiBot.cooldownMs', { infer: true });
    this.redis = new Redis({
      host: config.get('redis.host', { infer: true }),
      port: config.get('redis.port', { infer: true }),
      maxRetriesPerRequest: null,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }

  async assertNotBlocked(): Promise<void> {
    const blockedUntil = Number((await this.redis.get(BLOCKED_UNTIL_KEY)) ?? 0);
    const remaining = blockedUntil - Date.now();
    if (remaining > 0) {
      throw new AntiBotBlockedError(remaining);
    }
  }

  async reportBlock(reason: string): Promise<void> {
    const until = Date.now() + this.cooldownMs;
    await this.redis.set(BLOCKED_UNTIL_KEY, until, 'PX', this.cooldownMs);
    this.logger.warn(`Anti-bot block detected (${reason}) — cooling down ALL workers for ${this.cooldownMs / 1000}s`);
  }

  async clearBlock(): Promise<void> {
    await this.redis.del(BLOCKED_UNTIL_KEY);
    this.logger.log('Active anti-bot cooldown cleared from Redis.');
  }

  /** Call after every page.goto() with the response status + page content. Returns the detected reason, or null if clean. Trips the fleet-wide cooldown on detection. */
  async checkPage(page: Page, responseStatus: number | undefined): Promise<string | null> {
    const reason = await this.detectBlockReason(page, responseStatus);
    return reason ? this.trip(reason) : null;
  }

  /**
   * Detection only — never touches the cooldown. Split out from checkPage() so
   * a manual-solve session can keep probing "is this page still challenged?"
   * while a human works on it, without each probe re-arming the very block it's
   * trying to clear.
   */
  async detectBlockReason(page: Page, responseStatus: number | undefined): Promise<string | null> {
    if (responseStatus === 429) return 'http-429';
    if (responseStatus === 403) return 'http-403';

    const [title, bodyText] = await Promise.all([
      page.title().catch(() => ''),
      page
        .locator('body')
        .innerText({ timeout: 2000 })
        .catch(() => ''),
    ]);
    const haystack = `${title} ${bodyText}`.slice(0, 2000);

    for (const { pattern, reason } of BLOCK_SIGNALS) {
      if (pattern.test(haystack)) return reason;
    }
    return null;
  }

  private async trip(reason: string): Promise<string> {
    await this.reportBlock(reason);
    return reason;
  }
}
