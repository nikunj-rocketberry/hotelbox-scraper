import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { GeoContext, ScrapedHotel } from './types';
import { dedupeKeepLast, normalizeKey } from './batch.util';

export interface HotelBatchItem {
  hotel: ScrapedHotel;
  geo: GeoContext;
}

/**
 * Batch upserts for master_hotel / hotel_details. Every insert is a single
 * multi-row statement built with UNNEST array parameters — one round trip
 * for the whole batch (N hotels), not N round trips. Postgres preserves
 * input row order through UNNEST -> RETURNING, so the returned ids line up
 * positionally with the deduped input arrays.
 */
@Injectable()
export class HotelRepository {
  /**
   * Which of these Expedia hotel ids were already scraped within the last
   * `freshnessDays` — the caching half of the discovery step: callers skip
   * enqueueing a full detail-page scrape (and the Playwright navigation that
   * costs) for anything that comes back here, since we already have
   * up-to-date data for it. Matches by expedia_hotel_id, not name, so it
   * can't be fooled by two different properties sharing a display name.
   */
  async findFreshExpediaHotelIds(manager: EntityManager, expediaHotelIds: string[], freshnessDays: number): Promise<Set<string>> {
    if (expediaHotelIds.length === 0 || freshnessDays <= 0) return new Set();

    const rows = await manager.query(
      `SELECT expedia_hotel_id FROM master_hotel
       WHERE expedia_hotel_id = ANY($1::text[])
         AND deleted_at IS NULL
         AND last_synced_at > now() - ($2 || ' days')::interval`,
      [expediaHotelIds, freshnessDays],
    );
    return new Set(rows.map((r: { expedia_hotel_id: string }) => r.expedia_hotel_id));
  }

  /** Returns one hotel id per input item, in the same order as `items` (duplicates by name resolve to the same id). */
  async batchUpsertHotels(manager: EntityManager, items: HotelBatchItem[]): Promise<string[]> {
    const { deduped, indexToDedupedIndex } = dedupeKeepLast(items, (i) => normalizeKey(i.hotel.name));

    const name = deduped.map((i) => i.hotel.name);
    const expediaHotelId = deduped.map((i) => i.hotel.expediaHotelId ?? null);
    const normalizedName = deduped.map((i) => i.hotel.name.trim());
    const propertyType = deduped.map((i) => i.hotel.propertyType ?? null);
    const starRating = deduped.map((i) => i.hotel.starRating ?? null);
    const guestRating = deduped.map((i) => i.hotel.guestRating ?? null);
    const reviewCount = deduped.map((i) => i.hotel.reviewCount ?? 0);
    const countryId = deduped.map((i) => i.geo.countryId);
    const stateId = deduped.map((i) => i.geo.stateId ?? null);
    const cityId = deduped.map((i) => i.geo.cityId ?? null);
    const addressLine1 = deduped.map((i) => i.hotel.addressLine1 ?? null);
    const addressLine2 = deduped.map((i) => i.hotel.addressLine2 ?? null);
    const postalCode = deduped.map((i) => i.hotel.postalCode ?? null);
    const latitude = deduped.map((i) => i.hotel.latitude ?? null);
    const longitude = deduped.map((i) => i.hotel.longitude ?? null);
    const phone = deduped.map((i) => i.hotel.phone ?? null);
    const website = deduped.map((i) => i.hotel.website ?? null);
    const currencyCode = deduped.map((i) => i.hotel.currencyCode ?? null);

    const rows = await manager.query(
      `INSERT INTO master_hotel (
         name, expedia_hotel_id, normalized_name, property_type, star_rating, guest_rating, review_count,
         country_id, state_id, city_id, address_line1, address_line2, postal_code,
         latitude, longitude, phone, website, currency_code, status, last_synced_at
       )
       SELECT t.name, t.expedia_hotel_id, t.normalized_name, t.property_type, t.star_rating, t.guest_rating, t.review_count,
              t.country_id, t.state_id, t.city_id, t.address_line1, t.address_line2, t.postal_code,
              t.latitude, t.longitude, t.phone, t.website, t.currency_code, 1, now()
       FROM UNNEST(
         $1::text[], $2::text[], $3::text[], $4::text[], $5::numeric[], $6::numeric[], $7::int[],
         $8::bigint[], $9::bigint[], $10::bigint[], $11::text[], $12::text[], $13::text[],
         $14::numeric[], $15::numeric[], $16::text[], $17::text[], $18::text[]
       ) AS t(name, expedia_hotel_id, normalized_name, property_type, star_rating, guest_rating, review_count,
              country_id, state_id, city_id, address_line1, address_line2, postal_code,
              latitude, longitude, phone, website, currency_code)
       ON CONFLICT (LOWER(TRIM(name))) WHERE deleted_at IS NULL DO UPDATE SET
         expedia_hotel_id = COALESCE(EXCLUDED.expedia_hotel_id, master_hotel.expedia_hotel_id),
         property_type = COALESCE(EXCLUDED.property_type, master_hotel.property_type),
         star_rating = COALESCE(EXCLUDED.star_rating, master_hotel.star_rating),
         guest_rating = COALESCE(EXCLUDED.guest_rating, master_hotel.guest_rating),
         review_count = COALESCE(EXCLUDED.review_count, master_hotel.review_count),
         country_id = COALESCE(EXCLUDED.country_id, master_hotel.country_id),
         state_id = COALESCE(EXCLUDED.state_id, master_hotel.state_id),
         city_id = COALESCE(EXCLUDED.city_id, master_hotel.city_id),
         address_line1 = COALESCE(EXCLUDED.address_line1, master_hotel.address_line1),
         address_line2 = COALESCE(EXCLUDED.address_line2, master_hotel.address_line2),
         postal_code = COALESCE(EXCLUDED.postal_code, master_hotel.postal_code),
         latitude = COALESCE(EXCLUDED.latitude, master_hotel.latitude),
         longitude = COALESCE(EXCLUDED.longitude, master_hotel.longitude),
         phone = COALESCE(EXCLUDED.phone, master_hotel.phone),
         website = COALESCE(EXCLUDED.website, master_hotel.website),
         currency_code = COALESCE(EXCLUDED.currency_code, master_hotel.currency_code),
         status = 1,
         last_synced_at = now(),
         updated_at = now()
       RETURNING id`,
      [
        name, expediaHotelId, normalizedName, propertyType, starRating, guestRating, reviewCount,
        countryId, stateId, cityId, addressLine1, addressLine2, postalCode,
        latitude, longitude, phone, website, currencyCode,
      ],
    );

    const dedupedIds: string[] = rows.map((r: { id: string }) => r.id);
    return indexToDedupedIndex.map((dedupedIndex) => dedupedIds[dedupedIndex]);
  }

  /** `hotelIds[i]` must correspond to `items[i]`. Dedupes by hotel_id (1:1 table) before the batch upsert. */
  async batchUpsertHotelDetails(manager: EntityManager, hotelIds: string[], items: ScrapedHotel[]): Promise<void> {
    const paired = items.map((hotel, i) => ({ hotelId: hotelIds[i], hotel }));
    const { deduped } = dedupeKeepLast(paired, (p) => p.hotelId);
    if (deduped.length === 0) return;

    await manager.query(
      `INSERT INTO hotel_details (
         hotel_id, headline, short_description, full_description,
         check_in_time, check_out_time, check_in_instructions, pet_policy,
         children_policy, optional_fees, know_before_you_go, spoken_languages, attributes
       )
       SELECT t.hotel_id, t.headline, t.short_description, t.full_description,
              t.check_in_time, t.check_out_time, t.check_in_instructions, t.pet_policy,
              t.children_policy, t.optional_fees, t.know_before_you_go, t.spoken_languages::jsonb, t.attributes::jsonb
       FROM UNNEST(
         $1::bigint[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[],
         $9::text[], $10::text[], $11::text[], $12::text[], $13::text[]
       ) AS t(hotel_id, headline, short_description, full_description,
              check_in_time, check_out_time, check_in_instructions, pet_policy,
              children_policy, optional_fees, know_before_you_go, spoken_languages, attributes)
       ON CONFLICT (hotel_id) DO UPDATE SET
         headline = COALESCE(EXCLUDED.headline, hotel_details.headline),
         short_description = COALESCE(EXCLUDED.short_description, hotel_details.short_description),
         full_description = COALESCE(EXCLUDED.full_description, hotel_details.full_description),
         check_in_time = COALESCE(EXCLUDED.check_in_time, hotel_details.check_in_time),
         check_out_time = COALESCE(EXCLUDED.check_out_time, hotel_details.check_out_time),
         check_in_instructions = COALESCE(EXCLUDED.check_in_instructions, hotel_details.check_in_instructions),
         pet_policy = COALESCE(EXCLUDED.pet_policy, hotel_details.pet_policy),
         children_policy = COALESCE(EXCLUDED.children_policy, hotel_details.children_policy),
         optional_fees = COALESCE(EXCLUDED.optional_fees, hotel_details.optional_fees),
         know_before_you_go = COALESCE(EXCLUDED.know_before_you_go, hotel_details.know_before_you_go),
         spoken_languages = COALESCE(EXCLUDED.spoken_languages, hotel_details.spoken_languages),
         attributes = COALESCE(EXCLUDED.attributes, hotel_details.attributes),
         updated_at = now()`,
      [
        deduped.map((p) => p.hotelId),
        deduped.map((p) => p.hotel.headline ?? null),
        deduped.map((p) => p.hotel.shortDescription ?? null),
        deduped.map((p) => p.hotel.fullDescription ?? null),
        deduped.map((p) => p.hotel.checkInTime ?? null),
        deduped.map((p) => p.hotel.checkOutTime ?? null),
        deduped.map((p) => p.hotel.checkInInstructions ?? null),
        deduped.map((p) => p.hotel.petPolicy ?? null),
        deduped.map((p) => p.hotel.childrenPolicy ?? null),
        deduped.map((p) => p.hotel.optionalFees ?? null),
        deduped.map((p) => p.hotel.knowBeforeYouGo ?? null),
        deduped.map((p) => (p.hotel.spokenLanguages?.length ? JSON.stringify(p.hotel.spokenLanguages) : null)),
        deduped.map((p) =>
          p.hotel.accessibilityNotes || p.hotel.accessibilityFeatures?.length
            ? JSON.stringify({ accessibility: { notes: p.hotel.accessibilityNotes ?? null, features: p.hotel.accessibilityFeatures ?? [] } })
            : null,
        ),
      ],
    );
  }
}
