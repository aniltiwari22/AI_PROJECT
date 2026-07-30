const crypto = require('crypto');

/**
 * Password hashing with scrypt from node:crypto.
 *
 * No bcrypt/argon2 dependency: both are native modules, and scrypt is in the
 * standard library, memory-hard, and designed for exactly this. The previous
 * implementation compared a plaintext password to the literal string 'codex'.
 *
 * Stored format:  scrypt$N$r$p$<salt-hex>$<hash-hex>
 * The parameters travel with the hash so they can be raised later without
 * invalidating existing passwords.
 */

// ~100 ms per verification on this class of machine. Slow enough to make
// offline guessing expensive, fast enough that login does not feel broken.
const PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password, params = PARAMS) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }

  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    // scrypt needs memory proportional to N*r*128; the default 32MB cap
    // rejects these parameters outright.
    maxmem: 256 * 1024 * 1024
  });

  return [
    'scrypt', params.N, params.r, params.p,
    salt.toString('hex'), derived.toString('hex')
  ].join('$');
}

function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;

  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, N, r, p, saltHex, hashHex] = parts;
  let expected;
  let actual;

  try {
    expected = Buffer.from(hashHex, 'hex');
    actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
      maxmem: 256 * 1024 * 1024
    });
  } catch {
    return false;
  }

  // Constant-time: a plain === leaks how much of the hash matched via timing.
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

module.exports = { hashPassword, verifyPassword, PARAMS };
