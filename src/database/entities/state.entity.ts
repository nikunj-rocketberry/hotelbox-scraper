import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('master_state')
export class StateEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ name: 'country_id', type: 'bigint' })
  countryId: string;

  @Column({ length: 150 })
  name: string;

  @Column({ name: 'state_code', length: 10, nullable: true })
  stateCode?: string;

  @Column({ name: 'is_active', default: true })
  isActive: boolean;
}
