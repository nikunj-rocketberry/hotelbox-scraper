import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { QUEUE_CITY_HOTELS, QUEUE_HOTEL_DETAIL, CityHotelsJob, HotelDetailJob } from '../queue/queue.constants';
import { CityHotelsService } from './city-hotels.service';
import { HotelRepository } from '../ingestion/hotel.repository';
import { AppConfig } from '../config/configuration';

const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 5);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX ?? 20);
const RATE_LIMIT_DURATION_MS = Number(process.env.RATE_LIMIT_DURATION_MS ?? 60_000);

@Processor(QUEUE_CITY_HOTELS, {
  concurrency: CONCURRENCY,
  limiter: { max: RATE_LIMIT_MAX, duration: RATE_LIMIT_DURATION_MS },
})
export class CityHotelsProcessor extends WorkerHost {
  private readonly logger = new Logger(CityHotelsProcessor.name);
  private readonly freshnessDays: number;

  constructor(
    private readonly cityHotelsService: CityHotelsService,
    private readonly hotelRepository: HotelRepository,
    private readonly dataSource: DataSource,
    config: ConfigService<AppConfig, true>,
    @InjectQueue(QUEUE_HOTEL_DETAIL) private readonly hotelDetailQueue: Queue<HotelDetailJob>,
  ) {
    super();
    this.freshnessDays = config.get('scraper.rescrapeFreshnessDays', { infer: true });
  }

  async process(job: Job<CityHotelsJob>): Promise<void> {
    const { countryId, stateId, cityId, cityName, stateName, countryName } = job.data;
    const hotels = await this.cityHotelsService.listHotels({ cityName, stateName, countryName });

    // Caching: skip re-scraping (and re-navigating Playwright to) any hotel
    // we already have fresh data for, so a repeat crawl of the same
    // region/city spends its budget on hotels that actually need it.
    const freshIds = await this.hotelRepository.findFreshExpediaHotelIds(
      this.dataSource.manager,
      hotels.map((h) => h.expediaHotelId),
      this.freshnessDays,
    );
    const toScrape = hotels.filter((h) => !freshIds.has(h.expediaHotelId));

    for (const hotel of toScrape) {
      const jobId = `hotel-${hotel.expediaHotelId}`; // idempotent: same Expedia property never double-enqueued (BullMQ jobIds can't contain ':')
      await this.hotelDetailQueue.add(
        'scrape-hotel',
        { countryId, stateId, cityId, expediaHotelId: hotel.expediaHotelId, detailUrl: hotel.detailUrl },
        { jobId }, // attempts/backoff/retention come from the queue's defaultJobOptions (see queue.module.ts)
      );
    }

    this.logger.log(
      `Enqueued ${toScrape.length} hotel-detail jobs for ${cityName} (${freshIds.size} skipped as already fresh, ${hotels.length} found)`,
    );
  }
}
