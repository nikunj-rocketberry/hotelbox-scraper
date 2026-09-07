import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { AppConfig } from '../config/configuration';

const BUCKET_KEY = 'expedia:traffic-shaper:bucket';

/**
 * Atomic refill-and-take, so N workers hitting this at once never race each
 * other into over-drawing the bucket (a plain GET-then-SET from Node would).
 * KEYS[1] = bucket hash key. ARGV = capacity, refillPerMs, now(ms).
 * Returns {allowed (0|1), waitMs (0 if allowed, else caller's estimated wait)}.
 */
const TAKE_TOKEN_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillPerMs = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then
  tokens = capacity
  ts = now
end

local elapsed = now - ts
if elapsed > 0 then
  tokens = math.min(capacity, tokens + elapsed * refillPerMs)
end

local allowed = 0
local waitMs = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  waitMs = math.ceil((1 - tokens) / refillPerMs)
end

redis.call('HMSET', key, 'tokens', tostring(tokens), 'ts', tostring(now))
redis.call('PEXPIRE', key, 3600000)

return {allowed, waitMs}
`;

/**
 * Fleet-wide token bucket: one Redis-backed bucket shared by every worker
 * process, so "N requests/hour" is an actual aggregate cap across the whole
 * fleet, not a per-process one that multiplies out when you scale workers.
 *
 * Token bucket rather than leaky bucket: we want a small, bounded burst
 * allowance (`burstCapacity` tokens banked up front, e.g. so a city with a
 * long hotel list doesn't stall) while the refill rate (derived from
 * `ratePerHour`) still pins the long-run average — a leaky bucket would need
 * to model an actual draining queue in Redis for the same practical effect.
 *
 * This supersedes BullMQ's own `limiter` as the precise pacing mechanism:
 * BullMQ's window limiter can legally release its whole `max` count in one
 * instant when a window resets, which is exactly the synchronized-burst
 * pattern this is meant to prevent. Leave BullMQ's limiter in place as a
 * coarse backstop; this is the actual shaping.
 */
@Injectable()
export class TrafficShaperService implements OnModuleDestroy {
  private readonly logger = new Logger(TrafficShaperService.name);
  private readonly redis: Redis;
  private readonly enabled: boolean;
  private readonly capacity: number;
  private readonly refillPerMs: number;

  constructor(config: ConfigService<AppConfig, true>) {
    this.enabled = config.get('scraper.trafficShaper.enabled', { infer: true });
    this.capacity = config.get('scraper.trafficShaper.burstCapacity', { infer: true });
    const ratePerHour = config.get('scraper.trafficShaper.ratePerHour', { infer: true });
    this.refillPerMs = ratePerHour / 3_600_000;

    this.redis = new Redis({
      host: config.get('redis.host', { infer: true }),
      port: config.get('redis.port', { infer: true }),
      maxRetriesPerRequest: null,
    });

    if (this.enabled) {
      this.logger.log(`Traffic shaper active: ${ratePerHour}/hr sustained, burst capacity ${this.capacity}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }

  /** Resolves once a token is available. Blocks and retries rather than rejecting — callers should wait their turn, not fail the job. */
  async acquire(): Promise<void> {
    if (!this.enabled) return;

    for (;;) {
      const now = Date.now();
      const [allowed, waitMs] = (await this.redis.eval(
        TAKE_TOKEN_SCRIPT,
        1,
        BUCKET_KEY,
        this.capacity,
        this.refillPerMs,
        now,
      )) as [number, number];

      if (allowed === 1) return;

      // Jitter on top of the bucket's own estimate so every job that computed
      // the same wait (they often will — same deficit, same rate) doesn't
      // retry on the exact same tick and recreate the burst we're preventing.
      const sleepMs = Math.max(10, waitMs) + Math.random() * 100;
      await new Promise((resolve) => setTimeout(resolve, sleepMs));
    }
  }
}
