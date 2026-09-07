import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('master_city')
export class CityEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ name: 'country_id', type: 'bigint' })
  countryId: string;

  @Column({ name: 'state_id', type: 'bigint', nullable: true })
  stateId?: string;

  @Column({ length: 150 })
  name: string;

  @Column({ type: 'numeric', precision: 10, scale: 7, nullable: true })
  latitude?: string;

  @Column({ type: 'numeric', precision: 10, scale: 7, nullable: true })
  longitude?: string;

  @Column({ length: 60, nullable: true })
  timezone?: string;

  @Column({ name: 'is_active', default: true })
  isActive: boolean;
}
