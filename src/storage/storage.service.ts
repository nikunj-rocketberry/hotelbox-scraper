import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from 'minio';
import { randomUUID } from 'crypto';
import { AppConfig } from '../config/configuration';

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: Client;
  private readonly bucket: string;
  private readonly publicUrl: string;

  constructor(private readonly config: ConfigService<AppConfig, true>) {
    const minio = this.config.get('minio', { infer: true });
    this.bucket = minio.bucket;
    this.publicUrl = minio.publicUrl.replace(/\/$/, '');
    this.client = new Client({
      endPoint: minio.endpoint,
      port: minio.port,
      useSSL: minio.useSSL,
      accessKey: minio.accessKey,
      secretKey: minio.secretKey,
    });
  }

  async onModuleInit(): Promise<void> {
    const exists = await this.client.bucketExists(this.bucket).catch(() => false);
    if (!exists) {
      await this.client.makeBucket(this.bucket);
      this.logger.log(`Created MinIO bucket "${this.bucket}"`);
    }
  }

  /**
   * Downloads an image from Expedia's CDN and re-uploads it to MinIO.
   * Never store binary in Postgres — only the returned url/key.
   */
  async uploadFromUrl(sourceUrl: string, keyPrefix: string): Promise<{ url: string; key: string }> {
    const response = await fetch(sourceUrl);
    if (!response.ok) {
      throw new Error(`Fetch failed (${response.status}) for ${sourceUrl}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') ?? 'image/jpeg';
    const extension = contentType.split('/')[1]?.split(';')[0] ?? 'jpg';
    const key = `${keyPrefix}-${randomUUID()}.${extension}`;

    await this.client.putObject(this.bucket, key, buffer, buffer.length, { 'Content-Type': contentType });

    return { url: `${this.publicUrl}/${key}`, key };
  }
}
