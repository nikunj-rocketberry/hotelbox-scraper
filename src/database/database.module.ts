import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { allEntities } from './entities';
import { AppConfig } from '../config/configuration';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => ({
        type: 'postgres',
        host: config.get('db.host', { infer: true }),
        port: config.get('db.port', { infer: true }),
        username: config.get('db.username', { infer: true }),
        password: config.get('db.password', { infer: true }),
        database: config.get('db.database', { infer: true }),
        entities: allEntities,
        synchronize: false,
        migrationsRun: false,
        logging: false,
      }),
    }),
    TypeOrmModule.forFeature(allEntities),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
