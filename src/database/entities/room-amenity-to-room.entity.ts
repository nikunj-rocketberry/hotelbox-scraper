import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('room_aminities_to_room')
export class RoomAmenityToRoomEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ name: 'room_to_hotel_id', type: 'bigint' })
  roomToHotelId: string;

  @Column({ name: 'room_amenity_id', type: 'bigint' })
  roomAmenityId: string;
}
