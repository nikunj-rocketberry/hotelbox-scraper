import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { DataSource } from 'typeorm';
import { allEntities } from './entities';

dotenv.config();

/**
 * Used by the TypeORM CLI (migration:run/generate/revert) and by DatabaseModule
 * at runtime. Keep connection settings identical between the two.
 */
export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5439),
  username: process.env.DB_USER ?? 'hotelbox',
  password: process.env.DB_PASSWORD ?? 'hotelbox',
  database: process.env.DB_NAME ?? 'hotelbox',
  entities: allEntities,
  migrations: [__dirname + '/migrations/*.{ts,js}'],
  synchronize: false,
  logging: process.env.DB_LOGGING === 'true',
});

