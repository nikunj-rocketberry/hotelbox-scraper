import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { QUEUE_CITY_HOTELS, QUEUE_REGION_DISCOVERY, RegionDiscoveryJob, CityHotelsJob } from '../queue/queue.constants';
import { RegionDiscoveryService } from './region-discovery.service';

const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 5);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX ?? 20);
const RATE_LIMIT_DURATION_MS = Number(process.env.RATE_LIMIT_DURATION_MS ?? 60_000);

@Processor(QUEUE_REGION_DISCOVERY, {
  concurrency: CONCURRENCY,
  limiter: { max: RATE_LIMIT_MAX, duration: RATE_LIMIT_DURATION_MS },
})
export class RegionDiscoveryProcessor extends WorkerHost {
  private readonly logger = new Logger(RegionDiscoveryProcessor.name);

  constructor(
    private readonly regionDiscoveryService: RegionDiscoveryService,
    @InjectQueue(QUEUE_CITY_HOTELS) private readonly cityHotelsQueue: Queue<CityHotelsJob>,
  ) {
    super();
  }

  async process(job: Job<RegionDiscoveryJob>): Promise<void> {
    const { countryId, countryName, stateId, stateName } = job.data;
    const cities = await this.regionDiscoveryService.discoverCities({ countryId, countryName, stateId, stateName });

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
  }
}
