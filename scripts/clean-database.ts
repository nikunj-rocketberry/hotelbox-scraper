import * as dotenv from 'dotenv';
import { AppDataSource } from '../src/database/data-source';

dotenv.config();

async function main() {
  const wipeGeo = process.argv.includes('--all');

  await AppDataSource.initialize();
  console.log('[DB Clean] Connected to PostgreSQL database.');

  const hotelCount = await AppDataSource.query(`SELECT COUNT(*) FROM master_hotel`).catch(() => [{ count: 0 }]);
  const cityCount = await AppDataSource.query(`SELECT COUNT(*) FROM master_city`).catch(() => [{ count: 0 }]);
  const mediaCount = await AppDataSource.query(`SELECT COUNT(*) FROM hotel_media`).catch(() => [{ count: 0 }]);
  const roomCount = await AppDataSource.query(`SELECT COUNT(*) FROM master_room`).catch(() => [{ count: 0 }]);

  console.log(`[DB Clean] Current state: ${hotelCount[0]?.count ?? 0} hotels, ${roomCount[0]?.count ?? 0} rooms, ${mediaCount[0]?.count ?? 0} hotel media rows, ${cityCount[0]?.count ?? 0} cities.`);

  if (wipeGeo) {
    console.log('[DB Clean] Wiping ALL tables including states and countries (--all flag provided)...');
    await AppDataSource.query(`
      TRUNCATE TABLE
        hotel_media,
        room_media,
        hotel_aminties_to_hotel,
        room_aminities_to_room,
        hotel_details,
        room_to_hotel,
        master_room,
        master_hotel_aminties,
        master_room_aminties,
        master_hotel,
        master_city,
        master_state,
        master_country
      RESTART IDENTITY CASCADE;
    `);
    console.log('[DB Clean] Successfully cleared all hotel and geographic tables.');
  } else {
    console.log('[DB Clean] Wiping all scraped hotel and city data (preserving countries and states)...');
    await AppDataSource.query(`
      TRUNCATE TABLE
        hotel_media,
        room_media,
        hotel_aminties_to_hotel,
        room_aminities_to_room,
        hotel_details,
        room_to_hotel,
        master_room,
        master_hotel_aminties,
        master_room_aminties,
        master_hotel,
        master_city
      RESTART IDENTITY CASCADE;
    `);
    console.log('[DB Clean] Successfully cleared all scraped hotel and city tables (countries & states retained).');
  }

  await AppDataSource.destroy();
}

main().catch((err) => {
  console.error('[DB Clean] Failed to clean database:', err);
  process.exit(1);
});
