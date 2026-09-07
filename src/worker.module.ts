import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { DatabaseModule } from './database/database.module';
import { ScraperModule } from './scraper/scraper.module';

/**
 * Worker process: runs the Playwright-backed BullMQ processors. This is what
 * you scale horizontally — run N copies (separate OS processes / containers)
 * to increase parallel scraping capacity; each copy also runs WORKER_CONCURRENCY
 * concurrent jobs internally (see .env.example).
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    DatabaseModule,
    ScraperModule,
  ],
})
export class WorkerModule {}
