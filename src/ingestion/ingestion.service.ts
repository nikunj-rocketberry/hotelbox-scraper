import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { HotelRepository, HotelBatchItem } from './hotel.repository';
import { RoomRepository, RoomBatchItem } from './room.repository';
import { AmenityRepository } from './amenity.repository';
import { MediaRepository, FlatHotelMediaRow, FlatRoomMediaRow, UploadedMediaRow } from './media.repository';
import { ScrapedHotel } from './types';
import { StorageService } from '../storage/storage.service';
import { dedupeKeepLast } from './batch.util';

/**
 * Batch ingestion for N hotels at once (N = whatever BatchIngestionService
 * flushed). Every DB write is a single multi-row statement covering the
 * whole batch — see hotel/room/amenity/media repositories.
 *
 * Two transactions, not one, and that's deliberate:
 *   1. Reserve hotel ids (batchUpsertHotels) — fast, standalone. We need real
 *      ids before we can name S3 keys for each hotel's photos.
 *   2. Upload images (network I/O to Expedia's CDN + MinIO) — explicitly
 *      OUTSIDE any transaction; holding a Postgres transaction open across a
 *      batch of HTTP round trips would tie up a connection + row locks for
 *      seconds at a time, which doesn't scale under N parallel workers.
 *   3. Everything else (details, media rows, rooms, amenities) — one
 *      transaction for the whole batch.
 * Trade-off: if step 3 fails, step 1's hotel rows stay committed without
 * their details/rooms/media. That's safe, not silently wrong — upserts are
 * idempotent, so the next time this hotel is scraped (retry or re-run) it
 * fills itself in completely. Perfect atomicity across network I/O isn't
 * achievable without distributed transactions anyway.
 */
@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly hotelRepository: HotelRepository,
    private readonly roomRepository: RoomRepository,
    private readonly amenityRepository: AmenityRepository,
    private readonly mediaRepository: MediaRepository,
    private readonly storageService: StorageService,
  ) {}

  async saveHotelsBatch(items: HotelBatchItem[]): Promise<string[]> {
    if (items.length === 0) return [];

    const hotelIds = await this.dataSource.transaction((manager) => this.hotelRepository.batchUpsertHotels(manager, items));

    // Two DIFFERENT input items can resolve to the SAME hotel id (same
    // normalized name, e.g. two Expedia listings for one real property).
    // Everything downstream — media, rooms, amenities — must operate on one
    // canonical item per hotel id, or duplicate media/room sets collide on
    // this table's own uniqueness rules (e.g. "one primary photo per hotel").
    // Last-scraped wins, matching batchUpsertHotels' own conflict resolution.
    const { deduped: canonical } = dedupeKeepLast(
      items.map((item, i) => ({ hotelId: hotelIds[i], hotel: item.hotel })),
      (p) => p.hotelId,
    );

    const hotelMediaRows: FlatHotelMediaRow[] = [];
    for (const { hotelId, hotel } of canonical) {
      const uploaded = await this.uploadMediaBatch(hotel.media, `hotels/${hotelId}`);
      uploaded.forEach((row, idx) => hotelMediaRows.push({ ...row, hotelId, sortOrder: idx, isPrimary: idx === 0 }));
    }

    const roomItems: RoomBatchItem[] = [];
    canonical.forEach(({ hotelId, hotel }) => {
      hotel.rooms.forEach((room) => roomItems.push({ hotelId, room }));
    });

    const roomUploadedMedia: UploadedMediaRow[][] = [];
    for (let j = 0; j < roomItems.length; j++) {
      const { hotelId, room } = roomItems[j];
      roomUploadedMedia.push(await this.uploadMediaBatch(room.media, `hotels/${hotelId}/rooms/${j}`));
    }

    const canonicalHotelIds = canonical.map((c) => c.hotelId);

    await this.dataSource.transaction(async (manager) => {
      await this.hotelRepository.batchUpsertHotelDetails(
        manager,
        canonicalHotelIds,
        canonical.map((c) => c.hotel),
      );

      await this.saveHotelAmenities(manager, canonical, canonicalHotelIds);
      await this.mediaRepository.batchReplaceHotelMedia(manager, canonicalHotelIds, hotelMediaRows);

      const categoryIdByName = await this.roomRepository.batchGetOrCreateRoomCategories(
        manager,
        roomItems.map((r) => r.room.name),
      );
      const roomToHotelIds = await this.roomRepository.batchUpsertRooms(manager, roomItems, categoryIdByName);

      await this.saveRoomAmenities(manager, roomItems, roomToHotelIds);

      const roomMediaRows: FlatRoomMediaRow[] = [];
      roomItems.forEach((_, j) => {
        roomUploadedMedia[j].forEach((row, idx) =>
          roomMediaRows.push({ ...row, roomToHotelId: roomToHotelIds[j], sortOrder: idx, isPrimary: idx === 0 }),
        );
      });
      await this.mediaRepository.batchReplaceRoomMedia(manager, roomToHotelIds, roomMediaRows);
    });

    this.logger.log(`Ingested batch of ${canonical.length} hotels (${items.length} scraped, deduped), ${roomItems.length} rooms (${hotelMediaRows.length} hotel photos, ${roomUploadedMedia.flat().length} room photos)`);
    return hotelIds;
  }

  private async saveHotelAmenities(manager: EntityManager, canonical: Array<{ hotelId: string; hotel: ScrapedHotel }>, hotelIds: string[]) {
    const allNames = canonical.flatMap((c) => c.hotel.amenities);
    const idByName = await this.amenityRepository.batchGetOrCreateHotelAmenityIds(manager, allNames);

    const pairs = canonical.flatMap((c) =>
      [...new Set(c.hotel.amenities.map((n) => n.trim()).filter(Boolean))]
        .map((name) => ({ hotelId: c.hotelId, amenityId: idByName.get(name) }))
        .filter((p): p is { hotelId: string; amenityId: string } => Boolean(p.amenityId)),
    );

    await this.amenityRepository.batchReplaceHotelAmenities(manager, pairs, hotelIds);
  }

  private async saveRoomAmenities(manager: EntityManager, roomItems: RoomBatchItem[], roomToHotelIds: string[]) {
    const allNames = roomItems.flatMap((r) => r.room.amenities);
    const idByName = await this.amenityRepository.batchGetOrCreateRoomAmenityIds(manager, allNames);

    const pairs = roomItems.flatMap((item, j) =>
      [...new Set(item.room.amenities.map((n) => n.trim()).filter(Boolean))]
        .map((name) => ({ roomToHotelId: roomToHotelIds[j], amenityId: idByName.get(name) }))
        .filter((p): p is { roomToHotelId: string; amenityId: string } => Boolean(p.amenityId)),
    );

    await this.amenityRepository.batchReplaceRoomAmenities(manager, pairs, roomToHotelIds);
  }

  private async uploadMediaBatch(media: ScrapedHotel['media'], keyPrefix: string): Promise<UploadedMediaRow[]> {
    const uploaded: UploadedMediaRow[] = [];
    for (const [index, item] of media.entries()) {
      try {
        const { url: mediaUrl, key: s3Key } = await this.storageService.uploadFromUrl(item.url, `${keyPrefix}/${index}`);
        uploaded.push({
          mediaUrl,
          s3Key,
          sourceUrl: item.url,
          category: item.category,
          caption: item.caption,
          width: item.width,
          height: item.height,
        });
      } catch (err) {
        this.logger.warn(`Skipping media ${item.url}: ${(err as Error).message}`);
      }
    }
    return uploaded;
  }
}
