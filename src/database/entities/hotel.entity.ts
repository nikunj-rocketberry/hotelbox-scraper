import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

export enum HotelStatus {
  INACTIVE = 0,
  ACTIVE = 1,
  DRAFT = 2,
}

@Entity('master_hotel')
export class HotelEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ name: 'last_synced_at', type: 'timestamptz', nullable: true })
  lastSyncedAt?: Date;

  @Column({ name: 'expedia_hotel_id', length: 32, nullable: true })
  expediaHotelId?: string;

  @Column({ length: 255 })
  name: string;

  @Column({ name: 'normalized_name', length: 255, nullable: true })
  normalizedName?: string;

  @Column({ name: 'property_type', length: 60, nullable: true })
  propertyType?: string;

  @Column({ name: 'chain_code', length: 60, nullable: true })
  chainCode?: string;

  @Column({ name: 'chain_name', length: 150, nullable: true })
  chainName?: string;

  @Column({ name: 'brand_code', length: 60, nullable: true })
  brandCode?: string;

  @Column({ name: 'brand_name', length: 150, nullable: true })
  brandName?: string;

  @Column({ type: 'integer', nullable: true })
  rank?: number;

  @Column({ name: 'multi_unit', default: false })
  multiUnit: boolean;

  @Column({ name: 'star_rating', type: 'numeric', precision: 2, scale: 1, nullable: true })
  starRating?: string;

  @Column({ name: 'guest_rating', type: 'numeric', precision: 3, scale: 1, nullable: true })
  guestRating?: string;

  @Column({ name: 'review_count', type: 'integer', default: 0 })
  reviewCount: number;

  @Column({ name: 'country_id', type: 'bigint', nullable: true })
  countryId?: string;

  @Column({ name: 'state_id', type: 'bigint', nullable: true })
  stateId?: string;

  @Column({ name: 'city_id', type: 'bigint', nullable: true })
  cityId?: string;

  @Column({ name: 'address_line1', length: 255, nullable: true })
  addressLine1?: string;

  @Column({ name: 'address_line2', length: 255, nullable: true })
  addressLine2?: string;

  @Column({ name: 'postal_code', length: 20, nullable: true })
  postalCode?: string;

  @Column({ type: 'numeric', precision: 10, scale: 7, nullable: true })
  latitude?: string;

  @Column({ type: 'numeric', precision: 10, scale: 7, nullable: true })
  longitude?: string;

  @Column({ length: 60, nullable: true })
  timezone?: string;

  @Column({ length: 30, nullable: true })
  phone?: string;

  @Column({ length: 30, nullable: true })
  fax?: string;

  @Column({ length: 150, nullable: true })
  email?: string;

  @Column({ length: 255, nullable: true })
  website?: string;

  @Column({ name: 'currency_code', length: 3, nullable: true })
  currencyCode?: string;

  @Column({ type: 'smallint', default: HotelStatus.DRAFT })
  status: HotelStatus;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date;
}
