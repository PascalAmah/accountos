import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHmac,
  createHash,
  timingSafeEqual as nodeTimingSafeEqual,
} from 'crypto';

/**
 * AES-256-GCM encrypt a plaintext string.
 *
 * Uses a random 16-byte IV per encryption call. The output format is:
 *   iv:hex:ciphertext:authTag
 *
 * GCM mode provides both confidentiality and authenticity — tampered
 * ciphertexts will fail decryption rather than producing garbage.
 */
export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return `${iv.toString('hex')}:${encrypted}:${authTag}`;
}

/**
 * AES-256-GCM decrypt a ciphertext produced by `encrypt()`.
 *
 * Input format: iv:hex:ciphertext:authTag
 * Returns the original plaintext, or throws on tampered data / wrong key.
 */
export function decrypt(ciphertext: string, key: Buffer): string {
  const parts = ciphertext.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted payload format');
  }

  const [ivHex, encrypted, authTagHex] = parts;

  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(ivHex, 'hex'),
  );
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Derive a 32-byte AES key from an arbitrary-length passphrase using SHA-256.
 *
 * This allows the ENCRYPTION_KEY env var to be any reasonably-long string
 * while still producing a valid AES-256 key. In production, pass a full
 * 32-byte hex-encoded key directly instead (skip derivation).
 */
export function deriveKey(raw: string): Buffer {
  // If already a 64-char hex string (32 bytes), use it directly
  if (/^[0-9a-f]{64}$/i.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  // Otherwise SHA-256 hash it to produce a deterministic 32-byte key
  return createHash('sha256').update(raw).digest();
}

/**
 * Timing-safe string comparison using crypto.timingSafeEqual.
 * Handles length mismatches by padding — prevents timing attacks that
 * infer secret length from comparison duration.
 */
export function timingSafeCompare(a: string, b: string): boolean {
  // Use a fixed-length HMAC of both values to normalize length
  // This prevents leaking length information via early exit
  const key = randomBytes(32);
  const hmacA = createHmac('sha256', key).update(a).digest();
  const hmacB = createHmac('sha256', key).update(b).digest();
  return nodeTimingSafeEqual(hmacA, hmacB);
}
