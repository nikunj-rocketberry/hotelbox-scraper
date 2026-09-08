import * as dotenv from 'dotenv';
import { Client } from 'minio';

dotenv.config();

async function main() {
  const endpoint = process.env.MINIO_ENDPOINT ?? 'localhost';
  const port = Number(process.env.MINIO_PORT ?? 9000);
  const useSSL = process.env.MINIO_USE_SSL === 'true';
  const accessKey = process.env.MINIO_ACCESS_KEY ?? 'minioadmin';
  const secretKey = process.env.MINIO_SECRET_KEY ?? 'minioadmin';
  const bucket = process.env.MINIO_BUCKET ?? 'hotel-media';

  const client = new Client({
    endPoint: endpoint,
    port,
    useSSL,
    accessKey,
    secretKey,
  });

  const exists = await client.bucketExists(bucket).catch(() => false);
  if (!exists) {
    await client.makeBucket(bucket);
    console.log(`Created bucket "${bucket}"`);
  }

  const policy = {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'PublicRead',
        Effect: 'Allow',
        Principal: '*',
        Action: ['s3:GetObject'],
        Resource: [`arn:aws:s3:::${bucket}/*`],
      },
    ],
  };

  await client.setBucketPolicy(bucket, JSON.stringify(policy));
  console.log(`Successfully updated MinIO bucket "${bucket}" policy to PUBLIC read!`);
  console.log(`Images at http://${endpoint}:${port}/${bucket}/... are now publicly viewable in browser / viewer.`);
}

main().catch((err) => {
  console.error('Failed to set public bucket policy:', err);
  process.exit(1);
});
