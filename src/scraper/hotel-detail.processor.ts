import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Queue } from 'bullmq';
import { QUEUE_HOTEL_DETAIL, QUEUE_HOTEL_INGEST, HotelDetailJob, HotelIngestJob } from '../queue/queue.constants';
import { HotelDetailService, UNKNOWN_HOTEL_NAME } from './hotel-detail.service';
import { AppConfig } from '../config/configuration';

const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 5);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX ?? 20);
const RATE_LIMIT_DURATION_MS = Number(process.env.RATE_LIMIT_DURATION_MS ?? 60_000);

@Processor(QUEUE_HOTEL_DETAIL, {
  concurrency: CONCURRENCY,
  limiter: { max: RATE_LIMIT_MAX, duration: RATE_LIMIT_DURATION_MS },
})
export class HotelDetailProcessor extends WorkerHost {
  private readonly logger = new Logger(HotelDetailProcessor.name);
  private readonly backpressureThreshold: number;

  constructor(
    private readonly hotelDetailService: HotelDetailService,
    @InjectQueue(QUEUE_HOTEL_INGEST) private readonly ingestQueue: Queue<HotelIngestJob>,
    config: ConfigService<AppConfig, true>,
  ) {
    super();
    this.backpressureThreshold = config.get('ingest.backpressureThreshold', { infer: true });
  }

  /**
   * Scraping stays one-hotel-per-job (Playwright is inherently per-page), but
   * ingestion (image upload + DB write) is now a SEPARATE durable queue —
   * see ingestion.processor.ts. This job completes — freeing its Playwright
   * context — the moment the scraped hotel is durably queued for ingestion
   * (a Redis write, milliseconds), not once it's actually persisted to
   * Postgres/MinIO. That's still safe: if this process crashes before the
   * ingest job is durably added, this scraper job never completes either and
   * BullMQ retries the whole scrape; if it crashes after, the ingest job
   * survives in Redis independent of this job's own outcome. Either way nothing
   * is silently lost — see ingestion.service.ts's idempotent upserts for why a
   * duplicate re-scrape/re-ingest of the same hotel is always safe, never corruption.
   */
  async process(job: Job<HotelDetailJob>): Promise<void> {
    const { countryId, stateId, cityId, expediaHotelId, detailUrl } = job.data;

    await this.waitForIngestCapacity();

    const scraped = await this.hotelDetailService.scrapeHotel(expediaHotelId, detailUrl);

    // Quality gate. A scrape that couldn't resolve a name from the title
    // selector, a bare <h1>, OR JSON-LD didn't find a nameless hotel — it got a
    // page that never rendered. Ingesting it would write an empty row AND stamp
    // last_synced_at = now(), which makes findFreshExpediaHotelIds() treat the
    // junk as fresh and skip re-scraping this hotel for RESCRAPE_FRESHNESS_DAYS.
    // Failing here instead lets BullMQ retry it with backoff, and (if every
    // attempt fails) parks it in the failed set where it's visible.
    // Deliberately keyed on the name only: a real hotel legitimately can have
    // zero rooms/photos, so those are NOT treated as scrape failures.
    if (scraped.name === UNKNOWN_HOTEL_NAME) {
      throw new Error(`Scrape produced no usable data for ${detailUrl} (no name from selector, h1 or JSON-LD) — not ingesting, will retry`);
    }

    await this.ingestQueue.add('ingest', { hotel: scraped, geo: { countryId, stateId, cityId } });

    this.logger.log(`Scraped ${scraped.name} (expedia id=${expediaHotelId}, ${scraped.rooms.length} rooms, ${scraped.media.length} hotel photos) — queued for ingestion`);
  }

  /**
   * Backpressure: if ingestion is falling behind (MinIO/DB latency, a burst
   * of large batches, ...), pause picking up new hotels rather than keep
   * scraping into an ever-growing ingest backlog — a browser scrape is much
   * more expensive to redo than a few seconds of an idle worker slot.
   */
  private async waitForIngestCapacity(): Promise<void> {
    if (this.backpressureThreshold <= 0) return;

    for (;;) {
      const depth = await this.ingestQueue.getWaitingCount();
      if (depth < this.backpressureThreshold) return;
      this.logger.warn(`Ingest queue backlog at ${depth} (>= ${this.backpressureThreshold}) — pausing new scrapes briefly`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}
