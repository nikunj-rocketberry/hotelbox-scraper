import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Page } from 'playwright';
import { AppConfig } from '../config/configuration';
import { BrowserService } from './browser.service';
import { buildHotelSearchUrl } from './search-url.util';
import { ExpediaSelectors } from './expedia-selectors';
import { GeoRepository } from '../ingestion/geo.repository';
import { DataSource } from 'typeorm';

export interface DiscoveredCity {
  cityId: string;
  cityName: string;
}

/**
 * Stage 1 of the pipeline: given a state, find every city Expedia surfaces
 * under that state's "Destinations in <State>" recommendation module
 * (across all category tabs: Family, Romance, Relaxation, Nature, Culture),
 * and upsert each into master_city.
 */
@Injectable()
export class RegionDiscoveryService {
  private readonly logger = new Logger(RegionDiscoveryService.name);

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly browser: BrowserService,
    private readonly geoRepository: GeoRepository,
    private readonly dataSource: DataSource,
  ) {}

  async discoverCities(params: { countryId: string; countryName: string; stateId: string; stateName: string }): Promise<DiscoveredCity[]> {
    const destination = `${params.stateName}, ${params.countryName}`;
    const url = buildHotelSearchUrl(this.config.get('scraper.expediaBaseUrl', { infer: true }), destination, this.config.get('scraper.searchStayNights', { infer: true }));

    const cityNames = await this.browser.withContext((context) => this.scrapeCityNames(context.newPage(), url));

    const seen = new Set<string>();
    const results: DiscoveredCity[] = [];
    for (const name of cityNames) {
      const normalized = name.trim();
      if (!normalized || seen.has(normalized.toLowerCase())) continue;
      seen.add(normalized.toLowerCase());

      const cityId = await this.dataSource.transaction((manager) =>
        this.geoRepository.upsertCity(manager, {
          countryId: params.countryId,
          stateId: params.stateId,
          name: normalized,
        }),
      );
      results.push({ cityId, cityName: normalized });
    }

    this.logger.log(`Discovered ${results.length} cities in ${params.stateName}`);
    return results;
  }

  private async scrapeCityNames(pagePromise: Promise<Page>, url: string): Promise<string[]> {
    const page = await pagePromise;
    const names = new Set<string>();

    try {
      await this.browser.safeGoto(page, url);
      await page.waitForSelector(ExpediaSelectors.search.destinationsSection, { timeout: 15_000 }).catch(() => {
        this.logger.warn(`No "Destinations in..." section found for ${url} — selector likely needs updating (see expedia-selectors.ts)`);
      });

      const tabs = await page.$$(ExpediaSelectors.search.destinationCategoryTabs);
      const tabCount = Math.max(tabs.length, 1);

      for (let i = 0; i < tabCount; i++) {
        if (tabs[i]) {
          await tabs[i].click().catch(() => undefined);
          await page.waitForTimeout(800); // let the tab's panel content swap in
        }

        const cards = await page.$$(ExpediaSelectors.search.destinationCityCard);
        for (const card of cards) {
          const nameEl = await card.$(ExpediaSelectors.search.destinationCityName);
          const text = (await (nameEl ?? card).innerText().catch(() => '')).trim();
          if (text) names.add(text);
        }
      }
    } finally {
      await page.close();
    }

    return [...names];
  }
}
