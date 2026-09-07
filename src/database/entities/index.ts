export * from './country.entity';
export * from './state.entity';
export * from './city.entity';
export * from './hotel.entity';
export * from './hotel-details.entity';
export * from './hotel-media.entity';
export * from './room.entity';
export * from './room-to-hotel.entity';
export * from './room-media.entity';
export * from './hotel-amenity.entity';
export * from './room-amenity.entity';
export * from './hotel-amenity-to-hotel.entity';
export * from './room-amenity-to-room.entity';

import { CountryEntity } from './country.entity';
import { StateEntity } from './state.entity';
import { CityEntity } from './city.entity';
import { HotelEntity } from './hotel.entity';
import { HotelDetailsEntity } from './hotel-details.entity';
import { HotelMediaEntity } from './hotel-media.entity';
import { RoomEntity } from './room.entity';
import { RoomToHotelEntity } from './room-to-hotel.entity';
import { RoomMediaEntity } from './room-media.entity';
import { HotelAmenityEntity } from './hotel-amenity.entity';
import { RoomAmenityEntity } from './room-amenity.entity';
import { HotelAmenityToHotelEntity } from './hotel-amenity-to-hotel.entity';
import { RoomAmenityToRoomEntity } from './room-amenity-to-room.entity';

/** Explicit list (not Object.values on the star-exports) so enum exports never leak in as "entities". */
export const allEntities = [
  CountryEntity,
  StateEntity,
  CityEntity,
  HotelEntity,
  HotelDetailsEntity,
  HotelMediaEntity,
  RoomEntity,
  RoomToHotelEntity,
  RoomMediaEntity,
  HotelAmenityEntity,
  RoomAmenityEntity,
  HotelAmenityToHotelEntity,
  RoomAmenityToRoomEntity,
];
