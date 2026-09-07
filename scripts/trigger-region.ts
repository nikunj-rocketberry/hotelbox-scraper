/**
 * CLI alternative to `POST /scrape/region` — seeds/gets the country+state
 * and enqueues the region-discovery job directly against Redis, without
 * needing the API process running.
 *
 * Usage:
 *   npm run scrape:region -- --country "India" --iso2 IN --iso3 IND --state "Rajasthan"
 *
 * Requires a worker process running (`npm run start:worker`) to actually
 * pick the job up — this only enqueues it.
 */
import * as dotenv from 'dotenv';
import { Queue } from 'bullmq';
import { AppDataSource } from '../src/database/data-source';
import { GeoRepository } from '../src/ingestion/geo.repository';
import { QUEUE_REGION_DISCOVERY, RegionDiscoveryJob } from '../src/queue/queue.constants';

dotenv.config();

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx === -1 ? undefined : process.argv[idx + 1];
}

async function main() {
  const countryName = arg('country');
  const iso2 = arg('iso2');
  const iso3 = arg('iso3');
  const stateName = arg('state');

  if (!countryName || !iso2 || !iso3 || !stateName) {
    console.error('Usage: npm run scrape:region -- --country "India" --iso2 IN --iso3 IND --state "Rajasthan"');
    process.exit(1);
  }

  await AppDataSource.initialize();
  const geoRepository = new GeoRepository();

  const { countryId, stateId } = await AppDataSource.transaction(async (manager) => {
    const countryId = await geoRepository.upsertCountry(manager, { name: countryName, iso2, iso3 });
    const stateId = await geoRepository.upsertState(manager, { countryId, name: stateName });
    return { countryId, stateId };
  });

  const queue = new Queue<RegionDiscoveryJob>(QUEUE_REGION_DISCOVERY, {
    connection: { host: process.env.REDIS_HOST ?? 'localhost', port: Number(process.env.REDIS_PORT ?? 6379) },
  });

  const job = await queue.add(
    'discover-cities',
    { countryId, countryName, countryIso2: iso2, stateId, stateName },
    { jobId: `region-${stateId}` },
  );

  console.log(JSON.stringify({ jobId: job.id, countryId, stateId }, null, 2));
  console.log('Enqueued. Make sure a worker is running (npm run start:worker) to process it.');
  console.log('Watch progress at http://localhost:3000/admin/queues or `curl http://localhost:3000/scrape/status`.');

  await queue.close();
  await AppDataSource.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
