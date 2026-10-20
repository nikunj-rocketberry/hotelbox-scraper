import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { IngestionModule } from './ingestion.module';
import { IngestionProcessor } from './ingestion.processor';

/**
 * Just the BullMQ consumer for the hotel-ingest queue, split out from
 * IngestionModule (which only provides the repositories/services that the
 * scraper process also needs) so that "who runs the ingestion worker" is a
 * deployment choice:
 *
 *  - Imported by WorkerModule  -> ingestion runs inside the scraper process
 *    (the default, unchanged behaviour).
 *  - Imported by IngestWorkerModule (ingest.main.ts) -> ingestion runs as its
 *    own OS process, so a Playwright/Chromium crash in the scraper can't take
 *    the ingest pipeline down with it and the queue keeps draining.
 *
 * Import it in exactly one of the two per deployment — two importers means two
 * consumers on the same queue. That's not incorrect (BullMQ hands each job to a
 * single consumer) but it silently doubles the effective ingest concurrency.
 */
@Module({
  imports: [QueueModule, IngestionModule],
  providers: [IngestionProcessor],
})
export class IngestionWorkerModule {}
