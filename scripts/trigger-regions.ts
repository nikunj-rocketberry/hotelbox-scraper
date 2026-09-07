/**
 * Batch version of trigger-region.ts — seeds several regions in one run so
 * multiple destinations are in flight concurrently from the start. All
 * downstream queues (city-hotels, hotel-detail) are shared across regions,
 * so this is what keeps the hotel-detail queue saturated for a sustained
 * throughput test instead of draining to empty between single-region runs.
 *
 * Usage:
 *   npm run scrape:regions -- --file regions.json
 *
 * regions.json:
 *   [
 *     { "country": "India", "iso2": "IN", "iso3": "IND", "state": "Rajasthan" },
 *     { "country": "India", "iso2": "IN", "iso3": "IND", "state": "Kerala" }
 *   ]
 *
 * Requires a worker process running (`npm run start:worker`) to actually
 * pick the jobs up — this only enqueues them.
 */
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import { Queue } from 'bullmq';
import { AppDataSource } from '../src/database/data-source';
import { GeoRepository } from '../src/ingestion/geo.repository';
import { QUEUE_REGION_DISCOVERY, RegionDiscoveryJob } from '../src/queue/queue.constants';

dotenv.config();

interface RegionInput {
  country: string;
  iso2: string;
  iso3: string;
  state: string;
}

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx === -1 ? undefined : process.argv[idx + 1];
}

async function main() {
  const filePath = arg('file');
  if (!filePath) {
    console.error('Usage: npm run scrape:regions -- --file regions.json');
    process.exit(1);
  }

  const regions: RegionInput[] = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!Array.isArray(regions) || regions.length === 0) {
    console.error('regions.json must be a non-empty array of { country, iso2, iso3, state }');
    process.exit(1);
  }

  await AppDataSource.initialize();
  const geoRepository = new GeoRepository();
  const queue = new Queue<RegionDiscoveryJob>(QUEUE_REGION_DISCOVERY, {
    connection: { host: process.env.REDIS_HOST ?? 'localhost', port: Number(process.env.REDIS_PORT ?? 6379) },
  });

  const results = [];
  for (const region of regions) {
    const { countryId, stateId } = await AppDataSource.transaction(async (manager) => {
      const countryId = await geoRepository.upsertCountry(manager, {
        name: region.country,
        iso2: region.iso2,
        iso3: region.iso3,
      });
      const stateId = await geoRepository.upsertState(manager, { countryId, name: region.state });
      return { countryId, stateId };
    });

    const job = await queue.add(
      'discover-cities',
      { countryId, countryName: region.country, countryIso2: region.iso2, stateId, stateName: region.state },
      { jobId: `region-${stateId}` },
    );

    results.push({ jobId: job.id, state: region.state, countryId, stateId });
  }

  console.log(JSON.stringify(results, null, 2));
  console.log(`Enqueued ${results.length} regions. Make sure a worker is running (npm run start:worker) to process them.`);
  console.log('Watch progress at http://localhost:3000/admin/queues or `curl http://localhost:3000/scrape/status`.');

  await queue.close();
  await AppDataSource.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
