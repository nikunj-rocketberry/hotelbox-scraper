import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { GeoRepository } from '../ingestion/geo.repository';
import { TriggerController } from './trigger.controller';

@Module({
  imports: [QueueModule],
  controllers: [TriggerController],
  providers: [GeoRepository],
})
export class TriggerModule {}
