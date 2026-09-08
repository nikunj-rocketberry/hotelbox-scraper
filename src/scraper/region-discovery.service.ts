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
function isValidCityName(name: string): boolean {
  if (!name || name.length < 3 || name.length > 35) return false;
  if (/\d|₹|\$|€|£/.test(name)) return false;
  const blacklisted = [
    'marriott', 'hyatt', 'hilton', 'taj', 'radisson', 'oberoi', 'novotel',
    'hotel', 'motel', 'resort', 'inn', 'villa', 'apartment', 'hostel',
    'nightly', 'price', 'minimum', 'maximum', 'total', 'rating', 'star',
    'breakfast', 'pool', 'wifi', 'parking', 'pay later', 'reserve',
    'popular', 'neighborhood', 'city', 'filter', 'destination', 'e.g.',
    'explore', 'see all', 'distance', 'amenities', 'properties', 'stays',
    'free', 'cancellation', 'deals', 'special', 'member', 'guest',
  ];
  const lower = name.toLowerCase();
  if (blacklisted.some((word) => lower.includes(word))) return false;
  return /^[A-Za-z\s\-'.]+$/.test(name);
}

const STATE_FALLBACK_CITIES: Record<string, string[]> = {
  karnataka: ['Bengaluru', 'Mysuru', 'Mangaluru', 'Hampi', 'Coorg', 'Hubballi', 'Belagavi', 'Udupi', 'Chikkamagaluru', 'Gokarna'],
  gujarat: ['Ahmedabad', 'Surat', 'Vadodara', 'Rajkot', 'Gandhinagar', 'Dwarka', 'Gir Somnath', 'Bhuj'],
  rajasthan: ['Jaipur', 'Udaipur', 'Jodhpur', 'Jaisalmer', 'Pushkar', 'Bikaner', 'Mount Abu', 'Ajmer'],
  maharashtra: ['Mumbai', 'Pune', 'Nagpur', 'Nashik', 'Aurangabad', 'Mahabaleshwar', 'Lonavala', 'Shirdi'],
  kerala: ['Kochi', 'Thiruvananthapuram', 'Munnar', 'Alappuzha', 'Kozhikode', 'Wayanad', 'Varkala'],
  goa: ['Panaji', 'Calangute', 'Candolim', 'Baga', 'Anjuna', 'Margao'],
};

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

    const cityNames = await this.browser.withContext((context) => this.scrapeCityNames(context.newPage(), url, params.stateName));

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

    this.logger.log(`Discovered ${results.length} valid cities in ${params.stateName}: ${results.map((r) => r.cityName).join(', ')}`);
    return results;
  }

  private async scrapeCityNames(pagePromise: Promise<Page>, url: string, stateName: string): Promise<string[]> {
    const page = await pagePromise;
    const names = new Set<string>();

    try {
      await this.browser.safeGoto(page, url);

      // Strategy 1: "Destinations in <State>" section (present on Gujarat, Rajasthan)
      const section = await page
        .waitForSelector(ExpediaSelectors.search.destinationsSection, { timeout: 8_000 })
        .catch(() => null);

      if (section) {
        this.logger.log(`Found destinations section — extracting city cards...`);
        const tabs = await section.$$(ExpediaSelectors.search.destinationCategoryTabs).catch(() => []);
        const tabCount = Math.max(tabs.length, 1);

        for (let i = 0; i < tabCount; i++) {
          if (tabs[i]) {
            await tabs[i].click().catch(() => undefined);
            await page.waitForTimeout(600);
          }

          const cards = await section.$$(ExpediaSelectors.search.destinationCityCard);
          for (const card of cards) {
            const nameEl = await card.$(ExpediaSelectors.search.destinationCityName).catch(() => null);
            let text = (await (nameEl ?? card).innerText().catch(() => '')).trim();
            text = text.split('\n')[0].replace(/hotels?|properties|destinations?/gi, '').trim();
            if (isValidCityName(text)) {
              names.add(text);
            }
          }
        }
      }

      // Strategy 2: If Strategy 1 found no cities, check specific Neighborhood / City filter legends
      if (names.size === 0) {
        this.logger.log(`Checking sidebar Neighborhood/Location filters...`);
        const filterLabels = await page
          .$$eval(
            'fieldset:has(legend:has-text("Neighborhood")) label, fieldset:has(legend:has-text("Popular locations")) label, fieldset:has(legend:has-text("City")) label',
            (labels) => labels.map((el) => el.textContent?.trim() || '').filter(Boolean),
          )
          .catch(() => []);

        for (const raw of filterLabels) {
          const cleaned = raw.replace(/\(\d+[\d,]*\)/g, '').trim();
          if (isValidCityName(cleaned)) {
            names.add(cleaned);
          }
        }
      }

      // Strategy 3: Extract locality/city directly from hotel cards (e.g. "Sakleshpur", "Horur")
      if (names.size === 0) {
        this.logger.log(`Extracting cities from rendered hotel listing cards...`);
        await page.evaluate(() => window.scrollBy(0, 1000)).catch(() => undefined);
        await page.waitForTimeout(800);

        const cardLocations = await page
          .$$eval(
            '[data-stid="lodging-card-responsive"], [data-stid="property-listing-results"] > div',
            (cards) => {
              return cards
                .map((card) => {
                  const titleEl = card.querySelector('[data-stid="content-hotel-title"], h3, h4');
                  if (!titleEl) return '';
                  const nextEl = titleEl.nextElementSibling;
                  const raw = nextEl?.textContent?.trim() || '';
                  return raw.split('\n')[0].split(',')[0].replace(/•.*/, '').replace(/\(.*?\)/g, '').trim();
                })
                .filter(Boolean);
            },
          )
          .catch(() => []);

        for (const loc of cardLocations) {
          if (isValidCityName(loc)) {
            names.add(loc);
          }
        }
      }

      // Strategy 4: Supplement with curated major cities for this state
      const fallback = STATE_FALLBACK_CITIES[stateName.toLowerCase()];
      if (fallback) {
        fallback.forEach((c) => names.add(c));
      }

      this.logger.log(`Discovered ${names.size} valid cities: ${[...names].join(', ')}`);
    } finally {
      await page.close();
    }

    return [...names];
  }
}
