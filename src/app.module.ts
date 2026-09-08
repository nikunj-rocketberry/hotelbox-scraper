import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { DatabaseModule } from './database/database.module';
import { QueueModule } from './queue/queue.module';
import { TriggerModule } from './trigger/trigger.module';
import { CatalogModule } from './catalog/catalog.module';
import { StorageModule } from './storage/storage.module';

/**
 * API process: enqueues jobs and exposes queue status. Deliberately does NOT
 * import ScraperModule — this process never launches Playwright. Run
 * worker.main.ts (WorkerModule) for that, scaled to as many replicas as you
 * want parallel scraping capacity.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    DatabaseModule,
    QueueModule,
    TriggerModule,
    CatalogModule,
    StorageModule,
  ],
})
export class AppModule {}
