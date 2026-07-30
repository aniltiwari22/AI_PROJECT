#!/usr/bin/env node
const { hashPassword } = require('./passwords');

/**
 * Generates the AUTH_PASSWORD_HASH line for .env.
 *
 *   node src/auth/setup.js "your password here"
 *
 * The password is never written anywhere — only the scrypt hash is, and the
 * hash cannot be reversed. Pass it as an argument rather than typing it at a
 * prompt so this works in a non-interactive shell.
 */

const password = process.argv.slice(2).join(' ').trim();

if (!password) {
  console.error('');
  console.error('  Usage: node src/auth/setup.js "new password"');
  console.error('');
  console.error('  Pick something long. This is the only thing standing between');
  console.error('  the internet and every conversation, document and folder the');
  console.error('  assistant can reach.');
  console.error('');
  process.exit(1);
}

if (password.length < 12) {
  console.error('');
  console.error(`  That password is ${password.length} characters. Use at least 12.`);
  console.error('');
  process.exit(1);
}

let hash;
try {
  hash = hashPassword(password);
} catch (error) {
  console.error(`  ${error.message}`);
  process.exit(1);
}

console.log('');
console.log('  Paste this into .env (replace any existing line):');
console.log('');
console.log(`AUTH_PASSWORD_HASH=${hash}`);
console.log('');
console.log('  Then restart the backend. Existing sessions stay valid;');
console.log('  revoke them with POST /api/v1/auth/sessions/revoke-all');
console.log('');
