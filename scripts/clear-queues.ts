import * as dotenv from 'dotenv';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { QUEUE_CITY_HOTELS, QUEUE_HOTEL_DETAIL, QUEUE_REGION_DISCOVERY } from '../src/queue/queue.constants';

dotenv.config();

const BLOCKED_UNTIL_KEY = 'expedia:anti-bot:blocked-until';

async function main() {
  const connection = {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
  };

  const redis = new Redis(connection);
  await redis.del(BLOCKED_UNTIL_KEY);
  console.log('[CleanUp] Reset anti-bot cooldown lock in Redis.');

  const queues = [
    new Queue(QUEUE_REGION_DISCOVERY, { connection }),
    new Queue(QUEUE_CITY_HOTELS, { connection }),
    new Queue(QUEUE_HOTEL_DETAIL, { connection }),
  ];

  for (const q of queues) {
    await q.drain();
    await q.clean(0, 1000, 'failed');
    await q.clean(0, 1000, 'wait');
    await q.clean(0, 1000, 'delayed');
    console.log(`[CleanUp] Cleared queue: ${q.name}`);
    await q.close();
  }

  await redis.quit();
  console.log('[CleanUp] All queues and cooldowns cleared successfully!');
}

main().catch((err) => {
  console.error('Failed to clean queues:', err);
  process.exit(1);
});
