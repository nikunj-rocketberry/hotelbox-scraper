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

  private async scrapeHotelList(pagePromise: Promise<Page>, url: string, maxPages: number): Promise<DiscoveredHotel[]> {
    const page = await pagePromise;
    const byId = new Map<string, DiscoveredHotel>();

    try {
      await this.browser.safeGoto(page, url);

      for (let pageNum = 0; pageNum < maxPages; pageNum++) {
        await page.waitForSelector(ExpediaSelectors.hotelList.resultCard, { timeout: 15_000 }).catch(() => {
          this.logger.warn(`No result cards found on page ${pageNum + 1} for ${url}`);
        });

        const links = await page.$$(ExpediaSelectors.hotelList.resultLink);
        for (const link of links) {
          const href = await link.getAttribute('href');
          if (!href) continue;
          const id = extractHotelId(href);
          if (!id || byId.has(id)) continue;

          const nameEl = await link.$(ExpediaSelectors.hotelList.resultName);
          const name = (await (nameEl ?? link).innerText().catch(() => '')).trim();
          const detailUrl = new URL(href, url).toString();
          byId.set(id, { expediaHotelId: id, detailUrl, name });
        }

        const nextButton = await page.$(ExpediaSelectors.hotelList.nextPageButton);
        if (!nextButton) break;
        await nextButton.click();
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
      }
    } finally {
      await page.close();
    }

    return [...byId.values()];
  }
}
