import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';

// ============================================================
// Password hashing using Node's built-in scrypt.
// scrypt is memory-hard, resistant to GPU/ASIC brute force, and
// requires no extra npm dependencies. Format: "salt:hash" (both hex).
// ============================================================

const KEY_LEN = 64; // 512-bit key
const SALT_LEN = 16;

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_LEN);
  const hash = scryptSync(password, salt, KEY_LEN);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [saltHex, hashHex] = stored.split(':');
    if (!saltHex || !hashHex) return false;
    const salt = Buffer.from(saltHex, 'hex');
    const hash = Buffer.from(hashHex, 'hex');
    const test = scryptSync(password, salt, KEY_LEN);
    // Constant-time comparison to prevent timing attacks
    return hash.length === test.length && timingSafeEqual(hash, test);
  } catch {
    return false;
  }
}
