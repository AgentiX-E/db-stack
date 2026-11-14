# Examples

## Custom S3 Storage Backend

```typescript
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import type { IStorageBackend } from '@agentix-e/db-operations-backup';

class S3StorageBackend implements IStorageBackend {
  readonly name = 's3';
  private client: S3Client;

  constructor(private bucket: string, region: string) {
    this.client = new S3Client({ region });
  }

  async upload(sourcePath: string, destKey: string): Promise<void> {
    const fs = await import('fs/promises');
    const body = await fs.readFile(sourcePath);
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: destKey,
      Body: body,
    }));
  }

  async download(sourceKey: string, destPath: string): Promise<void> {
    const response = await this.client.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: sourceKey,
    }));
    const body = await response.Body!.transformToByteArray();
    const fs = await import('fs/promises');
    await fs.writeFile(destPath, Buffer.from(body));
  }

  async list(prefix: string): Promise<Array<{ key: string; size: number; lastModified: string }>> {
    const response = await this.client.send(new ListObjectsV2Command({
      Bucket: this.bucket,
      Prefix: prefix,
    }));
    return (response.Contents ?? []).map(obj => ({
      key: obj.Key!,
      size: obj.Size ?? 0,
      lastModified: obj.LastModified?.toISOString() ?? '',
    }));
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async health() { return { ok: true }; }
  async getUsageBytes() { return 0; }
}
```

## Backup Verification

```typescript
const backup = new InMemoryBackupManager(storage, retention);

// Create backup
const { snapshot } = await backup.createBackup({ type: 'full' });

// Verify it exists
const meta = await backup.getBackup(snapshot!.snapshotId);
console.assert(meta !== null);

// Attempt restore
const restore = await backup.restoreFromSnapshot(snapshot!.snapshotId, {
  skipVerification: true,
});

if (restore.success) {
  console.log(`Recovery point: ${restore.recoveryPoint}`);
} else {
  console.error('Restore failed:', restore.error);
}
```
