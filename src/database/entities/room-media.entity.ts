import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('room_media')
export class RoomMediaEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ name: 'room_to_hotel_id', type: 'bigint' })
  roomToHotelId: string;

  @Column({ name: 'media_url', length: 1024 })
  mediaUrl: string;

  @Column({ name: 's3_key', length: 1024, nullable: true })
  s3Key?: string;

  @Column({ name: 'source_url', type: 'text', nullable: true })
  sourceUrl?: string;

  @Column({ length: 255, nullable: true })
  caption?: string;

  @Column({ type: 'integer', nullable: true })
  width?: number;

  @Column({ type: 'integer', nullable: true })
  height?: number;

  @Column({ name: 'is_primary', default: false })
  isPrimary: boolean;

  @Column({ name: 'sort_order', type: 'integer', default: 0 })
  sortOrder: number;
}
