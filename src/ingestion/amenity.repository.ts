import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

@Injectable()
export class AmenityRepository {
  /** One batch upsert for every distinct amenity name across the whole flush, returning name -> id. */
  async batchGetOrCreateHotelAmenityIds(manager: EntityManager, allNames: string[]): Promise<Map<string, string>> {
    return this.batchGetOrCreateIds(manager, 'master_hotel_aminties', allNames);
  }

  async batchGetOrCreateRoomAmenityIds(manager: EntityManager, allNames: string[]): Promise<Map<string, string>> {
    return this.batchGetOrCreateIds(manager, 'master_room_aminties', allNames);
  }

  private async batchGetOrCreateIds(manager: EntityManager, table: 'master_hotel_aminties' | 'master_room_aminties', allNames: string[]): Promise<Map<string, string>> {
    // Last-resort safety net: the scraper already filters out overlong (non-
    // amenity) strings at the source, but this table's `name` column is
    // varchar(150) regardless of where a name came from (e.g. an unfiltered
    // schema.org amenityFeature) — one oversized string here previously
    // failed the entire batch insert, not just that one row.
    const unique = [...new Set(allNames.map((n) => n.trim().slice(0, 150)).filter(Boolean))];
    if (unique.length === 0) return new Map();

    const rows = await manager.query(
      `INSERT INTO ${table} (name)
       SELECT * FROM UNNEST($1::text[])
       ON CONFLICT (name) DO UPDATE SET updated_at = now()
       RETURNING id, name`,
      [unique],
    );
    return new Map(rows.map((r: { id: string; name: string }) => [r.name, r.id]));
  }

  /**
   * Replaces the amenity set for every hotel in the batch with exactly what
   * was just scraped: one DELETE (hotel_id = ANY(...)) + one bulk INSERT for
   * the whole batch, instead of a delete+insert pair per hotel.
   */
  async batchReplaceHotelAmenities(manager: EntityManager, pairs: Array<{ hotelId: string; amenityId: string }>, allHotelIds: string[]): Promise<void> {
    if (allHotelIds.length === 0) return;
    await manager.query(`DELETE FROM hotel_aminties_to_hotel WHERE hotel_id = ANY($1::bigint[])`, [allHotelIds]);
    if (pairs.length === 0) return;
    await manager.query(
      `INSERT INTO hotel_aminties_to_hotel (hotel_id, hotel_amenity_id)
       SELECT * FROM UNNEST($1::bigint[], $2::bigint[])
       ON CONFLICT (hotel_id, hotel_amenity_id) DO NOTHING`,
      [pairs.map((p) => p.hotelId), pairs.map((p) => p.amenityId)],
    );
  }

  async batchReplaceRoomAmenities(manager: EntityManager, pairs: Array<{ roomToHotelId: string; amenityId: string }>, allRoomToHotelIds: string[]): Promise<void> {
    if (allRoomToHotelIds.length === 0) return;
    await manager.query(`DELETE FROM room_aminities_to_room WHERE room_to_hotel_id = ANY($1::bigint[])`, [allRoomToHotelIds]);
    if (pairs.length === 0) return;
    await manager.query(
      `INSERT INTO room_aminities_to_room (room_to_hotel_id, room_amenity_id)
       SELECT * FROM UNNEST($1::bigint[], $2::bigint[])
       ON CONFLICT (room_to_hotel_id, room_amenity_id) DO NOTHING`,
      [pairs.map((p) => p.roomToHotelId), pairs.map((p) => p.amenityId)],
    );
  }
}
