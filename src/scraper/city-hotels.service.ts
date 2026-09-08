import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Page } from 'playwright';
import { AppConfig } from '../config/configuration';
import { BrowserService } from './browser.service';
import { buildHotelSearchUrl } from './search-url.util';
import { ExpediaSelectors } from './expedia-selectors';

export interface DiscoveredHotel {
  expediaHotelId: string;
  detailUrl: string;
  name: string;
}

/** Expedia property URLs embed the property id as `.h<digits>.` — e.g. `...h1234567.Hotel-Information` */
function extractHotelId(href: string): string | null {
  const match = href.match(/\.h(\d+)\./);
  return match ? match[1] : null;
}

/**
 * Stage 2 of the pipeline: given one city, list every hotel Expedia returns
 * for it (paginated), and hand back just the identifiers + URLs — full
 * detail scraping happens in HotelDetailService, one job per hotel.
 */
@Injectable()
export class CityHotelsService {
  private readonly logger = new Logger(CityHotelsService.name);

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly browser: BrowserService,
  ) {}

  async listHotels(params: { cityName: string; stateName: string; countryName: string }): Promise<DiscoveredHotel[]> {
    const destination = `${params.cityName}, ${params.stateName}, ${params.countryName}`;
    const url = buildHotelSearchUrl(this.config.get('scraper.expediaBaseUrl', { infer: true }), destination, this.config.get('scraper.searchStayNights', { infer: true }));

    const maxPages = this.config.get('scraper.hotelListMaxPages', { infer: true });
    const hotels = await this.browser.withContext((context) => this.scrapeHotelList(context.newPage(), url, maxPages));
    this.logger.log(`Found ${hotels.length} hotels in ${params.cityName}`);
    return hotels;
  }

  /**
   * Expedia's hotel list has no real pagination anymore — a "Show more
   * stays" button appends more cards to the same page (infinite scroll)
   * instead of navigating. So `maxPages` here means "how many times to
   * click Show more", and cards are extracted once at the end rather than
   * per page.
   */
  private async scrapeHotelList(pagePromise: Promise<Page>, url: string, maxPages: number): Promise<DiscoveredHotel[]> {
    const page = await pagePromise;
    const byId = new Map<string, DiscoveredHotel>();

    try {
      await this.browser.safeGoto(page, url);

      await page.waitForSelector(ExpediaSelectors.hotelList.resultCard, { timeout: 15_000 }).catch(() => {
        this.logger.warn(`No result cards found for ${url}`);
      });

      for (let round = 0; round < maxPages - 1; round++) {
        const showMore = await page.$(ExpediaSelectors.hotelList.showMoreButton);
        if (!showMore) break;

        const countBefore = await page.$$eval(ExpediaSelectors.hotelList.resultCard, (els) => els.length);
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

      const cards = await page.$$(ExpediaSelectors.hotelList.resultCard);
      for (const card of cards) {
        const link = await card.$(ExpediaSelectors.hotelList.resultLink);
        const href = await link?.getAttribute('href');
        if (!href) continue;
        const id = extractHotelId(href);
        if (!id || byId.has(id)) continue;

        const name = await card
          .$$eval(ExpediaSelectors.hotelList.resultHeading, (headings) =>
            headings.map((h) => h.textContent?.trim() || '').find((t) => t && !/^photo gallery for/i.test(t)),
          )
          .catch(() => undefined);

        const detailUrl = new URL(href, url).toString();
        byId.set(id, { expediaHotelId: id, detailUrl, name: name ?? '' });
      }
    } finally {
      await page.close();
    }

    return [...byId.values()];
  }
}
