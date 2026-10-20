import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { DatabaseModule } from './database/database.module';
import { ScraperModule } from './scraper/scraper.module';
import { IngestionWorkerModule } from './ingestion/ingestion-worker.module';

// Read at import time (dotenv runs first in worker.main.ts), same as the
// @Processor concurrency options. Defaults to true so the standard
// `npm run start:worker` keeps running scraping AND ingestion in one process
// exactly as before. Set it to false and run `npm run start:ingest` alongside
// to isolate them — then a Chromium crash can't take ingestion down with it.
const RUN_INGESTION_IN_SCRAPER = (process.env.RUN_INGESTION_IN_SCRAPER ?? 'true').toLowerCase() !== 'false';

/**
 * Worker process: runs the Playwright-backed BullMQ processors. This is what
 * you scale horizontally — run N copies (separate OS processes / containers)
 * to increase parallel scraping capacity; each copy also runs WORKER_CONCURRENCY
 * concurrent jobs internally (see .env.example).
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    DatabaseModule,
    ScraperModule,
    ...(RUN_INGESTION_IN_SCRAPER ? [IngestionWorkerModule] : []),
  ],
})
export class WorkerModule {}
