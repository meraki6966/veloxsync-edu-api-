import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'crypto';

const ALGORITHM = 'aes-256-gcm';

function getKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw || raw.length !== 64) {
    throw new Error('ENCRYPTION_KEY env var must be a 64-character hex string (32 bytes)');
  }
  return Buffer.from(raw, 'hex');
}

/**
 * Encrypts a plaintext string with AES-256-GCM.
 * Returns a colon-delimited string: hex(iv):hex(authTag):hex(ciphertext)
 */
export function encryptToken(plaintext: string): string {
  const key  = getKey();
  const iv   = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag   = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypts a value produced by encryptToken().
 * If the stored value does not look encrypted (no colons — legacy plain-text tokens)
 * it is returned as-is so old tokens still work during migration.
 */
export function decryptToken(stored: string): string {
  if (!stored || !stored.includes(':')) return stored;   // backward-compat

  const parts = stored.split(':');
  if (parts.length !== 3) return stored;

  const [ivHex, tagHex, ctHex] = parts;
  try {
    const key        = getKey();
    const iv         = Buffer.from(ivHex, 'hex');
    const authTag    = Buffer.from(tagHex, 'hex');
    const ciphertext = Buffer.from(ctHex, 'hex');
    const decipher   = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return decipher.update(ciphertext).toString('utf8') + decipher.final('utf8');
  } catch {
    throw new Error('Token decryption failed — check ENCRYPTION_KEY or token integrity');
  }
}

/**
 * Constant-time comparison for webhook HMAC signatures.
 * Both inputs must be hex strings of equal length.
 */
export function safeCompare(a: string, b: string): boolean {
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}
