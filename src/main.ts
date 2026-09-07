import 'reflect-metadata';
import * as dotenv from 'dotenv';
dotenv.config(); // must run before any module import below — several @Processor()/@Injectable() files read process.env at import time, not via ConfigService

import { join } from 'path';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { Queue } from 'bullmq';
import { AppModule } from './app.module';
import { QUEUE_CITY_HOTELS, QUEUE_HOTEL_DETAIL, QUEUE_REGION_DISCOVERY } from './queue/queue.constants';
import { AppConfig } from './config/configuration';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableShutdownHooks();
  // Small internal data viewer (read-only, no auth) — see catalog.module.ts for the API it calls.
  app.useStaticAssets(join(process.cwd(), 'public'), { prefix: '/viewer' });
  const config = app.get(ConfigService<AppConfig, true>);

  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath('/admin/queues');
  createBullBoard({
    queues: [QUEUE_REGION_DISCOVERY, QUEUE_CITY_HOTELS, QUEUE_HOTEL_DETAIL].map(
      (name) => new BullMQAdapter(app.get<Queue>(getQueueToken(name))),
    ),
    serverAdapter,
  });
  app.use('/admin/queues', serverAdapter.getRouter());

  const port = config.get('port', { infer: true });
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`API listening on :${port} — dashboard at /admin/queues, data viewer at /viewer`);
}

bootstrap();
