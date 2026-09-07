import { Body, Controller, Get, Post } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { QUEUE_CITY_HOTELS, QUEUE_HOTEL_DETAIL, QUEUE_REGION_DISCOVERY, RegionDiscoveryJob } from '../queue/queue.constants';
import { GeoRepository } from '../ingestion/geo.repository';

interface StartRegionScrapeDto {
  countryName: string;
  countryIso2: string;
  countryIso3: string;
  stateName: string;
}

@Controller('scrape')
export class TriggerController {
  constructor(
    @InjectQueue(QUEUE_REGION_DISCOVERY) private readonly regionQueue: Queue<RegionDiscoveryJob>,
    @InjectQueue(QUEUE_CITY_HOTELS) private readonly cityQueue: Queue,
    @InjectQueue(QUEUE_HOTEL_DETAIL) private readonly hotelQueue: Queue,
    private readonly geoRepository: GeoRepository,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Entry point for the whole pipeline: seed/get country+state, then enqueue
   * one region-discovery job. Everything downstream (cities, hotel lists,
   * hotel detail + ingest) is produced automatically by the workers.
   */
  @Post('region')
  async startRegionScrape(@Body() body: StartRegionScrapeDto) {
    return this.enqueueRegion(body);
  }

  /**
   * Batch version of `POST /region` — seeds every region in one call so
   * multiple destinations are in flight concurrently from the start. All
   * downstream queues are shared, so this is what actually keeps the
   * hotel-detail queue saturated for a sustained-throughput run instead of
   * draining to empty between single-region crawls.
   */
  @Post('regions')
  async startRegionScrapes(@Body() bodies: StartRegionScrapeDto[]) {
    return Promise.all(bodies.map((body) => this.enqueueRegion(body)));
  }

  private async enqueueRegion(body: StartRegionScrapeDto) {
    const { countryId, stateId } = await this.dataSource.transaction(async (manager) => {
      const countryId = await this.geoRepository.upsertCountry(manager, {
        name: body.countryName,
        iso2: body.countryIso2,
        iso3: body.countryIso3,
      });
      const stateId = await this.geoRepository.upsertState(manager, {
        countryId,
        name: body.stateName,
      });
      return { countryId, stateId };
    });

    const job = await this.regionQueue.add(
      'discover-cities',
      { countryId, countryName: body.countryName, countryIso2: body.countryIso2, stateId, stateName: body.stateName },
      { jobId: `region-${stateId}` },
    );

    return { jobId: job.id, countryId, stateId };
  }

  @Get('status')
  async status() {
    const [region, city, hotel] = await Promise.all([
      this.regionQueue.getJobCounts(),
      this.cityQueue.getJobCounts(),
      this.hotelQueue.getJobCounts(),
    ]);
    return { regionDiscovery: region, cityHotels: city, hotelDetail: hotel };
  }
}
