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
    await this.ensureBucketPublic();
  }

  private async ensureBucketPublic(): Promise<void> {
    const policy = {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'PublicRead',
          Effect: 'Allow',
          Principal: '*',
          Action: ['s3:GetObject'],
          Resource: [`arn:aws:s3:::${this.bucket}/*`],
        },
      ],
    };
    try {
      await this.client.setBucketPolicy(this.bucket, JSON.stringify(policy));
      this.logger.log(`Configured MinIO bucket "${this.bucket}" with public-read policy`);
    } catch (err) {
      this.logger.warn(`Failed to set public policy on MinIO bucket "${this.bucket}": ${(err as Error).message}`);
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
