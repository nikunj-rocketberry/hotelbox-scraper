import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { GeoRepository } from './geo.repository';
import { HotelRepository } from './hotel.repository';
import { RoomRepository } from './room.repository';
import { AmenityRepository } from './amenity.repository';
import { MediaRepository } from './media.repository';
import { IngestionService } from './ingestion.service';
import { BatchIngestionService } from './batch-ingestion.service';

@Module({
  imports: [StorageModule],
  providers: [GeoRepository, HotelRepository, RoomRepository, AmenityRepository, MediaRepository, IngestionService, BatchIngestionService],
  exports: [GeoRepository, HotelRepository, IngestionService, BatchIngestionService],
})
export class IngestionModule {}
