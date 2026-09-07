import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IngestionService } from './ingestion.service';
import { HotelBatchItem } from './hotel.repository';
import { AppConfig } from '../config/configuration';

interface PendingItem {
  item: HotelBatchItem;
  resolve: (hotelId: string) => void;
  reject: (err: unknown) => void;
}

/**
 * Micro-batches scraped hotels across whatever hotel-detail jobs are running
 * concurrently (WORKER_CONCURRENCY of them), flushing as one batch SQL write
 * instead of one write per hotel. Flushes on whichever comes first: the
 * batch reaching INGEST_BATCH_SIZE, or INGEST_BATCH_MAX_WAIT_MS elapsing
 * since the first item in the current batch was enqueued.
 *
 * Each caller's `enqueue()` promise resolves only once its hotel is actually
 * committed — never early. That matters for BullMQ correctness: a job must
 * not report success until its data is durable, or a crash between "job
 * marked complete" and "batch flushed" would silently lose that hotel.
 */
@Injectable()
export class BatchIngestionService implements OnModuleDestroy {
  private readonly logger = new Logger(BatchIngestionService.name);
  private readonly batchSize: number;
  private readonly maxWaitMs: number;

  private pending: PendingItem[] = [];
  private flushTimer?: NodeJS.Timeout;
  private flushing: Promise<void> = Promise.resolve();

  constructor(
    private readonly ingestionService: IngestionService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.batchSize = config.get('ingest.batchSize', { infer: true });
    this.maxWaitMs = config.get('ingest.maxWaitMs', { infer: true });
  }

  async enqueue(item: HotelBatchItem): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.pending.push({ item, resolve, reject });

      if (this.pending.length >= this.batchSize) {
        this.triggerFlush();
      } else if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => this.triggerFlush(), this.maxWaitMs);
      }
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.triggerFlush();
    await this.flushing;
  }

  /** Chains onto any in-flight flush so a size-triggered and timer-triggered flush can never race each other. */
  private triggerFlush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.pending.length === 0) return;

    const batch = this.pending;
    this.pending = [];
    this.flushing = this.flushing.then(() => this.flush(batch));
  }

  private async flush(batch: PendingItem[]): Promise<void> {
    try {
      const hotelIds = await this.ingestionService.saveHotelsBatch(batch.map((p) => p.item));
      batch.forEach((p, i) => p.resolve(hotelIds[i]));
      this.logger.log(`Flushed batch of ${batch.length} hotels`);
    } catch (err) {
      this.logger.error(`Batch flush failed for ${batch.length} hotels, retrying one-by-one: ${(err as Error).message}`);
      await this.flushIndividually(batch);
    }
  }

  /**
   * One bad row (a constraint violation from unexpected scraped data, say)
   * shouldn't force every other hotel in the batch to fail and re-scrape.
   * Falls back to single-item batches so only the actual offender fails.
   */
  private async flushIndividually(batch: PendingItem[]): Promise<void> {
    for (const p of batch) {
      try {
        const [hotelId] = await this.ingestionService.saveHotelsBatch([p.item]);
        p.resolve(hotelId);
      } catch (err) {
        p.reject(err);
      }
    }
  }
}
