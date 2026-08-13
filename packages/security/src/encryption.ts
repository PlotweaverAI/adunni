import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export class EncryptionService {
  private key: Buffer;

  constructor(secret: string) {
    this.key = crypto.createHash('sha256').update(secret).digest();
  }

  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString('base64');
  }

  decrypt(ciphertext: string): string {
    const data = Buffer.from(ciphertext, 'base64');
    const iv = data.subarray(0, IV_LENGTH);
    const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const encrypted = data.subarray(IV_LENGTH + TAG_LENGTH);
    const decipher = crypto.createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  }

  encryptField(value: string | null | undefined): string | null {
    if (value == null) return null;
    return this.encrypt(value);
  }

  decryptField(value: string | null | undefined): string | null {
    if (value == null) return null;
    try {
      return this.decrypt(value);
    } catch {
      return value;
    }
  }

  hashPii(value: string): string {
    return crypto.createHmac('sha256', this.key).update(value).digest('hex');
  }

  generateApiKey(): string {
    return `adk_${crypto.randomBytes(32).toString('hex')}`;
  }

  generateWebhookSecret(): string {
    return crypto.randomBytes(48).toString('base64url');
  }
}
