import { createHash } from 'node:crypto';
import { attachmentPayload } from './download-recovery.ts';
import { ContractError } from '../contracts/screens.ts';

/** Called after the application seed reset, which removes all blob references.
 * Delete only the two deterministic benchmark objects, never a bucket or a
 * whole prefix. A Postgres reset alone leaves MinIO content-addressed objects. */
export async function prepareAttachmentObjects() {
  const { S3Client } = await import('bun');
  const config = { endpoint: 'http://localhost:3230', region: 'us-east-1', bucket: 'syncular-blobs', accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' };
  const store = new S3Client(config);
  const objects = [];
  for (const variant of [0, 1] as const) {
    const sha256 = createHash('sha256').update(attachmentPayload(variant)).digest('hex');
    const key = `blob/bench/sha256/${sha256}`;
    const presentBefore = await store.exists(key);
    if (presentBefore) await store.delete(key);
    const presentAfter = await store.exists(key);
    objects.push({ variant, blobId: `sha256:${sha256}`, key, presentBefore, presentAfter });
    if (presentAfter) throw new ContractError('Benchmark object still exists after preparation');
  }
  return { method: 'remove-declared-objects-after-application-reset-v1', endpoint: config.endpoint, bucket: config.bucket, region: config.region, objects };
}
