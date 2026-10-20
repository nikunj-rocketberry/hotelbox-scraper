import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_HOTEL_INGEST, HotelIngestJob } from '../queue/queue.constants';
import { BatchIngestionService } from './batch-ingestion.service';

// Read directly from process.env (not ConfigService) — @Processor's options are
// evaluated at class-definition time, before Nest's DI container exists yet.
// Same pattern as hotel-detail.processor.ts.
//
// Must be >= INGEST_BATCH_SIZE: BatchIngestionService's micro-batch only fills
// past its size trigger when enough ingest jobs are being processed (and
// therefore calling enqueue()) AT THE SAME TIME. A concurrency of 1 would
// process ingest jobs one at a time, so enqueue() would never see more than
// one pending item and every batch would flush via the slow timer at size 1.
const INGEST_CONCURRENCY = Number(process.env.INGEST_WORKER_CONCURRENCY ?? 20);

/**
 * Dedicated ingestion worker — decoupled from scraping. HotelDetailProcessor
 * hands off a finished scrape here (durably, via Redis) and moves straight on
 * to the next hotel; THIS worker absorbs the slow part (image upload to
 * MinIO + the DB write) without ever blocking a Playwright context.
 *
 * Still only reports a job complete once BatchIngestionService.enqueue()
 * resolves — i.e. once that hotel's batch is actually committed — so the
 * same "never acknowledge before durable" guarantee as before still holds,
 * just scoped to this queue instead of tying up scraper concurrency.
 */
@Processor(QUEUE_HOTEL_INGEST, { concurrency: INGEST_CONCURRENCY })
export class IngestionProcessor extends WorkerHost {
  private readonly logger = new Logger(IngestionProcessor.name);

  constructor(private readonly batchIngestionService: BatchIngestionService) {
    super();
  }

  async process(job: Job<HotelIngestJob>): Promise<void> {
    const hotelId = await this.batchIngestionService.enqueue(job.data);
    this.logger.log(`Ingested hotel ${job.data.hotel.name} (db id=${hotelId}, expedia id=${job.data.hotel.expediaHotelId})`);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<HotelIngestJob> | undefined, err: Error): void {
    this.logger.error(`Ingest job failed for ${job?.data?.hotel?.name ?? 'unknown hotel'} (attempt ${job?.attemptsMade}): ${err.message}`);
  }

  @OnWorkerEvent('stalled')
  onStalled(jobId: string): void {
    this.logger.warn(`Ingest job ${jobId} stalled — will be reprocessed`);
  }
}
