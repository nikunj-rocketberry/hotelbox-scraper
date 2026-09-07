/**
 * One-off CLI to seed a country + state before running the scrape pipeline,
 * without needing the API process up. Prints the resulting ids.
 *
 * Usage:
 *   npm run seed:geo -- --country "India" --iso2 IN --iso3 IND --state "Rajasthan"
 */
import { AppDataSource } from '../src/database/data-source';
import { GeoRepository } from '../src/ingestion/geo.repository';

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx === -1 ? undefined : process.argv[idx + 1];
}

async function main() {
  const country = arg('country');
  const iso2 = arg('iso2');
  const iso3 = arg('iso3');
  const state = arg('state');

  if (!country || !iso2 || !iso3 || !state) {
    console.error('Usage: npm run seed:geo -- --country "India" --iso2 IN --iso3 IND --state "Rajasthan"');
    process.exit(1);
  }

  await AppDataSource.initialize();
  const geoRepository = new GeoRepository();

  const { countryId, stateId } = await AppDataSource.transaction(async (manager) => {
    const countryId = await geoRepository.upsertCountry(manager, { name: country, iso2, iso3 });
    const stateId = await geoRepository.upsertState(manager, { countryId, name: state });
    return { countryId, stateId };
  });

  console.log(JSON.stringify({ countryId, stateId }, null, 2));
  await AppDataSource.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
