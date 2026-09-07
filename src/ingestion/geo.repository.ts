import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

export interface CountryInput {
  name: string;
  iso2: string;
  iso3: string;
  phoneCode?: string;
  currencyCode?: string;
  region?: string;
}

export interface StateInput {
  countryId: string;
  name: string;
  stateCode?: string;
}

export interface CityInput {
  countryId: string;
  stateId?: string;
  name: string;
  latitude?: number;
  longitude?: number;
  timezone?: string;
}

/**
 * Every lookup here is a single atomic INSERT ... ON CONFLICT ... RETURNING id
 * statement, never "SELECT then INSERT" — that's the TOCTOU race that bites
 * you the moment two scrape jobs discover the same country/state/city at once.
 * Postgres serializes concurrent conflicting inserts on the same unique key,
 * so this is safe under N parallel workers with no application-level locking.
 */
@Injectable()
export class GeoRepository {
  async upsertCountry(manager: EntityManager, input: CountryInput): Promise<string> {
    const rows = await manager.query(
      `INSERT INTO master_country (name, iso2, iso3, phone_code, currency_code, region)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (iso2) DO UPDATE SET
         name = EXCLUDED.name,
         iso3 = EXCLUDED.iso3,
         phone_code = COALESCE(EXCLUDED.phone_code, master_country.phone_code),
         currency_code = COALESCE(EXCLUDED.currency_code, master_country.currency_code),
         region = COALESCE(EXCLUDED.region, master_country.region),
         updated_at = now()
       RETURNING id`,
      [input.name, input.iso2.toUpperCase(), input.iso3.toUpperCase(), input.phoneCode ?? null, input.currencyCode ?? null, input.region ?? null],
    );
    return rows[0].id;
  }

  async upsertState(manager: EntityManager, input: StateInput): Promise<string> {
    const rows = await manager.query(
      `INSERT INTO master_state (country_id, name, state_code)
       VALUES ($1, $2, $3)
       ON CONFLICT (country_id, name) DO UPDATE SET
         state_code = COALESCE(EXCLUDED.state_code, master_state.state_code),
         updated_at = now()
       RETURNING id`,
      [input.countryId, input.name, input.stateCode ?? null],
    );
    return rows[0].id;
  }

  async upsertCity(manager: EntityManager, input: CityInput): Promise<string> {
    const rows = await manager.query(
      `INSERT INTO master_city (country_id, state_id, name, latitude, longitude, timezone)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (country_id, state_id, name) DO UPDATE SET
         latitude = COALESCE(EXCLUDED.latitude, master_city.latitude),
         longitude = COALESCE(EXCLUDED.longitude, master_city.longitude),
         timezone = COALESCE(EXCLUDED.timezone, master_city.timezone),
         updated_at = now()
       RETURNING id`,
      [input.countryId, input.stateId ?? null, input.name, input.latitude ?? null, input.longitude ?? null, input.timezone ?? null],
    );
    return rows[0].id;
  }
}
