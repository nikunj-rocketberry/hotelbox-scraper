import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

export interface UploadedMediaRow {
  mediaUrl: string;
  s3Key: string;
  sourceUrl?: string;
  category?: string;
  caption?: string;
  width?: number;
  height?: number;
}

export interface FlatHotelMediaRow extends UploadedMediaRow {
  hotelId: string;
  sortOrder: number;
  isPrimary: boolean;
}

export interface FlatRoomMediaRow extends UploadedMediaRow {
  roomToHotelId: string;
  sortOrder: number;
  isPrimary: boolean;
}

/**
 * hotel_media/room_media carry no natural unique key on content (a photo can
 * legitimately repeat), so re-ingesting can't be upserted row-by-row without
 * risking duplicates. Instead each flush replaces the full media set for
 * every hotel/room in the batch with one DELETE (id = ANY(...)) + one bulk
 * INSERT covering every row across the whole batch.
 */
@Injectable()
export class MediaRepository {
  async batchReplaceHotelMedia(manager: EntityManager, hotelIds: string[], rows: FlatHotelMediaRow[]): Promise<void> {
    if (hotelIds.length === 0) return;
    await manager.query(`DELETE FROM hotel_media WHERE hotel_id = ANY($1::bigint[])`, [hotelIds]);
    if (rows.length === 0) return;

    await manager.query(
      `INSERT INTO hotel_media (hotel_id, media_url, s3_key, source_url, category, caption, width, height, sort_order, is_primary)
       SELECT * FROM UNNEST(
         $1::bigint[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::int[], $8::int[], $9::int[], $10::boolean[]
       )`,
      [
        rows.map((r) => r.hotelId),
        rows.map((r) => r.mediaUrl),
        rows.map((r) => r.s3Key),
        rows.map((r) => r.sourceUrl ?? null),
        rows.map((r) => r.category ?? 'Other'),
        rows.map((r) => r.caption ?? null),
        rows.map((r) => r.width ?? null),
        rows.map((r) => r.height ?? null),
        rows.map((r) => r.sortOrder),
        rows.map((r) => r.isPrimary),
      ],
    );
  }

  async batchReplaceRoomMedia(manager: EntityManager, roomToHotelIds: string[], rows: FlatRoomMediaRow[]): Promise<void> {
    if (roomToHotelIds.length === 0) return;
    await manager.query(`DELETE FROM room_media WHERE room_to_hotel_id = ANY($1::bigint[])`, [roomToHotelIds]);
    if (rows.length === 0) return;

    await manager.query(
      `INSERT INTO room_media (room_to_hotel_id, media_url, s3_key, source_url, caption, sort_order, is_primary)
       SELECT * FROM UNNEST(
         $1::bigint[], $2::text[], $3::text[], $4::text[], $5::text[], $6::int[], $7::boolean[]
       )`,
      [
        rows.map((r) => r.roomToHotelId),
        rows.map((r) => r.mediaUrl),
        rows.map((r) => r.s3Key),
        rows.map((r) => r.sourceUrl ?? null),
        rows.map((r) => r.caption ?? null),
        rows.map((r) => r.sortOrder),
        rows.map((r) => r.isPrimary),
      ],
    );
  }
}
