import { Injectable, Logger } from '@nestjs/common';
import { Page } from 'playwright';
import { BrowserService } from './browser.service';
import { ExpediaSelectors } from './expedia-selectors';
import { ScrapedHotel, ScrapedRoom } from '../ingestion/types';

function toNumber(text: string | null | undefined): number | undefined {
  if (!text) return undefined;
  const match = text.replace(',', '.').match(/[\d.]+/);
  return match ? Number(match[0]) : undefined;
}

async function textOf(page: Page, selector: string): Promise<string | undefined> {
  const el = await page.$(selector);
  if (!el) return undefined;
  const text = (await el.innerText().catch(() => '')).trim();
  return text || undefined;
}

async function allTextsOf(page: Page, selector: string): Promise<string[]> {
  const els = await page.$$(selector);
  const texts = await Promise.all(els.map((el) => el.innerText().catch(() => '')));
  return texts.map((t) => t.trim()).filter(Boolean);
}

/**
 * Stage 3 of the pipeline: full detail scrape for one hotel — description,
 * ratings, address, amenities, policies, hotel photos, and every room's own
 * name/occupancy/layout/amenities/photos. Each field is wrapped so one
 * missing element (a stale selector, an A/B-tested layout) degrades that
 * field to `undefined` instead of failing the whole hotel.
 */
@Injectable()
export class HotelDetailService {
  private readonly logger = new Logger(HotelDetailService.name);

  constructor(private readonly browser: BrowserService) {}

  async scrapeHotel(expediaHotelId: string, detailUrl: string): Promise<ScrapedHotel> {
    return this.browser.withContext(async (context) => {
      const page = await context.newPage();
      try {
        await this.browser.safeGoto(page, detailUrl);
        await page.waitForSelector(ExpediaSelectors.hotelDetail.name, { timeout: 15_000 }).catch(() => {
          this.logger.warn(`Hotel title selector not found for ${detailUrl} — page structure may have changed`);
        });

        const name = (await textOf(page, ExpediaSelectors.hotelDetail.name)) ?? 'Unknown Hotel';
        const starRating = toNumber(await textOf(page, ExpediaSelectors.hotelDetail.starRating));
        const guestRating = toNumber(await textOf(page, ExpediaSelectors.hotelDetail.guestRating));
        const reviewCount = toNumber(await textOf(page, ExpediaSelectors.hotelDetail.reviewCount));
        const addressLine1 = await textOf(page, ExpediaSelectors.hotelDetail.address);
        const phone = await textOf(page, ExpediaSelectors.hotelDetail.phone);
        const fullDescription = await textOf(page, ExpediaSelectors.hotelDetail.description);
        const checkInTime = await textOf(page, ExpediaSelectors.hotelDetail.checkInTime);
        const checkOutTime = await textOf(page, ExpediaSelectors.hotelDetail.checkOutTime);
        const petPolicy = await textOf(page, ExpediaSelectors.hotelDetail.petPolicy);
        const amenities = await allTextsOf(page, ExpediaSelectors.hotelDetail.amenitiesList);

        const media = await this.scrapeHotelPhotos(page);
        const rooms = await this.scrapeRooms(page);

        return {
          expediaHotelId,
          sourceUrl: detailUrl,
          name,
          starRating,
          guestRating,
          reviewCount,
          addressLine1,
          phone,
          fullDescription,
          checkInTime,
          checkOutTime,
          petPolicy,
          amenities,
          media,
          rooms,
        };
      } finally {
        await page.close();
      }
    });
  }

  private async scrapeHotelPhotos(page: Page): Promise<ScrapedHotel['media']> {
    const openButton = await page.$(ExpediaSelectors.hotelDetail.seeAllPhotosButton);
    if (openButton) {
      await openButton.click().catch(() => undefined);
      await page.waitForTimeout(1000);
    }

    const images = await page.$$(ExpediaSelectors.hotelDetail.galleryImage);
    const urls = await Promise.all(
      images.map(async (img) => ({
        url: (await img.getAttribute('src')) ?? (await img.getAttribute('data-src')) ?? '',
      })),
    );
    return urls.filter((m) => m.url).map((m) => ({ url: m.url, category: 'Other' }));
  }

  private async scrapeRooms(page: Page): Promise<ScrapedRoom[]> {
    const cards = await page.$$(ExpediaSelectors.rooms.roomCard);
    const rooms: ScrapedRoom[] = [];

    for (const card of cards) {
      try {
        const name = (await (await card.$(ExpediaSelectors.rooms.roomName))?.innerText().catch(() => '')) ?? '';
        if (!name.trim()) continue;

        const description = await (await card.$(ExpediaSelectors.rooms.roomDescription))?.innerText().catch(() => undefined);
        const occupancyText = await (await card.$(ExpediaSelectors.rooms.roomOccupancy))?.innerText().catch(() => undefined);
        const bedType = await (await card.$(ExpediaSelectors.rooms.roomBedType))?.innerText().catch(() => undefined);

        const amenityEls = await card.$$(ExpediaSelectors.rooms.roomAmenities);
        const amenities = (await Promise.all(amenityEls.map((el) => el.innerText().catch(() => '')))).map((t) => t.trim()).filter(Boolean);

        const openMediaButton = await card.$(ExpediaSelectors.rooms.roomImageOpenButton);
        if (openMediaButton) {
          await openMediaButton.click().catch(() => undefined);
          await page.waitForTimeout(500);
        }
        const imageEls = await page.$$(ExpediaSelectors.rooms.roomImage);
        const media = (
          await Promise.all(imageEls.map(async (img) => (await img.getAttribute('src')) ?? (await img.getAttribute('data-src')) ?? ''))
        )
          .filter(Boolean)
          .map((url) => ({ url }));

        rooms.push({
          name: name.trim(),
          description: description?.trim() || undefined,
          maxOccupancy: toNumber(occupancyText),
          bedType: bedType?.trim() || undefined,
          amenities,
          media,
        });
      } catch (err) {
        this.logger.warn(`Skipping a room card: ${(err as Error).message}`);
      }
    }

    return rooms;
  }
}
