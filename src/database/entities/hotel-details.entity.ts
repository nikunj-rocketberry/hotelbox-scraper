import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('hotel_details')
export class HotelDetailsEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ name: 'hotel_id', type: 'bigint' })
  hotelId: string;

  @Column({ length: 255, nullable: true })
  headline?: string;

  @Column({ name: 'short_description', type: 'text', nullable: true })
  shortDescription?: string;

  @Column({ name: 'full_description', type: 'text', nullable: true })
  fullDescription?: string;

  @Column({ name: 'amenities_summary', type: 'text', nullable: true })
  amenitiesSummary?: string;

  @Column({ name: 'check_in_time', length: 5, nullable: true })
  checkInTime?: string;

  @Column({ name: 'check_out_time', length: 5, nullable: true })
  checkOutTime?: string;

  @Column({ name: 'check_in_instructions', type: 'text', nullable: true })
  checkInInstructions?: string;

  @Column({ name: 'special_instructions', type: 'text', nullable: true })
  specialInstructions?: string;

  @Column({ name: 'min_checkin_age', type: 'smallint', nullable: true })
  minCheckinAge?: number;

  @Column({ name: 'pet_policy', length: 255, nullable: true })
  petPolicy?: string;

  @Column({ name: 'smoking_policy', length: 60, nullable: true })
  smokingPolicy?: string;

  @Column({ name: 'children_policy', type: 'text', nullable: true })
  childrenPolicy?: string;

  @Column({ name: 'extra_bed_policy', type: 'text', nullable: true })
  extraBedPolicy?: string;

  @Column({ name: 'mandatory_fees', type: 'text', nullable: true })
  mandatoryFees?: string;

  @Column({ name: 'optional_fees', type: 'text', nullable: true })
  optionalFees?: string;

  @Column({ name: 'know_before_you_go', type: 'text', nullable: true })
  knowBeforeYouGo?: string;

  @Column({ name: 'total_rooms', type: 'integer', nullable: true })
  totalRooms?: number;

  @Column({ name: 'total_floors', type: 'integer', nullable: true })
  totalFloors?: number;

  @Column({ name: 'year_built', type: 'smallint', nullable: true })
  yearBuilt?: number;

  @Column({ name: 'year_renovated', type: 'smallint', nullable: true })
  yearRenovated?: number;

  @Column({ name: 'spoken_languages', type: 'jsonb', nullable: true })
  spokenLanguages?: unknown;

  @Column({ name: 'payment_types_accepted', type: 'jsonb', nullable: true })
  paymentTypesAccepted?: unknown;

  @Column({ type: 'jsonb', nullable: true })
  themes?: unknown;

  @Column({ type: 'jsonb', nullable: true })
  attributes?: unknown;
}
