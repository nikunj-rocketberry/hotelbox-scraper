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
    console.log(`[Storage Clean] Bucket "${bucket}" does not exist. Creating it...`);
    await client.makeBucket(bucket);
  } else {
    console.log(`[Storage Clean] Scanning MinIO bucket "${bucket}" for objects to delete...`);
    const objectsList: string[] = [];
    const stream = client.listObjects(bucket, '', true);

    for await (const item of stream) {
      if (item.name) {
        objectsList.push(item.name);
      }
    }

    if (objectsList.length > 0) {
      console.log(`[Storage Clean] Deleting ${objectsList.length} files from bucket "${bucket}"...`);
      // Delete in chunks of 500
      const chunkSize = 500;
      for (let i = 0; i < objectsList.length; i += chunkSize) {
        const chunk = objectsList.slice(i, i + chunkSize);
        await client.removeObjects(bucket, chunk);
      }
      console.log(`[Storage Clean] Successfully deleted all ${objectsList.length} objects from MinIO!`);
    } else {
      console.log(`[Storage Clean] Bucket "${bucket}" is already empty.`);
    }
  }

  // Ensure public read policy is maintained
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
  console.log(`[Storage Clean] Verified public read policy on bucket "${bucket}".`);
}

main().catch((err) => {
  console.error('[Storage Clean] Failed to clean MinIO storage:', err);
  process.exit(1);
});
