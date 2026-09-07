import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('master_room')
export class RoomEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ length: 150 })
  name: string;

  @Column({ length: 50, nullable: true })
  code?: string;

  @Column({ length: 255, nullable: true })
  description?: string;

  @Column({ name: 'is_active', default: true })
  isActive: boolean;
}
