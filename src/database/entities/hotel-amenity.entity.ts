import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('master_hotel_aminties')
export class HotelAmenityEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ length: 150 })
  name: string;

  @Column({ length: 60, nullable: true })
  code?: string;

  @Column({ length: 80, nullable: true })
  category?: string;

  @Column({ length: 255, nullable: true })
  icon?: string;

  @Column({ length: 20, default: 'free' })
  type: 'free' | 'paid';

  @Column({ length: 255, nullable: true })
  description?: string;

  @Column({ name: 'is_active', default: true })
  isActive: boolean;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date;
}
