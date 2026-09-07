import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { CatalogRepository } from './catalog.repository';

/** Read-only endpoints backing the /viewer static data browser — no auth, internal tool only. */
@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalog: CatalogRepository) {}

  @Get('countries')
  countries() {
    return this.catalog.listCountries();
  }

  @Get('states')
  states(@Query('countryId') countryId?: string) {
    return this.catalog.listStates(countryId);
  }

  @Get('cities')
  cities(@Query('stateId') stateId?: string, @Query('countryId') countryId?: string) {
    return this.catalog.listCities(stateId, countryId);
  }

  @Get('hotels')
  async hotels(
    @Query('countryId') countryId?: string,
    @Query('stateId') stateId?: string,
    @Query('cityId') cityId?: string,
    @Query('q') q?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const { rows, total } = await this.catalog.listHotels({
      countryId,
      stateId,
      cityId,
      q,
      page: Math.max(1, Number(page) || 1),
      limit: Math.min(100, Math.max(1, Number(limit) || 24)),
    });
    return { hotels: rows, total };
  }

  @Get('hotels/:id')
  async hotelDetail(@Param('id') id: string) {
    const hotel = await this.catalog.getHotel(id);
    if (!hotel) throw new NotFoundException(`No hotel with id ${id}`);

    const [media, amenities, rooms] = await Promise.all([
      this.catalog.getHotelMedia(id),
      this.catalog.getHotelAmenities(id),
      this.catalog.getRooms(id),
    ]);

    return { ...hotel, media, amenities, rooms };
  }
}
