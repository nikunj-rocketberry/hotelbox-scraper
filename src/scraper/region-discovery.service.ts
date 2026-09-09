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

/** A hotel harvested directly from a state-wide search sweep (states with no "Destinations in <State>" module — see discoverCities()). */
export interface DiscoveredStateHotel {
  expediaHotelId: string;
  detailUrl: string;
  name: string;
  /** Best-effort locality mined from the hotel-detail URL slug — used to attach a cityId when it matches a discovered city. */
  locality?: string;
}

/** Expedia property URLs embed the property id as `.h<digits>.` — e.g. `...h1234567.Hotel-Information` */
function extractHotelId(href: string): string | null {
  const match = href.match(/\.h(\d+)\./);
  return match ? match[1] : null;
}

/**
 * Expedia hotel-detail URL slugs always start with the locality name, e.g.
 * `/Bengaluru-Hotels-Holiday-Inn-...`, `/Somvarpet-Hotels-Timbertales-...`.
 * This is far more reliable than mining locality text out of the rendered
 * card (see expedia-selectors.ts header) — verified live on 2026-09-08
 * across an 18-card Karnataka listing with zero misses.
 */
function extractLocalityFromHref(href: string): string | undefined {
  const path = href.split('?')[0];
  const match = path.match(/^\/([A-Za-z]+(?:-[A-Za-z]+)*)-Hotels?-/);
  if (!match) return undefined;
  const name = match[1].replace(/-/g, ' ').trim();
  return isValidCityName(name) ? name : undefined;
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

  /**
   * Returns both the discovered cities AND (only for states with no
   * "Destinations in <State>" module — e.g. Karnataka) the hotels harvested
   * directly from that same state-wide sweep, so the caller can enqueue them
   * for detail-scraping immediately instead of waiting on a second,
   * redundant per-city search. See RegionDiscoveryProcessor.
   */
  async discoverCities(params: {
    countryId: string;
    countryName: string;
    stateId: string;
    stateName: string;
  }): Promise<{ cities: DiscoveredCity[]; hotels: DiscoveredStateHotel[] }> {
    const destination = `${params.stateName}, ${params.countryName}`;
    const url = buildHotelSearchUrl(this.config.get('scraper.expediaBaseUrl', { infer: true }), destination, this.config.get('scraper.searchStayNights', { infer: true }));

    const { cityNames, hotels } = await this.browser.withContext((context) => this.scrapePage(context.newPage(), url, params.stateName));

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

    this.logger.log(
      `Discovered ${results.length} valid cities in ${params.stateName}: ${results.map((r) => r.cityName).join(', ')}` +
        (hotels.length ? ` (+ ${hotels.length} hotels harvested directly from the state-wide sweep)` : ''),
    );
    return { cities: results, hotels };
  }

  private async scrapePage(pagePromise: Promise<Page>, url: string, stateName: string): Promise<{ cityNames: string[]; hotels: DiscoveredStateHotel[] }> {
    const page = await pagePromise;
    const names = new Set<string>();
    const hotelsById = new Map<string, DiscoveredStateHotel>();

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
            // Primary signal: these cards render their visible name as an
            // <img>, not text — the only text content is an sr-only
            // "Opens <name> in new tab" label. The card's own href always
            // carries a clean `destination=<name>` query param instead, so
            // read that first and only fall back to text-scraping (with the
            // "Opens ... in new tab" wrapper stripped) when there's no href.
            const href = await card.getAttribute('href').catch(() => null);
            let text = href ? (new URL(href, url).searchParams.get('destination') ?? '') : '';
            if (!text) {
              const nameEl = await card.$(ExpediaSelectors.search.destinationCityName).catch(() => null);
              text = (await (nameEl ?? card).innerText().catch(() => '')).trim();
              text = text
                .split('\n')[0]
                .replace(/^opens\s+/i, '')
                .replace(/\s+in\s+new\s+(tab|window)$/i, '')
                .replace(/hotels?|properties|destinations?/gi, '')
                .trim();
            }
            if (isValidCityName(text)) {
              names.add(text);
            }
          }
        }
        this.logger.log(`Destinations section yielded ${names.size} valid cities so far.`);
      } else {
        this.logger.log(`No destinations section for ${stateName} — this is a pure hotel-list state: harvesting its hotels directly instead of just mining city names from them.`);
      }

      // Strategy 2 used to scrape the sidebar's "Popular locations"/"Neighborhood"
      // filter as a city list. Verified live on 2026-09-08 (see expedia-selectors.ts
      // header): that filter now only surfaces landmarks/neighbourhoods ("M.G.
      // Road", "Bandipur National Park"), never city names — matching it would
      // silently write landmarks into master_city, so it was removed rather than
      // "fixed".

      // Strategy 3: walk the rendered hotel-list cards. Always the backbone
      // for states with no destinations module (only signal available at
      // all), and a useful supplement even when Strategy 1 found something.
      // Click "Show more" a few rounds first so the sample spans more of the
      // state than just the first screenful (more cards -> more distinct
      // localities, and — for no-destinations states — more hotels harvested
      // in this same pass instead of needing a second per-city search later).
      this.logger.log(`Extracting cities${section ? '' : ' and hotels'} from rendered hotel listing cards...`);
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

      const cards = await page.$$(ExpediaSelectors.hotelList.resultCard);
      const beforeStrategy3 = names.size;
      for (const card of cards) {
        const link = await card.$(ExpediaSelectors.hotelList.resultLink);
        const href = await link?.getAttribute('href');
        if (!href) continue;

        const locality = extractLocalityFromHref(href);
        if (locality) names.add(locality);

        // Only harvest full hotel records when there's no destinations
        // module — states that have one already get their hotels via the
        // normal per-city search, so harvesting here too would just be
        // redundant scraping (the two paths converge on the same
        // `hotel-${expediaHotelId}` BullMQ jobId downstream regardless, so
        // it's not a correctness issue, just wasted Playwright time).
        if (section) continue;

        const id = extractHotelId(href);
        if (!id || hotelsById.has(id)) continue;
        const name = await card
          .$$eval(ExpediaSelectors.hotelList.resultHeading, (headings) =>
            headings.map((h) => h.textContent?.trim() || '').find((t) => t && !/^photo gallery for/i.test(t)),
          )
          .catch(() => undefined);
        const detailUrl = new URL(href, url).toString();
        hotelsById.set(id, { expediaHotelId: id, detailUrl, name: name ?? '', locality });
      }
      this.logger.log(`Hotel-card extraction added ${names.size - beforeStrategy3} more valid cities (from ${cards.length} candidate cards)${section ? '' : `, harvested ${hotelsById.size} hotels`}.`);

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

    return { cityNames: [...names], hotels: [...hotelsById.values()] };
  }
}
