import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ElementHandle, Page } from 'playwright';
import { BrowserService } from './browser.service';
import { ExpediaSelectors } from './expedia-selectors';
import { ScrapedHotel, ScrapedRoom } from '../ingestion/types';
import { AppConfig } from '../config/configuration';

function toNumber(text: string | null | undefined): number | undefined {
  if (!text) return undefined;
  const match = text.replace(',', '.').match(/[\d.]+/);
  return match ? Number(match[0]) : undefined;
}

/** "starts at 2:00 PM" / "before noon" / "before 11 AM" -> "14:00" / "12:00" / "11:00". */
function extractTime(text: string | undefined): string | undefined {
  if (!text) return undefined;
  if (/noon/i.test(text)) return '12:00';
  if (/midnight/i.test(text)) return '00:00';
  const match = text.match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i);
  if (!match) return undefined;
  let hour = Number(match[1]);
  const minute = match[2] ?? '00';
  const isPm = /PM/i.test(match[3]);
  if (isPm && hour !== 12) hour += 12;
  if (!isPm && hour === 12) hour = 0;
  return `${String(hour).padStart(2, '0')}:${minute}`;
}

async function textOf(page: Page, selector: string): Promise<string | undefined> {
  const el = await page.$(selector);
  if (!el) return undefined;
  const text = (await el.innerText().catch(() => '')).trim();
  return text || undefined;
}

async function attrOf(page: Page, selector: string, name: string): Promise<string | undefined> {
  const value = await page.getAttribute(selector, name).catch(() => null);
  return value ?? undefined;
}

/** Prefers the largest `srcset` candidate over `src`/`data-src`, which are frequently a thumbnail-sized placeholder. */
async function bestImageUrl(img: ElementHandle<SVGElement | HTMLElement>): Promise<string | undefined> {
  const srcset = (await img.getAttribute('srcset').catch(() => null)) ?? (await img.getAttribute('data-srcset').catch(() => null));
  if (srcset) {
    const best = srcset
      .split(',')
      .map((entry) => entry.trim().split(/\s+/))
      .map(([url, descriptor]) => ({ url, width: descriptor ? Number(descriptor.replace(/[wx]$/i, '')) || 0 : 0 }))
      .filter((c) => c.url)
      .sort((a, b) => b.width - a.width)[0];
    if (best) return best.url;
  }
  return (await img.getAttribute('src').catch(() => null)) ?? (await img.getAttribute('data-src').catch(() => null)) ?? undefined;
}

const LODGING_JSONLD_TYPES = new Set(['Hotel', 'LodgingBusiness', 'Resort', 'Motel', 'BedAndBreakfast', 'Apartment']);

interface LodgingJsonLd {
  '@type'?: string | string[];
  name?: string;
  description?: string;
  telephone?: string;
  starRating?: { ratingValue?: string | number };
  aggregateRating?: { ratingValue?: string | number; reviewCount?: string | number };
  address?: { streetAddress?: string; postalCode?: string };
  geo?: { latitude?: string | number; longitude?: string | number };
  amenityFeature?: Array<{ name?: string; value?: boolean } | string>;
  image?: string | string[];
}

function isLodgingType(type: string | string[] | undefined): boolean {
  if (!type) return false;
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => LODGING_JSONLD_TYPES.has(t));
}

/** Flattens a parsed JSON-LD value (which may itself be an array, or wrap children in @graph) into a flat list of nodes. */
function flattenJsonLd(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(flattenJsonLd);
  if (value && typeof value === 'object') {
    const node = value as Record<string, unknown>;
    const graph = node['@graph'];
    if (Array.isArray(graph)) return graph.flatMap(flattenJsonLd);
    return [node];
  }
  return [];
}

/**
 * schema.org structured data (`<script type="application/ld+json">`) is a
 * secondary, much more stable signal than CSS/data-stid selectors — it's
 * meant for search engines, so sites break it far less often than they
 * restyle their markup. Used only to *fill gaps* the primary DOM selectors
 * leave (lat/long, postal code, and amenities are otherwise not captured at
 * all today), never to override an already-scraped value.
 */
async function extractLodgingJsonLd(page: Page): Promise<LodgingJsonLd | undefined> {
  const blocks = await page.$$eval('script[type="application/ld+json"]', (nodes) => nodes.map((n) => n.textContent || '')).catch(() => []);

  for (const raw of blocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const node = flattenJsonLd(parsed).find((n) => isLodgingType(n['@type'] as string | string[] | undefined));
    if (node) return node as LodgingJsonLd;
  }
  return undefined;
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
  private readonly maxHotelMediaCount: number;
  private readonly maxRoomMediaCount: number;

  constructor(
    private readonly browser: BrowserService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.maxHotelMediaCount = config.get('scraper.maxHotelMediaCount', { infer: true });
    this.maxRoomMediaCount = config.get('scraper.maxRoomMediaCount', { infer: true });
  }

  async scrapeHotel(expediaHotelId: string, detailUrl: string): Promise<ScrapedHotel> {
    return this.browser.withContext(async (context) => {
      const page = await context.newPage();
      try {
        await this.browser.safeGoto(page, detailUrl);
        await page.waitForSelector(ExpediaSelectors.hotelDetail.name, { timeout: 15_000 }).catch(() => {
          this.logger.warn(`Hotel title selector not found for ${detailUrl} — page structure may have changed`);
        });

        // Rooms, the amenities section and (on some templates) the review
        // summary only render once scrolled into view — walk the page down
        // in increments before reading anything so lazy content has a chance
        // to mount. Cheap and safe to run unconditionally.
        await this.scrollThroughPage(page);

        const jsonLd = await extractLodgingJsonLd(page);

        const name = (await textOf(page, ExpediaSelectors.hotelDetail.name)) ?? (await textOf(page, 'h1')) ?? jsonLd?.name ?? 'Unknown Hotel';

        // Star class is only exposed as visually-hidden text ("Property class: 5
        // and above") inside the title block — there's no dedicated badge element.
        const titleBlockText = (await textOf(page, ExpediaSelectors.hotelDetail.titleBlock)) ?? '';
        const starMatch = titleBlockText.match(/Property class:\s*([\d.]+)/i);
        const starRating = starMatch ? Number(starMatch[1]) : toNumber(jsonLd?.starRating?.ratingValue as string | undefined);

        // Guest rating / review count are schema.org microdata, not badge text.
        const guestRating = toNumber(await attrOf(page, ExpediaSelectors.hotelDetail.guestRatingMeta, 'content')) ?? toNumber(jsonLd?.aggregateRating?.ratingValue as string | undefined);
        const reviewCount = toNumber(await attrOf(page, ExpediaSelectors.hotelDetail.reviewCountMeta, 'content')) ?? toNumber(jsonLd?.aggregateRating?.reviewCount as string | undefined);

        const addressLine1 = (await textOf(page, ExpediaSelectors.hotelDetail.address)) ?? jsonLd?.address?.streetAddress;
        const postalCode = jsonLd?.address?.postalCode;
        const latitude = toNumber(jsonLd?.geo?.latitude as string | undefined);
        const longitude = toNumber(jsonLd?.geo?.longitude as string | undefined);
        const phone = (await textOf(page, ExpediaSelectors.hotelDetail.phone)) ?? jsonLd?.telephone;
        const fullDescription = (await textOf(page, ExpediaSelectors.hotelDetail.description)) ?? jsonLd?.description;
        const propertyType = Array.isArray(jsonLd?.['@type']) ? jsonLd?.['@type'][0] : jsonLd?.['@type'];

        const checkInText = await this.policyText(page, 'Check-in');
        const checkOutText = await this.policyText(page, 'Check-out');
        const checkInInstructions = await this.policyText(page, 'Special check-in instructions');
        const petPolicyText = await this.policyText(page, 'Pets');

        const checkInTime = extractTime(checkInText);
        const checkOutTime = extractTime(checkOutText);
        const petPolicy = petPolicyText?.slice(0, 255);

        // Best-effort: Expedia frequently doesn't render a dedicated
        // property-level amenities section on this page template at all (see
        // expedia-selectors.ts). Merge in schema.org's `amenityFeature` list
        // (when present) as a second, independent source rather than a
        // fallback — the DOM heading heuristic and the structured-data list
        // don't always agree on completeness, so take the union. Still never
        // backfill from room-level perks — those are room extras/promos, not
        // property amenities.
        const domAmenities = await this.textListUnderHeading(page, ExpediaSelectors.hotelDetail.amenitiesHeadingPattern);
        const jsonLdAmenities = (jsonLd?.amenityFeature ?? [])
          .map((a) => (typeof a === 'string' ? a : a.value === false ? undefined : a.name))
          .filter((a): a is string => !!a);
        const amenities = [...new Set([...domAmenities, ...jsonLdAmenities])];

        const media = await this.scrapeHotelPhotos(page, jsonLd);
        const rooms = await this.scrapeRooms(page);

        return {
          expediaHotelId,
          sourceUrl: detailUrl,
          name,
          propertyType,
          starRating,
          guestRating,
          reviewCount,
          addressLine1,
          postalCode,
          latitude,
          longitude,
          phone,
          fullDescription,
          checkInTime,
          checkOutTime,
          checkInInstructions,
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

  /**
   * Every policy fact (check-in, check-out, pets, ...) is a generic
   * `[data-stid="content-item"]` block distinguishable only by its own
   * heading text — there's no per-field selector for these anymore.
   */
  private async policyText(page: Page, heading: string): Promise<string | undefined> {
    const text = await page
      .evaluate(
        ({ selector, heading }) => {
          const items = Array.from(document.querySelectorAll(selector));
          for (const item of items) {
            const h = item.querySelector('h2, h3, h4');
            if (h && h.textContent?.trim() === heading) {
              return (item as HTMLElement).innerText || '';
            }
          }
          return null;
        },
        { selector: ExpediaSelectors.hotelDetail.policyItem, heading },
      )
      .catch(() => null);

    if (!text) return undefined;
    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    return lines.slice(1).join(' ') || undefined;
  }

  /** Finds a section by its heading text and returns its <li> items — used for the (often absent) amenities list. */
  private async textListUnderHeading(page: Page, headingPatternSource: string): Promise<string[]> {
    return page
      .evaluate((patternSource) => {
        const pattern = new RegExp(patternSource, 'i');
        const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4'));
        const heading = headings.find((h) => pattern.test(h.textContent || ''));
        if (!heading) return [];
        const container = heading.closest('section') ?? heading.parentElement?.parentElement ?? heading.parentElement;
        if (!container) return [];
        return Array.from(container.querySelectorAll('li'))
          .map((li) => li.textContent?.trim() || '')
          .filter(Boolean);
      }, headingPatternSource)
      .catch(() => []);
  }

  /** Scrolls the page down in increments so sections that only mount on scroll (rooms, amenities, review summary) have a chance to render before extraction reads the DOM. Bounded and best-effort — never blocks a scrape on it. */
  private async scrollThroughPage(page: Page): Promise<void> {
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
      await page.evaluate((fraction) => window.scrollTo(0, document.body.scrollHeight * fraction), i / steps).catch(() => undefined);
      await page.waitForTimeout(300);
    }
  }

  private async scrapeHotelPhotos(page: Page, jsonLd?: LodgingJsonLd): Promise<ScrapedHotel['media']> {
    const openButton = await page.$(ExpediaSelectors.hotelDetail.galleryOpenButton);
    if (openButton) {
      await openButton.click().catch(() => undefined);
      await page.waitForTimeout(1200);

      // The gallery dialog lazy-loads more images as it's scrolled — keep
      // nudging its last image into view until the count stops growing
      // (bounded to 15 rounds so a dialog that never settles can't hang the job).
      let previousCount = -1;
      for (let round = 0; round < 15; round++) {
        const loaded = await page.$$(ExpediaSelectors.hotelDetail.galleryImage);
        if (loaded.length === 0 || loaded.length === previousCount) break;
        previousCount = loaded.length;
        await loaded[loaded.length - 1].scrollIntoViewIfNeeded().catch(() => undefined);
        await page.waitForTimeout(400);
      }
    }

    const images = await page.$$(ExpediaSelectors.hotelDetail.galleryImage);
    const domUrls = (await Promise.all(images.map((img) => bestImageUrl(img)))).filter((u): u is string => !!u);

    // schema.org `image` is a secondary source — merge rather than replace,
    // since neither source is reliably the more complete one.
    const jsonLdUrls = jsonLd?.image ? (Array.isArray(jsonLd.image) ? jsonLd.image : [jsonLd.image]) : [];

    return [...new Set([...domUrls, ...jsonLdUrls])]
      .slice(0, this.maxHotelMediaCount)
      .map((url) => ({ url, category: 'Other' }));
  }

  /**
   * Room cards (`[data-stid="property-offer-N"]`) have no per-field
   * selectors for occupancy/bed-type/amenities: every fact (view, size,
   * "Sleeps N", bed type, amenities) is a flat, untagged `<li>` under one
   * `<ul>`, so it's categorized here by pattern-matching each item's text.
   */
  private async scrapeRooms(page: Page): Promise<ScrapedRoom[]> {
    const cards = await page.$$(ExpediaSelectors.rooms.roomCard);
    const rooms: ScrapedRoom[] = [];

    for (const card of cards) {
      try {
        // Each room card also has a marketing tagline heading ("Enjoy a king
        // size bed", "Upgrade your stay") that renders as an <h3> *before*
        // the real name and would win a naive "first non-hidden heading"
        // pick — the reliable signal is the hidden "View all photos for
        // <name>" heading, which always echoes the exact room name.
        const name = await card
          .$$eval('h3', (headings) => {
            const texts = headings.map((h) => h.textContent?.trim() || '');
            const photoHeadingMatch = texts.map((t) => t.match(/^View all photos for (.+)$/i)).find((m): m is RegExpMatchArray => !!m);
            if (photoHeadingMatch) return photoHeadingMatch[1].trim();
            return texts.find((t) => t && !/^(view all photos|our lowest price)/i.test(t));
          })
          .catch(() => undefined);
        if (!name) continue;

        const items = await card
          .$$eval('li', (lis) => lis.map((li) => li.textContent?.trim() || '').filter(Boolean))
          .catch(() => [] as string[]);

        let maxOccupancy: number | undefined;
        let bedType: string | undefined;
        let areaSqft: number | undefined;
        const amenities: string[] = [];

        for (const item of items) {
          const sleepsMatch = item.match(/^Sleeps\s+(\d+)/i);
          const sqftMatch = item.match(/^([\d,]+)\s*sq\s*ft/i);
          if (sleepsMatch) {
            maxOccupancy = Number(sleepsMatch[1]);
          } else if (sqftMatch) {
            areaSqft = Number(sqftMatch[1].replace(/,/g, ''));
          } else if (/\bbeds?\b/i.test(item) && !bedType) {
            bedType = item;
          } else {
            amenities.push(item);
          }
        }

        const media = await card
          .$$eval('img', (imgs) =>
            imgs
              .map((img) => {
                const srcset = img.getAttribute('srcset') ?? img.getAttribute('data-srcset');
                if (srcset) {
                  const best = srcset
                    .split(',')
                    .map((entry) => entry.trim().split(/\s+/))
                    .map(([url, descriptor]) => ({ url, width: descriptor ? Number(descriptor.replace(/[wx]$/i, '')) || 0 : 0 }))
                    .filter((c) => c.url)
                    .sort((a, b) => b.width - a.width)[0];
                  if (best) return best.url;
                }
                return img.getAttribute('src') ?? img.getAttribute('data-src') ?? '';
              })
              .filter(Boolean),
          )
          .catch(() => [] as string[]);

        rooms.push({
          name,
          maxOccupancy,
          bedType,
          areaSqft,
          amenities,
          media: [...new Set(media)].slice(0, this.maxRoomMediaCount).map((url) => ({ url })),
        });
      } catch (err) {
        this.logger.warn(`Skipping a room card: ${(err as Error).message}`);
      }
    }

    return rooms;
  }
}
