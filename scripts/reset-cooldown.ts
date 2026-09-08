import * as dotenv from 'dotenv';
import Redis from 'ioredis';

dotenv.config();

const BLOCKED_UNTIL_KEY = 'expedia:anti-bot:blocked-until';

async function main() {
  const redis = new Redis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
  });

  const remaining = await redis.get(BLOCKED_UNTIL_KEY);
  if (remaining) {
    const diff = Number(remaining) - Date.now();
    await redis.del(BLOCKED_UNTIL_KEY);
    console.log(`[AntiBotGuard] Cleared active anti-bot cooldown (${Math.ceil(diff / 1000)}s was remaining).`);
  } else {
    console.log('[AntiBotGuard] No active anti-bot cooldown found in Redis.');
  }

  await redis.quit();
}

main().catch((err) => {
  console.error('Failed to clear cooldown:', err);
  process.exit(1);
});
