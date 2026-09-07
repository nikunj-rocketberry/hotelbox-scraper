import { Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller';
import { CatalogRepository } from './catalog.repository';

@Module({
  controllers: [CatalogController],
  providers: [CatalogRepository],
})
export class CatalogModule {}
