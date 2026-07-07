import { encrypt, decrypt, deriveKey, timingSafeCompare } from './crypto.utils';

describe('crypto.utils', () => {
  const testKey = deriveKey('test-encryption-key-for-unit-tests-only');

  // ── encrypt / decrypt round-trip ─────────────────────────────────────────

  it('round-trips plaintext through encrypt → decrypt', () => {
    const plaintext = 'my-nomba-client-secret';
    const ciphertext = encrypt(plaintext, testKey);
    const decrypted = decrypt(ciphertext, testKey);
    expect(decrypted).toBe(plaintext);
  });

  it('round-trips an empty string', () => {
    const ciphertext = encrypt('', testKey);
    expect(decrypt(ciphertext, testKey)).toBe('');
  });

  it('round-trips a long credential string', () => {
    const long = 'a'.repeat(512);
    expect(decrypt(encrypt(long, testKey), testKey)).toBe(long);
  });

  it('produces different ciphertext on each call (random IV)', () => {
    const plaintext = 'same-input';
    const c1 = encrypt(plaintext, testKey);
    const c2 = encrypt(plaintext, testKey);
    // Both decrypt correctly but are not identical (different IVs)
    expect(c1).not.toBe(c2);
    expect(decrypt(c1, testKey)).toBe(plaintext);
    expect(decrypt(c2, testKey)).toBe(plaintext);
  });

  // ── decrypt rejects bad input ─────────────────────────────────────────────

  it('throws when decrypting with the wrong key', () => {
    const ciphertext = encrypt('secret', testKey);
    const wrongKey = deriveKey('completely-different-key-for-testing');
    expect(() => decrypt(ciphertext, wrongKey)).toThrow();
  });

  it('throws when the auth tag is tampered with (GCM integrity check)', () => {
    const ciphertext = encrypt('secret', testKey);
    const parts = ciphertext.split(':');
    // Flip last char of auth tag
    parts[2] = parts[2].slice(0, -1) + (parts[2].endsWith('0') ? '1' : '0');
    const tampered = parts.join(':');
    expect(() => decrypt(tampered, testKey)).toThrow();
  });

  it('throws on malformed ciphertext (wrong number of segments)', () => {
    expect(() => decrypt('only-two:segments', testKey)).toThrow(
      'Invalid encrypted payload format',
    );
    expect(() => decrypt('one', testKey)).toThrow(
      'Invalid encrypted payload format',
    );
  });

  // ── deriveKey ────────────────────────────────────────────────────────────

  it('returns a 32-byte Buffer for an arbitrary passphrase', () => {
    const key = deriveKey('any-passphrase');
    expect(Buffer.isBuffer(key)).toBe(true);
    expect(key.length).toBe(32);
  });

  it('uses a 64-char hex string directly without hashing', () => {
    const hexKey = 'a'.repeat(64);
    const key = deriveKey(hexKey);
    expect(key).toEqual(Buffer.from(hexKey, 'hex'));
    expect(key.length).toBe(32);
  });

  it('produces the same key for the same passphrase (deterministic)', () => {
    const k1 = deriveKey('consistent-passphrase');
    const k2 = deriveKey('consistent-passphrase');
    expect(k1).toEqual(k2);
  });

  it('produces different keys for different passphrases', () => {
    const k1 = deriveKey('passphrase-one');
    const k2 = deriveKey('passphrase-two');
    expect(k1).not.toEqual(k2);
  });

  // ── timingSafeCompare ────────────────────────────────────────────────────

  it('returns true for equal strings', () => {
    expect(timingSafeCompare('admin-secret', 'admin-secret')).toBe(true);
  });

  it('returns false for different strings', () => {
    expect(timingSafeCompare('admin-secret', 'wrong-secret')).toBe(false);
  });

  it('returns false for strings with the same prefix but different suffix', () => {
    expect(timingSafeCompare('admin-secret-abc', 'admin-secret-xyz')).toBe(false);
  });

  it('returns false for empty string vs non-empty string', () => {
    expect(timingSafeCompare('', 'non-empty')).toBe(false);
    expect(timingSafeCompare('non-empty', '')).toBe(false);
  });

  it('returns true for two empty strings', () => {
    expect(timingSafeCompare('', '')).toBe(true);
  });
});
