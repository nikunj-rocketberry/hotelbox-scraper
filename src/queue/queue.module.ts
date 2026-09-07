import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullmqModule } from './bullmq.module';
import { QUEUE_CITY_HOTELS, QUEUE_HOTEL_DETAIL, QUEUE_REGION_DISCOVERY } from './queue.constants';
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

@Module({
  imports: [
    BullmqModule,
    BullModule.registerQueueAsync(
      { name: QUEUE_REGION_DISCOVERY, imports: [ConfigModule], inject: [ConfigService], useFactory: queueFactory },
      { name: QUEUE_CITY_HOTELS, imports: [ConfigModule], inject: [ConfigService], useFactory: queueFactory },
      { name: QUEUE_HOTEL_DETAIL, imports: [ConfigModule], inject: [ConfigService], useFactory: queueFactory },
    ),
  ],
  exports: [BullModule],
})
export class QueueModule {}
