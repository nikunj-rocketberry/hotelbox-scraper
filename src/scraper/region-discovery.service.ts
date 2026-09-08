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

      // Strategy 1: "Destinations in <State>" section. Confirmed live (2026-09-08)
      // to be present on some states and entirely absent on others (Karnataka),
      // and that presence isn't predictable up front — so this always attempts
      // it, and Strategy 3 below always ALSO runs rather than being gated on
      // "strategy 1 found nothing": both are cheap, independent signals, and a
      // state where the destinations module exists but is sparse still
      // benefits from the union rather than stopping at whichever ran first.
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
        this.logger.log(`Destinations section yielded ${names.size} valid cities so far.`);
      } else {
        this.logger.log(`No destinations section for ${stateName} — relying on Strategy 3 + curated fallback.`);
      }

      // Strategy 2 used to scrape the sidebar's "Popular locations"/"Neighborhood"
      // filter as a city list. Verified live on 2026-09-08 (see expedia-selectors.ts
      // header): that filter now only surfaces landmarks/neighbourhoods ("M.G.
      // Road", "Bandipur National Park"), never city names — matching it would
      // silently write landmarks into master_city, so it was removed rather than
      // "fixed".

      // Strategy 3: Extract locality/city directly from hotel cards (e.g.
      // "Sakleshpur", "Horur") — this is the only strategy that doesn't depend
      // on a "destinations" module existing at all, so it's the real backbone
      // of discovery for states without one. Click "Show more" a few rounds
      // first so the sample spans more of the state than just the first
      // screenful of results (more cards -> more distinct localities).
      this.logger.log(`Extracting cities from rendered hotel listing cards...`);
      for (let round = 0; round < 4; round++) {
        const showMore = await page.$(ExpediaSelectors.hotelList.showMoreButton);
        if (!showMore) break;
        const countBefore = await page.$$eval(ExpediaSelectors.hotelList.resultCard, (els) => els.length).catch(() => 0);
        await showMore.click().catch(() => undefined);
        await page
          .waitForFunction(
            ({ selector, countBefore }) => document.querySelectorAll(selector).length > countBefore,
            { selector: ExpediaSelectors.hotelList.resultCard, countBefore },
            { timeout: 10_000 },
          )
          .catch(() => undefined);
        await page.waitForTimeout(500);
      }
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
                // Primary signal: the text node structurally right after the
                // title (usually the locality). If that's empty — a layout
                // variant where the title's own wrapper holds both — fall
                // back to the title's parent's second line of text instead
                // of giving up on the card entirely.
                const nextEl = titleEl.nextElementSibling;
                let raw = nextEl?.textContent?.trim() || '';
                if (!raw) {
                  const parentLines = (titleEl.parentElement?.textContent || '').split('\n').map((l) => l.trim()).filter(Boolean);
                  raw = parentLines[1] || '';
                }
                return raw.split('\n')[0].split(',')[0].replace(/•.*/, '').replace(/\(.*?\)/g, '').trim();
              })
              .filter(Boolean);
          },
        )
        .catch(() => []);

      const beforeStrategy3 = names.size;
      for (const loc of cardLocations) {
        if (isValidCityName(loc)) {
          names.add(loc);
        }
      }
      this.logger.log(`Hotel-card extraction added ${names.size - beforeStrategy3} more valid cities (from ${cardLocations.length} candidate cards).`);

      const organicCount = names.size;

      // Strategy 4: Supplement with curated major cities for this state
      const fallback = STATE_FALLBACK_CITIES[stateName.toLowerCase()];
      if (fallback) {
        fallback.forEach((c) => names.add(c));
      }

      if (organicCount === 0) {
        this.logger.warn(
          fallback
            ? `No cities discovered live for ${stateName} — every result comes from the curated fallback list. Coverage may be incomplete.`
            : `No cities discovered live for ${stateName} and no curated fallback exists for it — 0 cities found. Add an entry to STATE_FALLBACK_CITIES or investigate why both live strategies came back empty.`,
        );
      }

      this.logger.log(`Discovered ${names.size} valid cities (${organicCount} live, ${names.size - organicCount} curated): ${[...names].join(', ')}`);
    } finally {
      await page.close();
    }

    return [...names];
  }
}
