import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_HOTEL_DETAIL, HotelDetailJob } from '../queue/queue.constants';
import { HotelDetailService } from './hotel-detail.service';
import { BatchIngestionService } from '../ingestion/batch-ingestion.service';

const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 5);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX ?? 20);
const RATE_LIMIT_DURATION_MS = Number(process.env.RATE_LIMIT_DURATION_MS ?? 60_000);

@Processor(QUEUE_HOTEL_DETAIL, {
  concurrency: CONCURRENCY,
  limiter: { max: RATE_LIMIT_MAX, duration: RATE_LIMIT_DURATION_MS },
})
export class HotelDetailProcessor extends WorkerHost {
  private readonly logger = new Logger(HotelDetailProcessor.name);

  constructor(
    private readonly hotelDetailService: HotelDetailService,
    private readonly batchIngestionService: BatchIngestionService,
  ) {
    super();
  }

  /**
   * Scraping stays one-hotel-per-job (Playwright is inherently per-page), but
   * the DB write does not: `enqueue()` hands this hotel to the batch ingestor
   * shared by every concurrent job on this worker, and only resolves once
   * that hotel's batch has actually been committed — so job success here
   * still means "durably saved", even though the SQL round trip it rode in
   * on covered several other hotels too.
   */
  async process(job: Job<HotelDetailJob>): Promise<void> {
    const { countryId, stateId, cityId, expediaHotelId, detailUrl } = job.data;

    const scraped = await this.hotelDetailService.scrapeHotel(expediaHotelId, detailUrl);
    const hotelId = await this.batchIngestionService.enqueue({ hotel: scraped, geo: { countryId, stateId, cityId } });

    this.logger.log(`Saved hotel ${scraped.name} (db id=${hotelId}, expedia id=${expediaHotelId}, ${scraped.rooms.length} rooms, ${scraped.media.length} hotel photos)`);
  }
}
