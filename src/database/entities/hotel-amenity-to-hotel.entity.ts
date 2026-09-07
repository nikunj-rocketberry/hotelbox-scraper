import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('hotel_aminties_to_hotel')
export class HotelAmenityToHotelEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ name: 'hotel_id', type: 'bigint' })
  hotelId: string;

  @Column({ name: 'hotel_amenity_id', type: 'bigint' })
  hotelAmenityId: string;
}
