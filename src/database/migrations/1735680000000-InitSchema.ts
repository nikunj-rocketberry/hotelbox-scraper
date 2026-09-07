import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Verbatim implementation of ../../../expedia_hotel_content_schema.md.
 * Keep this migration in sync with that doc if the schema changes there.
 */
export class InitSchema1735680000000 implements MigrationInterface {
  name = 'InitSchema1735680000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION set_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
          NEW.updated_at = now();
          RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    // ---------------------------------------------------------------- geo
    await queryRunner.query(`
      CREATE TABLE master_country (
          id              BIGSERIAL PRIMARY KEY,
          name            VARCHAR(100) NOT NULL,
          iso2            CHAR(2) NOT NULL,
          iso3            CHAR(3) NOT NULL,
          phone_code      VARCHAR(10),
          currency_code   CHAR(3),
          region          VARCHAR(50),
          is_active       BOOLEAN NOT NULL DEFAULT TRUE,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

          CONSTRAINT master_country_iso2_unique UNIQUE (iso2),
          CONSTRAINT master_country_iso3_unique UNIQUE (iso3),
          CONSTRAINT master_country_iso2_format_chk CHECK (iso2 ~ '^[A-Z]{2}$'),
          CONSTRAINT master_country_iso3_format_chk CHECK (iso3 ~ '^[A-Z]{3}$')
      );
      CREATE INDEX master_country_name_idx ON master_country (name);
      CREATE INDEX master_country_is_active_idx ON master_country (is_active);
      CREATE TRIGGER trg_master_country_updated_at
          BEFORE UPDATE ON master_country
          FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    `);

    await queryRunner.query(`
      CREATE TABLE master_state (
          id              BIGSERIAL PRIMARY KEY,
          country_id      BIGINT NOT NULL REFERENCES master_country(id) ON DELETE RESTRICT,
          name            VARCHAR(150) NOT NULL,
          state_code      VARCHAR(10),
          is_active       BOOLEAN NOT NULL DEFAULT TRUE,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

          CONSTRAINT master_state_country_name_unique UNIQUE (country_id, name)
      );
      CREATE INDEX master_state_country_id_idx ON master_state (country_id);
      CREATE INDEX master_state_name_idx ON master_state (name);
      CREATE INDEX master_state_is_active_idx ON master_state (is_active);
      CREATE TRIGGER trg_master_state_updated_at
          BEFORE UPDATE ON master_state
          FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    `);

    await queryRunner.query(`
      CREATE TABLE master_city (
          id              BIGSERIAL PRIMARY KEY,
          country_id      BIGINT NOT NULL REFERENCES master_country(id) ON DELETE RESTRICT,
          state_id        BIGINT REFERENCES master_state(id) ON DELETE SET NULL,
          name            VARCHAR(150) NOT NULL,
          latitude        NUMERIC(10,7),
          longitude       NUMERIC(10,7),
          timezone        VARCHAR(60),
          is_active       BOOLEAN NOT NULL DEFAULT TRUE,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

          CONSTRAINT master_city_country_state_name_unique UNIQUE (country_id, state_id, name),
          CONSTRAINT master_city_latitude_chk CHECK (latitude BETWEEN -90 AND 90),
          CONSTRAINT master_city_longitude_chk CHECK (longitude BETWEEN -180 AND 180)
      );
      CREATE INDEX master_city_country_id_idx ON master_city (country_id);
      CREATE INDEX master_city_state_id_idx ON master_city (state_id);
      CREATE INDEX master_city_name_idx ON master_city (name);
      CREATE INDEX master_city_is_active_idx ON master_city (is_active);
      CREATE TRIGGER trg_master_city_updated_at
          BEFORE UPDATE ON master_city
          FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    `);

    // -------------------------------------------------------- hotel core
    await queryRunner.query(`
      CREATE TABLE master_hotel (
          id                      BIGSERIAL PRIMARY KEY,
          last_synced_at         TIMESTAMPTZ,
          name                   VARCHAR(255) NOT NULL,
          normalized_name        VARCHAR(255),
          property_type          VARCHAR(60),
          chain_code             VARCHAR(60),
          chain_name             VARCHAR(150),
          brand_code             VARCHAR(60),
          brand_name             VARCHAR(150),
          rank                   INTEGER,
          multi_unit             BOOLEAN NOT NULL DEFAULT FALSE,
          star_rating            NUMERIC(2,1),
          guest_rating           NUMERIC(3,1),
          review_count           INTEGER NOT NULL DEFAULT 0,
          country_id             BIGINT REFERENCES master_country(id) ON DELETE SET NULL,
          state_id               BIGINT REFERENCES master_state(id) ON DELETE SET NULL,
          city_id                BIGINT REFERENCES master_city(id) ON DELETE SET NULL,
          address_line1          VARCHAR(255),
          address_line2          VARCHAR(255),
          postal_code            VARCHAR(20),
          latitude               NUMERIC(10,7),
          longitude              NUMERIC(10,7),
          timezone               VARCHAR(60),
          phone                  VARCHAR(30),
          fax                    VARCHAR(30),
          email                  VARCHAR(150),
          website                VARCHAR(255),
          currency_code          CHAR(3),
          status                 SMALLINT NOT NULL DEFAULT 2,
          created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
          deleted_at             TIMESTAMPTZ,

          CONSTRAINT master_hotel_status_chk CHECK (status IN (0, 1, 2)),
          CONSTRAINT master_hotel_star_rating_chk CHECK (star_rating BETWEEN 0 AND 5),
          CONSTRAINT master_hotel_guest_rating_chk CHECK (guest_rating BETWEEN 0 AND 10),
          CONSTRAINT master_hotel_review_count_chk CHECK (review_count >= 0),
          CONSTRAINT master_hotel_latitude_chk CHECK (latitude BETWEEN -90 AND 90),
          CONSTRAINT master_hotel_longitude_chk CHECK (longitude BETWEEN -180 AND 180),
          CONSTRAINT master_hotel_email_format_chk CHECK (email IS NULL OR email ~ '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$')
      );
      CREATE INDEX master_hotel_name_idx ON master_hotel (name);
      CREATE INDEX master_hotel_normalized_name_idx ON master_hotel USING gin (normalized_name gin_trgm_ops);
      CREATE INDEX master_hotel_country_id_idx ON master_hotel (country_id);
      CREATE INDEX master_hotel_state_id_idx ON master_hotel (state_id);
      CREATE INDEX master_hotel_city_id_idx ON master_hotel (city_id);
      CREATE INDEX master_hotel_status_idx ON master_hotel (status);
      CREATE INDEX master_hotel_star_rating_idx ON master_hotel (star_rating);
      CREATE INDEX master_hotel_chain_code_idx ON master_hotel (chain_code);
      CREATE INDEX master_hotel_deleted_at_idx ON master_hotel (deleted_at);
      CREATE UNIQUE INDEX master_hotel_name_ci_unique
          ON master_hotel (LOWER(TRIM(name))) WHERE deleted_at IS NULL;
      CREATE TRIGGER trg_master_hotel_updated_at
          BEFORE UPDATE ON master_hotel
          FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    `);

    await queryRunner.query(`
      CREATE TABLE hotel_details (
          id                      BIGSERIAL PRIMARY KEY,
          hotel_id                BIGINT NOT NULL REFERENCES master_hotel(id) ON DELETE CASCADE,
          headline                VARCHAR(255),
          short_description       TEXT,
          full_description        TEXT,
          amenities_summary       TEXT,
          check_in_time           VARCHAR(5),
          check_out_time          VARCHAR(5),
          check_in_instructions   TEXT,
          special_instructions    TEXT,
          min_checkin_age         SMALLINT,
          pet_policy              VARCHAR(255),
          smoking_policy          VARCHAR(60),
          children_policy         TEXT,
          extra_bed_policy        TEXT,
          mandatory_fees          TEXT,
          optional_fees           TEXT,
          know_before_you_go      TEXT,
          total_rooms             INTEGER,
          total_floors             INTEGER,
          year_built               SMALLINT,
          year_renovated           SMALLINT,
          spoken_languages        JSONB,
          payment_types_accepted  JSONB,
          themes                  JSONB,
          attributes              JSONB,
          created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

          CONSTRAINT hotel_details_hotel_id_unique UNIQUE (hotel_id),
          CONSTRAINT hotel_details_total_rooms_chk CHECK (total_rooms IS NULL OR total_rooms >= 0),
          CONSTRAINT hotel_details_min_checkin_age_chk CHECK (min_checkin_age IS NULL OR min_checkin_age >= 0)
      );
      CREATE TRIGGER trg_hotel_details_updated_at
          BEFORE UPDATE ON hotel_details
          FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    `);

    await queryRunner.query(`
      CREATE TABLE hotel_media (
          id              BIGSERIAL PRIMARY KEY,
          hotel_id        BIGINT NOT NULL REFERENCES master_hotel(id) ON DELETE CASCADE,
          media_url       VARCHAR(1024) NOT NULL,
          s3_key          VARCHAR(1024),
          source_url      TEXT,
          category        VARCHAR(50) NOT NULL DEFAULT 'Other',
          caption         VARCHAR(255),
          width           INTEGER,
          height          INTEGER,
          is_primary      BOOLEAN NOT NULL DEFAULT FALSE,
          sort_order      INTEGER NOT NULL DEFAULT 0,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

          CONSTRAINT hotel_media_width_chk CHECK (width IS NULL OR width > 0),
          CONSTRAINT hotel_media_height_chk CHECK (height IS NULL OR height > 0)
      );
      CREATE INDEX hotel_media_hotel_id_idx ON hotel_media (hotel_id);
      CREATE INDEX hotel_media_hotel_sort_idx ON hotel_media (hotel_id, sort_order);
      CREATE INDEX hotel_media_category_idx ON hotel_media (category);
      CREATE UNIQUE INDEX hotel_media_one_primary_per_hotel_uq
          ON hotel_media (hotel_id) WHERE is_primary = TRUE;
      CREATE TRIGGER trg_hotel_media_updated_at
          BEFORE UPDATE ON hotel_media
          FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    `);

    // -------------------------------------------------------------- rooms
    await queryRunner.query(`
      CREATE TABLE master_room (
          id              BIGSERIAL PRIMARY KEY,
          name            VARCHAR(150) NOT NULL,
          code            VARCHAR(50),
          description     VARCHAR(255),
          is_active       BOOLEAN NOT NULL DEFAULT TRUE,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

          CONSTRAINT master_room_name_unique UNIQUE (name),
          CONSTRAINT master_room_code_unique UNIQUE (code)
      );
      CREATE INDEX master_room_is_active_idx ON master_room (is_active);
      CREATE TRIGGER trg_master_room_updated_at
          BEFORE UPDATE ON master_room
          FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    `);

    await queryRunner.query(`
      CREATE TABLE room_to_hotel (
          id                  BIGSERIAL PRIMARY KEY,
          hotel_id            BIGINT NOT NULL REFERENCES master_hotel(id) ON DELETE CASCADE,
          room_id             BIGINT REFERENCES master_room(id) ON DELETE SET NULL,
          room_name           VARCHAR(255) NOT NULL,
          description         TEXT,
          max_occupancy       SMALLINT,
          max_adults          SMALLINT,
          max_children        SMALLINT,
          min_adults          SMALLINT NOT NULL DEFAULT 1,
          num_bedrooms        SMALLINT,
          num_bathrooms       SMALLINT,
          bed_type            VARCHAR(100),
          bed_count           SMALLINT,
          bed_groups          JSONB,
          area_sqm            NUMERIC(8,2),
          area_sqft           NUMERIC(8,2),
          view_type           VARCHAR(100),
          smoking_allowed     BOOLEAN,
          status              SMALLINT NOT NULL DEFAULT 1,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          deleted_at          TIMESTAMPTZ,

          CONSTRAINT room_to_hotel_status_chk CHECK (status IN (0, 1)),
          CONSTRAINT room_to_hotel_max_occupancy_chk CHECK (max_occupancy IS NULL OR max_occupancy > 0),
          CONSTRAINT room_to_hotel_max_adults_chk CHECK (max_adults IS NULL OR max_adults > 0),
          CONSTRAINT room_to_hotel_max_children_chk CHECK (max_children IS NULL OR max_children >= 0),
          CONSTRAINT room_to_hotel_area_sqm_chk CHECK (area_sqm IS NULL OR area_sqm > 0),
          CONSTRAINT room_to_hotel_area_sqft_chk CHECK (area_sqft IS NULL OR area_sqft > 0)
      );
      CREATE INDEX room_to_hotel_hotel_id_idx ON room_to_hotel (hotel_id);
      CREATE INDEX room_to_hotel_room_id_idx ON room_to_hotel (room_id);
      CREATE INDEX room_to_hotel_status_idx ON room_to_hotel (status);
      CREATE INDEX room_to_hotel_deleted_at_idx ON room_to_hotel (deleted_at);
      CREATE UNIQUE INDEX room_to_hotel_hotel_room_name_ci_unique
          ON room_to_hotel (hotel_id, LOWER(TRIM(room_name))) WHERE deleted_at IS NULL;
      CREATE TRIGGER trg_room_to_hotel_updated_at
          BEFORE UPDATE ON room_to_hotel
          FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    `);

    await queryRunner.query(`
      CREATE TABLE room_media (
          id                  BIGSERIAL PRIMARY KEY,
          room_to_hotel_id    BIGINT NOT NULL REFERENCES room_to_hotel(id) ON DELETE CASCADE,
          media_url           VARCHAR(1024) NOT NULL,
          s3_key              VARCHAR(1024),
          source_url          TEXT,
          caption             VARCHAR(255),
          width               INTEGER,
          height              INTEGER,
          is_primary          BOOLEAN NOT NULL DEFAULT FALSE,
          sort_order          INTEGER NOT NULL DEFAULT 0,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

          CONSTRAINT room_media_width_chk CHECK (width IS NULL OR width > 0),
          CONSTRAINT room_media_height_chk CHECK (height IS NULL OR height > 0)
      );
      CREATE INDEX room_media_room_to_hotel_id_idx ON room_media (room_to_hotel_id);
      CREATE INDEX room_media_room_sort_idx ON room_media (room_to_hotel_id, sort_order);
      CREATE UNIQUE INDEX room_media_one_primary_per_room_uq
          ON room_media (room_to_hotel_id) WHERE is_primary = TRUE;
      CREATE TRIGGER trg_room_media_updated_at
          BEFORE UPDATE ON room_media
          FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    `);

    // --------------------------------------------------------- amenities
    await queryRunner.query(`
      CREATE TABLE master_hotel_aminties (
          id              BIGSERIAL PRIMARY KEY,
          name            VARCHAR(150) NOT NULL,
          code            VARCHAR(60),
          category        VARCHAR(80),
          icon            VARCHAR(255),
          type            VARCHAR(20) NOT NULL DEFAULT 'free',
          description     VARCHAR(255),
          is_active       BOOLEAN NOT NULL DEFAULT TRUE,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
          deleted_at      TIMESTAMPTZ,

          CONSTRAINT master_hotel_aminties_name_unique UNIQUE (name),
          CONSTRAINT master_hotel_aminties_code_unique UNIQUE (code),
          CONSTRAINT master_hotel_aminties_type_chk CHECK (type IN ('free', 'paid'))
      );
      CREATE INDEX master_hotel_aminties_category_idx ON master_hotel_aminties (category);
      CREATE INDEX master_hotel_aminties_is_active_idx ON master_hotel_aminties (is_active);
      CREATE TRIGGER trg_master_hotel_aminties_updated_at
          BEFORE UPDATE ON master_hotel_aminties
          FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    `);

    await queryRunner.query(`
      CREATE TABLE master_room_aminties (
          id              BIGSERIAL PRIMARY KEY,
          name            VARCHAR(150) NOT NULL,
          code            VARCHAR(60),
          category        VARCHAR(80),
          icon            VARCHAR(255),
          description     VARCHAR(255),
          is_active       BOOLEAN NOT NULL DEFAULT TRUE,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
          deleted_at      TIMESTAMPTZ,

          CONSTRAINT master_room_aminties_name_unique UNIQUE (name),
          CONSTRAINT master_room_aminties_code_unique UNIQUE (code)
      );
      CREATE INDEX master_room_aminties_category_idx ON master_room_aminties (category);
      CREATE INDEX master_room_aminties_is_active_idx ON master_room_aminties (is_active);
      CREATE TRIGGER trg_master_room_aminties_updated_at
          BEFORE UPDATE ON master_room_aminties
          FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    `);

    await queryRunner.query(`
      CREATE TABLE hotel_aminties_to_hotel (
          id                  BIGSERIAL PRIMARY KEY,
          hotel_id            BIGINT NOT NULL REFERENCES master_hotel(id) ON DELETE CASCADE,
          hotel_amenity_id    BIGINT NOT NULL REFERENCES master_hotel_aminties(id) ON DELETE CASCADE,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

          CONSTRAINT hotel_aminties_to_hotel_unique UNIQUE (hotel_id, hotel_amenity_id)
      );
      CREATE INDEX hotel_aminties_to_hotel_hotel_id_idx ON hotel_aminties_to_hotel (hotel_id);
      CREATE INDEX hotel_aminties_to_hotel_amenity_id_idx ON hotel_aminties_to_hotel (hotel_amenity_id);
    `);

    await queryRunner.query(`
      CREATE TABLE room_aminities_to_room (
          id                  BIGSERIAL PRIMARY KEY,
          room_to_hotel_id    BIGINT NOT NULL REFERENCES room_to_hotel(id) ON DELETE CASCADE,
          room_amenity_id     BIGINT NOT NULL REFERENCES master_room_aminties(id) ON DELETE CASCADE,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

          CONSTRAINT room_aminties_to_room_unique UNIQUE (room_to_hotel_id, room_amenity_id)
      );
      CREATE INDEX room_aminties_to_room_room_id_idx ON room_aminities_to_room (room_to_hotel_id);
      CREATE INDEX room_aminties_to_room_amenity_id_idx ON room_aminities_to_room (room_amenity_id);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS room_aminities_to_room;`);
    await queryRunner.query(`DROP TABLE IF EXISTS hotel_aminties_to_hotel;`);
    await queryRunner.query(`DROP TABLE IF EXISTS master_room_aminties;`);
    await queryRunner.query(`DROP TABLE IF EXISTS master_hotel_aminties;`);
    await queryRunner.query(`DROP TABLE IF EXISTS room_media;`);
    await queryRunner.query(`DROP TABLE IF EXISTS room_to_hotel;`);
    await queryRunner.query(`DROP TABLE IF EXISTS master_room;`);
    await queryRunner.query(`DROP TABLE IF EXISTS hotel_media;`);
    await queryRunner.query(`DROP TABLE IF EXISTS hotel_details;`);
    await queryRunner.query(`DROP TABLE IF EXISTS master_hotel;`);
    await queryRunner.query(`DROP TABLE IF EXISTS master_city;`);
    await queryRunner.query(`DROP TABLE IF EXISTS master_state;`);
    await queryRunner.query(`DROP TABLE IF EXISTS master_country;`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS set_updated_at();`);
  }
}
