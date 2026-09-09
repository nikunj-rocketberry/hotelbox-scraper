import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { QUEUE_CITY_HOTELS, QUEUE_HOTEL_DETAIL, QUEUE_REGION_DISCOVERY, RegionDiscoveryJob, CityHotelsJob, HotelDetailJob } from '../queue/queue.constants';
import { RegionDiscoveryService, DiscoveredCity } from './region-discovery.service';
import { HotelRepository } from '../ingestion/hotel.repository';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';

const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 5);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX ?? 20);
const RATE_LIMIT_DURATION_MS = Number(process.env.RATE_LIMIT_DURATION_MS ?? 60_000);

@Processor(QUEUE_REGION_DISCOVERY, {
  concurrency: CONCURRENCY,
  limiter: { max: RATE_LIMIT_MAX, duration: RATE_LIMIT_DURATION_MS },
})
export class RegionDiscoveryProcessor extends WorkerHost {
  private readonly logger = new Logger(RegionDiscoveryProcessor.name);
  private readonly freshnessDays: number;

  constructor(
    private readonly regionDiscoveryService: RegionDiscoveryService,
    private readonly hotelRepository: HotelRepository,
    private readonly dataSource: DataSource,
    config: ConfigService<AppConfig, true>,
    @InjectQueue(QUEUE_CITY_HOTELS) private readonly cityHotelsQueue: Queue<CityHotelsJob>,
    @InjectQueue(QUEUE_HOTEL_DETAIL) private readonly hotelDetailQueue: Queue<HotelDetailJob>,
  ) {
    super();
    this.freshnessDays = config.get('scraper.rescrapeFreshnessDays', { infer: true });
  }

  async process(job: Job<RegionDiscoveryJob>): Promise<void> {
    const { countryId, countryName, stateId, stateName } = job.data;
    const { cities, hotels } = await this.regionDiscoveryService.discoverCities({ countryId, countryName, stateId, stateName });

    for (const city of cities) {
      const jobId = `city-${city.cityId}`; // idempotent: re-running region-discovery won't double-enqueue a city (BullMQ jobIds can't contain ':')
      await this.cityHotelsQueue.add(
        'list-hotels',
        {
          countryId,
          stateId,
          cityId: city.cityId,
          cityName: city.cityName,
          stateName,
          countryName,
        },
        { jobId },
      );
    }

    this.logger.log(`Enqueued ${cities.length} city-hotels jobs for ${stateName}`);

    if (hotels.length > 0) {
      await this.enqueueStateSweepHotels(countryId, stateId, cities, hotels);
    }
  }

  /**
   * States with no "Destinations in <State>" module (e.g. Karnataka) hand
   * back hotels harvested directly from the state-wide sweep alongside the
   * cities mined from those same cards — enqueue those straight into
   * hotel-detail rather than waiting on the per-city searches above to
   * re-discover them. Every hotel-detail job uses the same
   * `hotel-${expediaHotelId}` BullMQ jobId as city-hotels.processor.ts, so a
   * hotel that both this sweep AND a later per-city search turn up is only
   * ever enqueued once — BullMQ no-ops the duplicate add.
   */
  private async enqueueStateSweepHotels(
    countryId: string,
    stateId: string,
    cities: DiscoveredCity[],
    hotels: { expediaHotelId: string; detailUrl: string; locality?: string }[],
  ): Promise<void> {
    const cityIdByLowerName = new Map(cities.map((c) => [c.cityName.toLowerCase(), c.cityId]));

    const freshIds = await this.hotelRepository.findFreshExpediaHotelIds(
      this.dataSource.manager,
      hotels.map((h) => h.expediaHotelId),
      this.freshnessDays,
    );
    const toScrape = hotels.filter((h) => !freshIds.has(h.expediaHotelId));

    for (const hotel of toScrape) {
      const cityId = hotel.locality ? cityIdByLowerName.get(hotel.locality.toLowerCase()) : undefined;
      const jobId = `hotel-${hotel.expediaHotelId}`;
      await this.hotelDetailQueue.add(
        'scrape-hotel',
        { countryId, stateId, cityId, expediaHotelId: hotel.expediaHotelId, detailUrl: hotel.detailUrl },
        { jobId },
      );
    }

    this.logger.log(`Enqueued ${toScrape.length} hotel-detail jobs directly from the state-wide sweep (${freshIds.size} skipped as already fresh, ${hotels.length} harvested)`);
  }
}
