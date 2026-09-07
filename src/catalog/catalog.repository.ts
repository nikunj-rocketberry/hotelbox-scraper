import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

export interface HotelListFilters {
  countryId?: string;
  stateId?: string;
  cityId?: string;
  q?: string;
  page: number;
  limit: number;
}

interface RoomMediaRow {
  room_to_hotel_id: string;
  media_url: string;
  sort_order: number;
}

interface RoomAmenityRow {
  room_to_hotel_id: string;
  name: string;
}

/**
 * Read-only queries for the data viewer. Raw SQL joins, not TypeORM relations
 * — the entities in ../database/entities deliberately carry no @OneToMany/
 * @ManyToOne (see hotel.repository.ts etc.), so every other repository in
 * this codebase already does its joins this way.
 */
@Injectable()
export class CatalogRepository {
  constructor(private readonly dataSource: DataSource) {}

  listCountries() {
    return this.dataSource.query(`SELECT id, name, iso2 FROM master_country WHERE is_active = true ORDER BY name`);
  }

  listStates(countryId?: string) {
    return this.dataSource.query(
      `SELECT id, name FROM master_state
       WHERE is_active = true AND ($1::bigint IS NULL OR country_id = $1)
       ORDER BY name`,
      [countryId ?? null],
    );
  }

  listCities(stateId?: string, countryId?: string) {
    return this.dataSource.query(
      `SELECT id, name FROM master_city
       WHERE is_active = true
         AND ($1::bigint IS NULL OR state_id = $1)
         AND ($2::bigint IS NULL OR country_id = $2)
       ORDER BY name`,
      [stateId ?? null, countryId ?? null],
    );
  }

  async listHotels(filters: HotelListFilters): Promise<{ rows: unknown[]; total: number }> {
    const { countryId, stateId, cityId, q, page, limit } = filters;
    const offset = (page - 1) * limit;
    const params = [countryId ?? null, stateId ?? null, cityId ?? null, q ?? null];

    const whereClause = `
      WHERE h.deleted_at IS NULL
        AND ($1::bigint IS NULL OR h.country_id = $1)
        AND ($2::bigint IS NULL OR h.state_id = $2)
        AND ($3::bigint IS NULL OR h.city_id = $3)
        AND ($4::text IS NULL OR h.name ILIKE '%' || $4 || '%')`;

    const [rows, countRows] = await Promise.all([
      this.dataSource.query(
        `SELECT h.id, h.name, h.star_rating, h.guest_rating, h.review_count, h.status, h.last_synced_at,
                c.name AS city_name, s.name AS state_name, co.name AS country_name,
                (SELECT hm.media_url FROM hotel_media hm WHERE hm.hotel_id = h.id
                   ORDER BY hm.is_primary DESC, hm.sort_order ASC LIMIT 1) AS primary_photo_url
         FROM master_hotel h
         LEFT JOIN master_city c ON c.id = h.city_id
         LEFT JOIN master_state s ON s.id = h.state_id
         LEFT JOIN master_country co ON co.id = h.country_id
         ${whereClause}
         ORDER BY h.last_synced_at DESC NULLS LAST, h.id DESC
         LIMIT $5 OFFSET $6`,
        [...params, limit, offset],
      ),
      this.dataSource.query(`SELECT COUNT(*)::int AS count FROM master_hotel h ${whereClause}`, params),
    ]);

    return { rows, total: countRows[0].count };
  }

  async getHotel(hotelId: string): Promise<Record<string, unknown> | null> {
    const rows = await this.dataSource.query(
      `SELECT h.id, h.name, h.property_type, h.star_rating, h.guest_rating, h.review_count,
              h.address_line1, h.address_line2, h.postal_code, h.latitude, h.longitude,
              h.phone, h.website, h.currency_code, h.status, h.last_synced_at,
              c.name AS city_name, s.name AS state_name, co.name AS country_name,
              d.headline, d.short_description, d.full_description,
              d.check_in_time, d.check_out_time, d.check_in_instructions, d.pet_policy
       FROM master_hotel h
       LEFT JOIN hotel_details d ON d.hotel_id = h.id
       LEFT JOIN master_city c ON c.id = h.city_id
       LEFT JOIN master_state s ON s.id = h.state_id
       LEFT JOIN master_country co ON co.id = h.country_id
       WHERE h.id = $1 AND h.deleted_at IS NULL`,
      [hotelId],
    );
    return rows[0] ?? null;
  }

  getHotelMedia(hotelId: string) {
    return this.dataSource.query(
      `SELECT media_url, category, caption, is_primary, sort_order
       FROM hotel_media WHERE hotel_id = $1 ORDER BY sort_order`,
      [hotelId],
    );
  }

  async getHotelAmenities(hotelId: string): Promise<string[]> {
    const rows = await this.dataSource.query(
      `SELECT a.name FROM hotel_aminties_to_hotel hth
       JOIN master_hotel_aminties a ON a.id = hth.hotel_amenity_id
       WHERE hth.hotel_id = $1 ORDER BY a.name`,
      [hotelId],
    );
    return rows.map((r: { name: string }) => r.name);
  }

  async getRooms(hotelId: string): Promise<Array<Record<string, unknown>>> {
    const rooms: Array<{ id: string }> = await this.dataSource.query(
      `SELECT id, room_name, description, max_occupancy, max_adults, max_children,
              num_bedrooms, num_bathrooms, bed_type, bed_count, area_sqm, area_sqft, view_type
       FROM room_to_hotel WHERE hotel_id = $1 AND deleted_at IS NULL ORDER BY id`,
      [hotelId],
    );
    if (rooms.length === 0) return [];

    const roomIds = rooms.map((r) => r.id);
    const [media, amenities]: [RoomMediaRow[], RoomAmenityRow[]] = await Promise.all([
      this.dataSource.query(
        `SELECT room_to_hotel_id, media_url, sort_order FROM room_media
         WHERE room_to_hotel_id = ANY($1::bigint[]) ORDER BY sort_order`,
        [roomIds],
      ),
      this.dataSource.query(
        `SELECT rta.room_to_hotel_id, a.name FROM room_aminities_to_room rta
         JOIN master_room_aminties a ON a.id = rta.room_amenity_id
         WHERE rta.room_to_hotel_id = ANY($1::bigint[]) ORDER BY a.name`,
        [roomIds],
      ),
    ]);

    return rooms.map((room) => ({
      ...room,
      media: media.filter((m) => m.room_to_hotel_id === room.id),
      amenities: amenities.filter((a) => a.room_to_hotel_id === room.id).map((a) => a.name),
    }));
  }
}
