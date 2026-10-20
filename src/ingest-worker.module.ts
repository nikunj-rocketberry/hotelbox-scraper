import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { DatabaseModule } from './database/database.module';
import { IngestionWorkerModule } from './ingestion/ingestion-worker.module';

/**
 * Ingestion-only process: drains the hotel-ingest queue (image upload to
 * MinIO + batched Postgres writes) with no Playwright/Chromium anywhere in it.
 *
 * Run this alongside a scraper started with RUN_INGESTION_IN_SCRAPER=false, so
 * the two failure domains are separate: a browser OOM/crash kills scraping but
 * ingestion keeps committing everything already queued, and neither process's
 * memory pressure is the other's problem.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    DatabaseModule,
    IngestionWorkerModule,
  ],
})
export class IngestWorkerModule {}
