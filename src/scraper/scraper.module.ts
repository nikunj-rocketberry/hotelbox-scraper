import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { IngestionModule } from '../ingestion/ingestion.module';
import { BrowserService } from './browser.service';
import { AntiBotGuardService } from './anti-bot-guard.service';
import { TrafficShaperService } from './traffic-shaper.service';
import { RegionDiscoveryService } from './region-discovery.service';
import { CityHotelsService } from './city-hotels.service';
import { HotelDetailService } from './hotel-detail.service';
import { RegionDiscoveryProcessor } from './region-discovery.processor';
import { CityHotelsProcessor } from './city-hotels.processor';
import { HotelDetailProcessor } from './hotel-detail.processor';

/**
 * The full scrape pipeline: services + BullMQ processors. Import this only
 * in the worker bootstrap (worker.module.ts) — the API process should only
 * enqueue jobs (via QueueModule), never run Playwright itself.
 */
@Module({
  imports: [QueueModule, IngestionModule],
  providers: [
    BrowserService,
    AntiBotGuardService,
    TrafficShaperService,
    RegionDiscoveryService,
    CityHotelsService,
    HotelDetailService,
    RegionDiscoveryProcessor,
    CityHotelsProcessor,
    HotelDetailProcessor,
  ],
})
export class ScraperModule {}
