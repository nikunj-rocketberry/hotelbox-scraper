import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

export enum RoomToHotelStatus {
  INACTIVE = 0,
  ACTIVE = 1,
}

@Entity('room_to_hotel')
export class RoomToHotelEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ name: 'hotel_id', type: 'bigint' })
  hotelId: string;

  @Column({ name: 'room_id', type: 'bigint', nullable: true })
  roomId?: string;

  @Column({ name: 'room_name', length: 255 })
  roomName: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ name: 'max_occupancy', type: 'smallint', nullable: true })
  maxOccupancy?: number;

  @Column({ name: 'max_adults', type: 'smallint', nullable: true })
  maxAdults?: number;

  @Column({ name: 'max_children', type: 'smallint', nullable: true })
  maxChildren?: number;

  @Column({ name: 'min_adults', type: 'smallint', default: 1 })
  minAdults: number;

  @Column({ name: 'num_bedrooms', type: 'smallint', nullable: true })
  numBedrooms?: number;

  @Column({ name: 'num_bathrooms', type: 'smallint', nullable: true })
  numBathrooms?: number;

  @Column({ name: 'bed_type', length: 100, nullable: true })
  bedType?: string;

  @Column({ name: 'bed_count', type: 'smallint', nullable: true })
  bedCount?: number;

  @Column({ name: 'bed_groups', type: 'jsonb', nullable: true })
  bedGroups?: unknown;

  @Column({ name: 'area_sqm', type: 'numeric', precision: 8, scale: 2, nullable: true })
  areaSqm?: string;

  @Column({ name: 'area_sqft', type: 'numeric', precision: 8, scale: 2, nullable: true })
  areaSqft?: string;

  @Column({ name: 'view_type', length: 100, nullable: true })
  viewType?: string;

  @Column({ name: 'smoking_allowed', type: 'boolean', nullable: true })
  smokingAllowed?: boolean;

  @Column({ type: 'smallint', default: RoomToHotelStatus.ACTIVE })
  status: RoomToHotelStatus;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date;
}
