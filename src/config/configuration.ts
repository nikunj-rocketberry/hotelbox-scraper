export interface AppConfig {
  port: number;
  db: {
    host: string;
    port: number;
    username: string;
    password: string;
    database: string;
  };
  redis: {
    host: string;
    port: number;
  };
  minio: {
    endpoint: string;
    port: number;
    useSSL: boolean;
    accessKey: string;
    secretKey: string;
    bucket: string;
    publicUrl: string;
  };
  scraper: {
    expediaBaseUrl: string;
    searchStayNights: number;
    headless: boolean;
    maxContexts: number;
    hotelListMaxPages: number;
    rescrapeFreshnessDays: number;
    blockNonEssentialResources: boolean;
    navJitterMinMs: number;
    navJitterMaxMs: number;
    trafficShaper: {
      enabled: boolean;
      ratePerHour: number;
      burstCapacity: number;
    };
    userDataDir?: string;
    maxHotelMediaCount: number;
    maxRoomMediaCount: number;
  };
  worker: {
    concurrency: number;
    rateLimitMax: number;
    rateLimitDurationMs: number;
    jobAttempts: number;
    backoffBaseMs: number;
  };
  ingest: {
    batchSize: number;
    maxWaitMs: number;
  };
  antiBot: {
    cooldownMs: number;
  };
}

const bool = (value: string | undefined, fallback: boolean): boolean =>
  value === undefined ? fallback : value.toLowerCase() === 'true';

const num = (value: string | undefined, fallback: number): number =>
  value === undefined || value === '' ? fallback : Number(value);

export default (): AppConfig => ({
  port: num(process.env.PORT, 3000),
  db: {
    host: process.env.DB_HOST ?? 'localhost',
    port: num(process.env.DB_PORT, 5439),
    username: process.env.DB_USER ?? 'hotelbox',
    password: process.env.DB_PASSWORD ?? 'hotelbox',
    database: process.env.DB_NAME ?? 'hotelbox',
  },
  redis: {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: num(process.env.REDIS_PORT, 6379),
  },
  minio: {
    endpoint: process.env.MINIO_ENDPOINT ?? 'localhost',
    port: num(process.env.MINIO_PORT, 9000),
    useSSL: bool(process.env.MINIO_USE_SSL, false),
    accessKey: process.env.MINIO_ACCESS_KEY ?? 'minioadmin',
    secretKey: process.env.MINIO_SECRET_KEY ?? 'minioadmin',
    bucket: process.env.MINIO_BUCKET ?? 'hotel-media',
    publicUrl: process.env.MINIO_PUBLIC_URL ?? 'http://localhost:9000/hotel-media',
  },
  scraper: {
    expediaBaseUrl: process.env.EXPEDIA_BASE_URL ?? 'https://www.expedia.co.in',
    searchStayNights: num(process.env.SEARCH_STAY_NIGHTS, 6),
    headless: bool(process.env.PLAYWRIGHT_HEADLESS, true),
    maxContexts: num(process.env.PLAYWRIGHT_MAX_CONTEXTS, 5),
    hotelListMaxPages: num(process.env.HOTEL_LIST_MAX_PAGES, 50),
    rescrapeFreshnessDays: num(process.env.RESCRAPE_FRESHNESS_DAYS, 14),
    blockNonEssentialResources: bool(process.env.PLAYWRIGHT_BLOCK_RESOURCES, true),
    navJitterMinMs: num(process.env.NAV_JITTER_MIN_MS, 200),
    navJitterMaxMs: num(process.env.NAV_JITTER_MAX_MS, 800),
    trafficShaper: {
      enabled: bool(process.env.TRAFFIC_SHAPER_ENABLED, true),
      ratePerHour: num(process.env.TRAFFIC_SHAPER_RATE_PER_HOUR, 1000),
      burstCapacity: num(process.env.TRAFFIC_SHAPER_BURST_CAPACITY, 5),
    },
    userDataDir: process.env.BROWSER_USER_DATA_DIR || undefined,
    maxHotelMediaCount: num(process.env.HOTEL_MAX_MEDIA_COUNT, 10),
    maxRoomMediaCount: num(process.env.ROOM_MAX_MEDIA_COUNT, 3),
  },
  worker: {
    concurrency: num(process.env.WORKER_CONCURRENCY, 5),
    rateLimitMax: num(process.env.RATE_LIMIT_MAX, 20),
    rateLimitDurationMs: num(process.env.RATE_LIMIT_DURATION_MS, 60000),
    jobAttempts: num(process.env.JOB_ATTEMPTS, 5),
    backoffBaseMs: num(process.env.JOB_BACKOFF_BASE_MS, 30000),
  },
  ingest: {
    batchSize: num(process.env.INGEST_BATCH_SIZE, 20),
    maxWaitMs: num(process.env.INGEST_BATCH_MAX_WAIT_MS, 4000),
  },
  antiBot: {
    cooldownMs: num(process.env.ANTI_BOT_COOLDOWN_MS, 30 * 60 * 1000),
  },
});
