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
    // obliterate() removes the queue's jobs in EVERY state — active,
    // waiting, completed, failed, delayed, paused — unlike drain()/clean(),
    // which only ever touched waiting/delayed/failed and left active and
    // completed jobs behind. force:true is required because it also
    // bypasses the "no active jobs" guard; stop the worker process first if
    // you want a clean stop rather than yanking jobs mid-processing.
    await q.obliterate({ force: true });
    console.log(`[CleanUp] Obliterated queue (all states: active/waiting/completed/failed/delayed/paused): ${q.name}`);
    await q.close();
  }

  await redis.quit();
  console.log('[CleanUp] All queues and cooldowns cleared successfully!');
}

main().catch((err) => {
  console.error('Failed to clean queues:', err);
  process.exit(1);
});
