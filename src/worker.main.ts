import 'reflect-metadata';
import * as dotenv from 'dotenv';
dotenv.config(); // must run before any module import below — @Processor() decorators read process.env at import time, not via ConfigService

import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

/**
 * No HTTP server — this process just holds BullMQ Workers alive. Run as many
 * copies of `node dist/worker.main.js` as you want parallel scraping capacity.
 */
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks(); // SIGTERM/SIGINT -> OnModuleDestroy -> BrowserService closes Chromium cleanly
  // eslint-disable-next-line no-console
  console.log(`Worker started (pid=${process.pid}), concurrency=${process.env.WORKER_CONCURRENCY ?? 5} per queue`);
}

bootstrap();
