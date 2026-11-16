import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { eq, desc } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service.js';
import { storedFiles } from '../database/schema.js';

@Injectable()
export class FilesService {
  private client?: S3Client;

  constructor(private readonly database: DatabaseService) {}

  async upload(file: Express.Multer.File) {
    const client = this.storage();
    const bucket = this.bucket();
    const id = randomUUID();
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120) || 'upload';
    const objectKey = `crm/${id}/${safeName}`;
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: objectKey, Body: file.buffer, ContentType: file.mimetype }));
    try {
      const [row] = await this.database.db.insert(storedFiles).values({
        objectKey,
        originalName: file.originalname,
        mimeType: file.mimetype || 'application/octet-stream',
        sizeBytes: file.size,
        isPrivate: true,
      }).returning();
      return row;
    } catch (error) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey })).catch(() => undefined);
      throw error;
    }
  }

  list() {
    return this.database.db.select().from(storedFiles).orderBy(desc(storedFiles.createdAt));
  }

  async signedUrl(id: string) {
    const [file] = await this.database.db.select().from(storedFiles).where(eq(storedFiles.id, id)).limit(1);
    if (!file) throw new NotFoundException('File not found');
    const command = new GetObjectCommand({ Bucket: this.bucket(), Key: file.objectKey });
    return { url: await getSignedUrl(this.storage(), command, { expiresIn: 300 }), expiresIn: 300 };
  }

  async remove(id: string) {
    const [file] = await this.database.db.select().from(storedFiles).where(eq(storedFiles.id, id)).limit(1);
    if (!file) throw new NotFoundException('File not found');
    await this.storage().send(new DeleteObjectCommand({ Bucket: this.bucket(), Key: file.objectKey }));
    await this.database.db.delete(storedFiles).where(eq(storedFiles.id, id));
    return { deleted: true, id };
  }

  private bucket() {
    const bucket = process.env.NEON_STORAGE_BUCKET;
    if (!bucket) throw new ServiceUnavailableException('Neon Object Storage is not configured');
    return bucket;
  }

  private storage() {
    if (this.client) return this.client;
    const endpoint = process.env.AWS_ENDPOINT_URL_S3;
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    if (!endpoint || !accessKeyId || !secretAccessKey) {
      throw new ServiceUnavailableException('Neon Object Storage credentials are not configured');
    }
    this.client = new S3Client({
      endpoint,
      region: process.env.AWS_REGION || 'us-west-2',
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
    });
    return this.client;
  }
}
