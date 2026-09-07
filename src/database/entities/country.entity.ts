import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('master_country')
export class CountryEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ length: 100 })
  name: string;

  @Column({ length: 2 })
  iso2: string;

  @Column({ length: 3 })
  iso3: string;

  @Column({ name: 'phone_code', length: 10, nullable: true })
  phoneCode?: string;

  @Column({ name: 'currency_code', length: 3, nullable: true })
  currencyCode?: string;

  @Column({ length: 50, nullable: true })
  region?: string;

  @Column({ name: 'is_active', default: true })
  isActive: boolean;
}
