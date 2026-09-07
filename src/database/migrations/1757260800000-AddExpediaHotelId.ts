import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Additive column, not a schema rewrite: master_hotel's identity/conflict key
 * stays `LOWER(TRIM(name))` (see InitSchema) so this doesn't touch anything
 * hotelbox-extranet depends on. This just persists the source id we already
 * scrape but previously discarded after using it for the BullMQ jobId, so
 * later crawls can check "have we already got this exact Expedia listing,
 * and how recently" without a fuzzy name match.
 */
export class AddExpediaHotelId1757260800000 implements MigrationInterface {
  name = 'AddExpediaHotelId1757260800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE master_hotel ADD COLUMN expedia_hotel_id VARCHAR(32);`);
    await queryRunner.query(`CREATE INDEX master_hotel_expedia_hotel_id_idx ON master_hotel (expedia_hotel_id);`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS master_hotel_expedia_hotel_id_idx;`);
    await queryRunner.query(`ALTER TABLE master_hotel DROP COLUMN IF EXISTS expedia_hotel_id;`);
  }
}
