import 'reflect-metadata';
import * as dotenv from 'dotenv';
dotenv.config(); // must run before any module import below — @Processor() decorators read process.env at import time, not via ConfigService

import { NestFactory } from '@nestjs/core';
import { IngestWorkerModule } from './ingest-worker.module';

/**
 * No HTTP server and no browser — this process just holds the ingestion
 * BullMQ Worker alive. Pair it with a scraper process started with
 * RUN_INGESTION_IN_SCRAPER=false.
 */
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(IngestWorkerModule);
  app.enableShutdownHooks(); // SIGTERM/SIGINT -> OnModuleDestroy -> BatchIngestionService flushes what's pending
  // eslint-disable-next-line no-console
  console.log(`Ingestion worker started (pid=${process.pid}), concurrency=${process.env.INGEST_WORKER_CONCURRENCY ?? 20}`);
}

bootstrap();
