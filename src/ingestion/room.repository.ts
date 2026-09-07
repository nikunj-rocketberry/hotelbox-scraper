import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { ScrapedRoom } from './types';
import { resolveRoomCategory } from './room-category.util';
import { dedupeKeepLast, normalizeKey } from './batch.util';

export interface RoomBatchItem {
  hotelId: string;
  room: ScrapedRoom;
}

@Injectable()
export class RoomRepository {
  /** One batch upsert for every distinct room category across the whole flush, returning category-name -> id. */
  async batchGetOrCreateRoomCategories(manager: EntityManager, rawRoomNames: string[]): Promise<Map<string, string>> {
    const categories = [...new Set(rawRoomNames.map(resolveRoomCategory))];
    if (categories.length === 0) return new Map();

    const rows = await manager.query(
      `INSERT INTO master_room (name)
       SELECT * FROM UNNEST($1::text[])
       ON CONFLICT (name) DO UPDATE SET updated_at = now()
       RETURNING id, name`,
      [categories],
    );
    return new Map(rows.map((r: { id: string; name: string }) => [r.name, r.id]));
  }

  /**
   * Dedupe key: (hotel_id, lower(trim(room_name))) — matches the schema's own
   * partial unique index. Returns one room_to_hotel id per input item, same
   * order as `items`.
   */
  async batchUpsertRooms(manager: EntityManager, items: RoomBatchItem[], categoryIdByName: Map<string, string>): Promise<string[]> {
    const { deduped, indexToDedupedIndex } = dedupeKeepLast(items, (i) => `${i.hotelId}::${normalizeKey(i.room.name)}`);
    if (deduped.length === 0) return [];

    const hotelId = deduped.map((i) => i.hotelId);
    const roomId = deduped.map((i) => categoryIdByName.get(resolveRoomCategory(i.room.name)) ?? null);
    const roomName = deduped.map((i) => i.room.name);
    const description = deduped.map((i) => i.room.description ?? null);
    const maxOccupancy = deduped.map((i) => i.room.maxOccupancy ?? null);
    const maxAdults = deduped.map((i) => i.room.maxAdults ?? null);
    const maxChildren = deduped.map((i) => i.room.maxChildren ?? null);
    const numBedrooms = deduped.map((i) => i.room.numBedrooms ?? null);
    const numBathrooms = deduped.map((i) => i.room.numBathrooms ?? null);
    const bedType = deduped.map((i) => i.room.bedType ?? null);
    const bedCount = deduped.map((i) => i.room.bedCount ?? null);
    const areaSqm = deduped.map((i) => i.room.areaSqm ?? null);
    const areaSqft = deduped.map((i) => i.room.areaSqft ?? null);
    const viewType = deduped.map((i) => i.room.viewType ?? null);
    const smokingAllowed = deduped.map((i) => i.room.smokingAllowed ?? null);

    const rows = await manager.query(
      `INSERT INTO room_to_hotel (
         hotel_id, room_id, room_name, description,
         max_occupancy, max_adults, max_children,
         num_bedrooms, num_bathrooms, bed_type, bed_count,
         area_sqm, area_sqft, view_type, smoking_allowed, status
       )
       SELECT t.hotel_id, t.room_id, t.room_name, t.description,
              t.max_occupancy, t.max_adults, t.max_children,
              t.num_bedrooms, t.num_bathrooms, t.bed_type, t.bed_count,
              t.area_sqm, t.area_sqft, t.view_type, t.smoking_allowed, 1
       FROM UNNEST(
         $1::bigint[], $2::bigint[], $3::text[], $4::text[],
         $5::smallint[], $6::smallint[], $7::smallint[],
         $8::smallint[], $9::smallint[], $10::text[], $11::smallint[],
         $12::numeric[], $13::numeric[], $14::text[], $15::boolean[]
       ) AS t(hotel_id, room_id, room_name, description,
              max_occupancy, max_adults, max_children,
              num_bedrooms, num_bathrooms, bed_type, bed_count,
              area_sqm, area_sqft, view_type, smoking_allowed)
       ON CONFLICT (hotel_id, LOWER(TRIM(room_name))) WHERE deleted_at IS NULL DO UPDATE SET
         room_id = EXCLUDED.room_id,
         description = COALESCE(EXCLUDED.description, room_to_hotel.description),
         max_occupancy = COALESCE(EXCLUDED.max_occupancy, room_to_hotel.max_occupancy),
         max_adults = COALESCE(EXCLUDED.max_adults, room_to_hotel.max_adults),
         max_children = COALESCE(EXCLUDED.max_children, room_to_hotel.max_children),
         num_bedrooms = COALESCE(EXCLUDED.num_bedrooms, room_to_hotel.num_bedrooms),
         num_bathrooms = COALESCE(EXCLUDED.num_bathrooms, room_to_hotel.num_bathrooms),
         bed_type = COALESCE(EXCLUDED.bed_type, room_to_hotel.bed_type),
         bed_count = COALESCE(EXCLUDED.bed_count, room_to_hotel.bed_count),
         area_sqm = COALESCE(EXCLUDED.area_sqm, room_to_hotel.area_sqm),
         area_sqft = COALESCE(EXCLUDED.area_sqft, room_to_hotel.area_sqft),
         view_type = COALESCE(EXCLUDED.view_type, room_to_hotel.view_type),
         smoking_allowed = COALESCE(EXCLUDED.smoking_allowed, room_to_hotel.smoking_allowed),
         status = 1,
         updated_at = now()
       RETURNING id`,
      [
        hotelId, roomId, roomName, description,
        maxOccupancy, maxAdults, maxChildren,
        numBedrooms, numBathrooms, bedType, bedCount,
        areaSqm, areaSqft, viewType, smokingAllowed,
      ],
    );

    const dedupedIds: string[] = rows.map((r: { id: string }) => r.id);
    return indexToDedupedIndex.map((dedupedIndex) => dedupedIds[dedupedIndex]);
  }
}
