import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullmqModule } from './bullmq.module';
import { QUEUE_CITY_HOTELS, QUEUE_HOTEL_DETAIL, QUEUE_HOTEL_INGEST, QUEUE_REGION_DISCOVERY } from './queue.constants';
import { AppConfig } from '../config/configuration';

const queueFactory = (config: ConfigService<AppConfig, true>) => ({
  defaultJobOptions: {
    attempts: config.get('worker.jobAttempts', { infer: true }),
    backoff: { type: 'exponential' as const, delay: config.get('worker.backoffBaseMs', { infer: true }) },
    // Cap Redis memory growth when scraping tens of thousands of hotels — keep a bounded tail for debugging, not full history.
    removeOnComplete: { count: 2000 },
    removeOnFail: { count: 10000 },
  },
});

// Ingestion retries local I/O (MinIO + Postgres), not a remote scrape — cycles
// faster (shorter backoff) than the scrape queues, which are retrying network
// navigations against Expedia.
const ingestQueueFactory = (config: ConfigService<AppConfig, true>) => ({
  defaultJobOptions: {
    attempts: config.get('ingest.jobAttempts', { infer: true }),
    backoff: { type: 'exponential' as const, delay: config.get('ingest.backoffBaseMs', { infer: true }) },
    removeOnComplete: { count: 2000 },
    removeOnFail: { count: 10000 },
  },
});

@Module({
  imports: [
    BullmqModule,
    BullModule.registerQueueAsync(
      { name: QUEUE_REGION_DISCOVERY, imports: [ConfigModule], inject: [ConfigService], useFactory: queueFactory },
      { name: QUEUE_CITY_HOTELS, imports: [ConfigModule], inject: [ConfigService], useFactory: queueFactory },
      { name: QUEUE_HOTEL_DETAIL, imports: [ConfigModule], inject: [ConfigService], useFactory: queueFactory },
      { name: QUEUE_HOTEL_INGEST, imports: [ConfigModule], inject: [ConfigService], useFactory: ingestQueueFactory },
    ),
  ],
  exports: [BullModule],
})
export class QueueModule {}
