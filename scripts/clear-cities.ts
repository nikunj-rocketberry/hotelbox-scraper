import * as dotenv from 'dotenv';
import { AppDataSource } from '../src/database/data-source';

dotenv.config();

async function main() {
  await AppDataSource.initialize();
  console.log('[CleanUp] Database connected.');

  // Count existing cities before deletion
  const countRes = await AppDataSource.query(`SELECT COUNT(*) FROM master_city`);
  const count = countRes[0]?.count ?? 0;

  // Truncate / delete cities with CASCADE so any dependent rows are safely cleared
  await AppDataSource.query(`TRUNCATE TABLE master_city CASCADE`);
  console.log(`[CleanUp] Successfully cleared ${count} cities from master_city table.`);

  await AppDataSource.destroy();
}

main().catch((err) => {
  console.error('Failed to clear cities:', err);
  process.exit(1);
});
