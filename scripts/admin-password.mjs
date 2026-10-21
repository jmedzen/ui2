#!/usr/bin/env node
/**
 * Manage the admin password used by the ui2 web UI.
 *
 * The password itself is never written to disk. This script prompts for it with
 * terminal echo disabled and stores only a scrypt hash:
 *
 *   scrypt:<N>:<r>:<p>:<keylen>:<base64url salt>:<base64url hash>
 *
 * Examples:
 *   node scripts/admin-password.mjs
 *   node scripts/admin-password.mjs --check
 *   node scripts/admin-password.mjs --hash
 *   printf '%s\n' 'correct horse battery staple' | node scripts/admin-password.mjs --stdin
 *   node scripts/admin-password.mjs --delete
 *
 * Inside Docker, run as the app user so the 0600 file remains readable:
 *   docker compose exec -it -u node ui2 node scripts/admin-password.mjs
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_N = 32768;
const DEFAULT_R = 8;
const DEFAULT_P = 1;
const DEFAULT_KEYLEN = 64;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 256;
const MIN_N = 1 << 14;
const MAX_N = 1 << 16;
const MAX_R = 16;
const MAX_P = 4;
const MIN_KEYLEN = 32;
const MAX_KEYLEN = 128;
const MAX_MEMORY = 128 * 1024 * 1024;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const BASE32_LOOKUP = new Map(
  [...BASE32_ALPHABET].map((character, index) => [character, index])
);

function usage() {
  console.log(`Usage: node scripts/admin-password.mjs [options]

Manage the ui2 admin password. With no options, prompts twice and writes the
hash to data/admin.json (mode 0600).

Options:
  --hash             Print a scrypt hash instead of writing a file
  --check            Validate the configured credential and file permissions
  --delete           Delete the credential file
  --enable-totp      Generate and store a TOTP secret, then print its otpauth URI
  --disable-totp     Remove TOTP from the credential file (recovery)
  --file <path>      Use this credential file instead of data/admin.json
  --stdin            Read the password from stdin (one line, no confirmation)
  --force            Write the file even when an environment credential is set
  --help             Show this help

Environment (read precedence, highest first):
  ADMIN_PASSWORD_HASH        A raw scrypt hash; takes precedence over files
  ADMIN_PASSWORD_HASH_FILE   A file containing only the raw hash
  ADMIN_PASSWORD_FILE        Credential JSON path (default: data/admin.json)
  ADMIN_TOTP_SECRET          Optional base32 TOTP secret; overrides the file

Do not pass a password as a command-line argument; it would be visible in the
process list and shell history.
`);
}

function parseArgs(argv) {
  const options = {
    mode: 'set',
    file: (process.env.ADMIN_PASSWORD_FILE || '').trim() || '',
    stdin: false,
    force: false,
    help: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--hash') options.mode = 'hash';
    else if (arg === '--check') options.mode = 'check';
    else if (arg === '--delete') options.mode = 'delete';
    else if (arg === '--enable-totp') options.mode = 'enable-totp';
    else if (arg === '--disable-totp') options.mode = 'disable-totp';
    else if (arg === '--stdin') options.stdin = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--file') {
      const value = argv[++i];
      if (!value) throw new Error('--file requires a path');
      options.file = value;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function credentialFile(options) {
  if (options.file) return path.resolve(options.file);
  return path.join(process.cwd(), 'data', 'admin.json');
}

function envCredentialConfigured() {
  return Boolean(
    (process.env.ADMIN_PASSWORD_HASH || '').trim() ||
      (process.env.ADMIN_PASSWORD_HASH_FILE || '').trim()
  );
}

function fail(message) {
  console.error(`❌ ${message}`);
  process.exitCode = 1;
}

function validatePassword(password) {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new Error(`Password must be at most ${MAX_PASSWORD_LENGTH} characters.`);
  }
  if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(password)) {
    throw new Error('Password must not contain control characters (including newlines).');
  }
}

function readStdinPassword() {
  if (process.stdin.isTTY) {
    throw new Error('--stdin requires a pipe or redirected input, not a terminal.');
  }
  const raw = fs.readFileSync(0, 'utf8');
  // One line is the contract. Do not silently accept a file full of extra
  // content as a password.
  const password = raw.split(/\r?\n/, 1)[0] ?? '';
  return password;
}

function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;

    if (!stdin.isTTY) {
      reject(new Error('Cannot prompt without a TTY; use --stdin for automation.'));
      return;
    }

    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let value = '';
    let settled = false;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      stdin.removeListener('data', onData);
      try {
        stdin.setRawMode(false);
      } catch {}
      stdin.pause();
    };

    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          cleanup();
          stdout.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u0003') {
          cleanup();
          stdout.write('\n');
          reject(new Error('Cancelled.'));
          return;
        }
        if (char === '\u007f' || char === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            stdout.write('\b \b');
          }
          continue;
        }
        value += char;
        stdout.write('*');
      }
    };

    stdin.on('data', onData);
  });
}

async function promptForPassword(options) {
  if (options.stdin) {
    const password = readStdinPassword();
    validatePassword(password);
    return password;
  }

  const password = await readHidden('New admin password: ');
  validatePassword(password);
  const confirmation = await readHidden('Confirm password: ');
  if (password !== confirmation) throw new Error('Passwords do not match.');
  return password;
}

function maxmem(N, r, p) {
  const required = 128 * N * r + 128 * r * p + 1024;
  return Math.max(64 * 1024 * 1024, Math.min(MAX_MEMORY * 2, required * 2));
}

function createHash(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, DEFAULT_KEYLEN, {
    N: DEFAULT_N,
    r: DEFAULT_R,
    p: DEFAULT_P,
    maxmem: maxmem(DEFAULT_N, DEFAULT_R, DEFAULT_P)
  });
  return [
    'scrypt',
    String(DEFAULT_N),
    String(DEFAULT_R),
    String(DEFAULT_P),
    String(DEFAULT_KEYLEN),
    salt.toString('base64url'),
    hash.toString('base64url')
  ].join(':');
}

function base32Encode(bytes) {
  let bits = 0;
  let accumulator = 0;
  let output = '';
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += BASE32_ALPHABET[(accumulator >>> bits) & 31];
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(accumulator << (5 - bits)) & 31];
  return output;
}

function normalizeTotpSecret(value) {
  return String(value || '')
    .trim()
    .replace(/[\s-]/g, '')
    .replace(/=+$/g, '')
    .toUpperCase();
}

function parseTotpSecret(value) {
  const secret = normalizeTotpSecret(value);
  if (!secret) throw new Error('TOTP secret is empty');

  let bits = 0;
  let accumulator = 0;
  const bytes = [];
  for (const character of secret) {
    const index = BASE32_LOOKUP.get(character);
    if (index === undefined) throw new Error('TOTP secret must be base32 (A-Z and 2-7)');
    accumulator = (accumulator << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >>> bits) & 0xff);
    }
  }
  if (bytes.length < 10) throw new Error('TOTP secret must decode to at least 10 bytes');
  return secret;
}

function generateTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function buildTotpUri(secret) {
  const issuer = 'Fayun UI2';
  const account = 'admin';
  const query = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30'
  });
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?${query.toString()}`;
}

function parseHash(value) {
  const parts = String(value || '').trim().split(':');
  if (parts.length !== 7 || parts[0] !== 'scrypt') {
    throw new Error('expected scrypt:N:r:p:keylen:salt:hash');
  }
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const keylen = Number(parts[4]);
  if (!Number.isInteger(N) || N < MIN_N || N > MAX_N || (N & (N - 1)) !== 0) {
    throw new Error(`N must be a power of two between ${MIN_N} and ${MAX_N}`);
  }
  if (!Number.isInteger(r) || r < 1 || r > MAX_R) throw new Error(`r must be 1-${MAX_R}`);
  if (!Number.isInteger(p) || p < 1 || p > MAX_P) throw new Error(`p must be 1-${MAX_P}`);
  if (!Number.isInteger(keylen) || keylen < MIN_KEYLEN || keylen > MAX_KEYLEN) {
    throw new Error(`keylen must be ${MIN_KEYLEN}-${MAX_KEYLEN}`);
  }
  if (128 * N * r > MAX_MEMORY) throw new Error('scrypt parameters exceed the memory budget');
  if (!BASE64URL.test(parts[5]) || !BASE64URL.test(parts[6])) {
    throw new Error('salt and hash must be base64url');
  }
  const salt = Buffer.from(parts[5], 'base64url');
  const hash = Buffer.from(parts[6], 'base64url');
  if (salt.length < 16 || salt.length > 64) throw new Error('salt must be 16-64 bytes');
  if (hash.length !== keylen) throw new Error('hash length does not match keylen');
  return { N, r, p, keylen, salt, hash };
}

function readCredentialForCheck(options) {
  const envTotp = normalizeTotpSecret(process.env.ADMIN_TOTP_SECRET || '');
  if (envTotp) parseTotpSecret(envTotp);

  const envHash = (process.env.ADMIN_PASSWORD_HASH || '').trim();
  if (envHash) {
    return { source: 'ADMIN_PASSWORD_HASH', hash: envHash, file: null, totpSecret: envTotp || null };
  }

  const envHashFile = (process.env.ADMIN_PASSWORD_HASH_FILE || '').trim();
  if (envHashFile) {
    const file = path.resolve(envHashFile);
    const hash = fs.readFileSync(file, 'utf8').trim();
    return {
      source: 'ADMIN_PASSWORD_HASH_FILE',
      hash,
      file,
      totpSecret: envTotp || null
    };
  }

  const file = credentialFile(options);
  const raw = fs.readFileSync(file, 'utf8').trim();
  let hash = raw;
  let totpSecret = envTotp || null;
  let totpUpdatedAt = null;
  if (raw.startsWith('{')) {
    const parsed = JSON.parse(raw);
    if (parsed.version !== undefined && parsed.version !== 1) {
      throw new Error(`${file} has an unsupported version`);
    }
    if (typeof parsed.passwordHash !== 'string') {
      throw new Error(`${file} does not contain passwordHash`);
    }
    hash = parsed.passwordHash.trim();
    if (parsed.totpSecret !== undefined && parsed.totpSecret !== null) {
      if (typeof parsed.totpSecret !== 'string') {
        throw new Error(`${file} has a non-string totpSecret`);
      }
      const fileTotp = parseTotpSecret(parsed.totpSecret);
      if (!envTotp) totpSecret = fileTotp;
      totpUpdatedAt =
        typeof parsed.totpUpdatedAt === 'string' ? parsed.totpUpdatedAt : null;
    }
  }
  return { source: 'ADMIN_PASSWORD_FILE', hash, file, totpSecret, totpUpdatedAt };
}

function readExistingCredentialFile(file) {
  const raw = fs.readFileSync(file, 'utf8').trim();
  if (!raw.startsWith('{')) {
    return { hash: raw, totpSecret: null, totpUpdatedAt: null };
  }
  const parsed = JSON.parse(raw);
  if (parsed.version !== undefined && parsed.version !== 1) {
    throw new Error(`${file} has an unsupported version`);
  }
  if (typeof parsed.passwordHash !== 'string') {
    throw new Error(`${file} does not contain passwordHash`);
  }
  let totpSecret = null;
  let totpUpdatedAt = null;
  if (parsed.totpSecret !== undefined && parsed.totpSecret !== null) {
    if (typeof parsed.totpSecret !== 'string') {
      throw new Error(`${file} has a non-string totpSecret`);
    }
    totpSecret = parseTotpSecret(parsed.totpSecret);
    totpUpdatedAt =
      typeof parsed.totpUpdatedAt === 'string' ? parsed.totpUpdatedAt : null;
  }
  return { hash: parsed.passwordHash.trim(), totpSecret, totpUpdatedAt };
}

function fileModeWarning(file) {
  if (process.platform === 'win32' || !file) return null;
  try {
    const mode = fs.statSync(file).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      return `file mode is ${mode.toString(8)}; chmod 600 is recommended`;
    }
  } catch {}
  return null;
}

function writeCredentialFile(file, hash, totpSecret = null, totpUpdatedAt = null) {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    throw new Error(
      'Refusing to write as root: the app runs as the unprivileged node user and ' +
        'would not be able to read a root-owned 0600 file. Re-run with ' +
        '"docker compose exec -it -u node ui2 node scripts/admin-password.mjs" ' +
        'or as the application user.'
    );
  }

  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const payload = JSON.stringify(
    {
      version: 1,
      algorithm: 'scrypt',
      passwordHash: hash,
      ...(totpSecret ? { totpSecret } : {}),
      ...(totpSecret && totpUpdatedAt ? { totpUpdatedAt } : {}),
      updatedAt: new Date().toISOString()
    },
    null,
    2
  ) + '\n';

  const temp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  );

  const handle = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(handle, payload, 'utf8');
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }

  fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  if (options.mode === 'check') {
    const credential = readCredentialForCheck(options);
    parseHash(credential.hash);
    console.log(`✅ Credential is valid (source: ${credential.source}).`);
    console.log(`   TOTP 2FA: ${credential.totpSecret ? 'enabled' : 'disabled'}.`);
    if (process.env.ADMIN_TOTP_SECRET?.trim()) {
      console.log('   TOTP source: ADMIN_TOTP_SECRET (overrides the credential file).');
    } else if (credential.totpSecret) {
      console.log('   TOTP source: credential file.');
    }
    if (credential.file) {
      const warning = fileModeWarning(credential.file);
      if (warning) console.warn(`⚠️  ${credential.file}: ${warning}`);
      else console.log(`   ${credential.file} has restrictive permissions.`);
    }
    return;
  }

  if (options.mode === 'delete') {
    const file = credentialFile(options);
    try {
      fs.unlinkSync(file);
      console.log(`🗑️  Deleted ${file}.`);
    } catch (e) {
      if (e?.code === 'ENOENT') console.log(`ℹ️  ${file} does not exist; nothing to delete.`);
      else throw e;
    }
    if (envCredentialConfigured()) {
      console.warn(
        '⚠️  ADMIN_PASSWORD_HASH / ADMIN_PASSWORD_HASH_FILE is still set and takes precedence; ' +
          'delete that environment variable too if you intend to disable password login.'
      );
    }
    return;
  }

  if (options.mode === 'enable-totp' || options.mode === 'disable-totp') {
    if (process.env.ADMIN_TOTP_SECRET?.trim()) {
      throw new Error(
        'ADMIN_TOTP_SECRET is set and overrides the credential file. Unset it first, ' +
          'or update the deployment environment if that is your intended TOTP source.'
      );
    }
    if (envCredentialConfigured() && !options.force) {
      throw new Error(
        'ADMIN_PASSWORD_HASH or ADMIN_PASSWORD_HASH_FILE is set and takes precedence over the ' +
          'file. Re-run with --force to update the file anyway, or unset the environment variable.'
      );
    }

    const file = credentialFile(options);
    const existing = readExistingCredentialFile(file);

    if (options.mode === 'disable-totp') {
      if (!existing.totpSecret) {
        console.log(`ℹ️  TOTP is not enabled in ${file}; nothing to disable.`);
        return;
      }
      writeCredentialFile(file, existing.hash, null, null);
      console.log(`✅ TOTP disabled for ${file}.`);
      console.log('   The running app reads the file on the next request; no restart is required.');
      return;
    }

    const secret = generateTotpSecret();
    writeCredentialFile(file, existing.hash, secret, new Date().toISOString());
    const uri = buildTotpUri(secret);
    console.log(`✅ TOTP enabled for ${file}.`);
    console.log(`   Secret (add manually): ${secret}`);
    console.log(`   otpauth URI: ${uri}`);
    console.log('   Store this secret securely; it is shown once by this command.');
    console.log('   Recovery: rerun this script with --disable-totp on the server.');
    return;
  }

  const password = await promptForPassword(options);
  const hash = createHash(password);

  if (options.mode === 'hash') {
    console.log(hash);
    return;
  }

  if (envCredentialConfigured() && !options.force) {
    throw new Error(
      'ADMIN_PASSWORD_HASH or ADMIN_PASSWORD_HASH_FILE is set and takes precedence over the ' +
        'file. Re-run with --force to write the file anyway, or unset the environment variable.'
    );
  }

  const file = credentialFile(options);
  let existing = { totpSecret: null, totpUpdatedAt: null };
  try {
    existing = readExistingCredentialFile(file);
  } catch (e) {
    if (e?.code !== 'ENOENT') throw e;
  }
  writeCredentialFile(file, hash, existing.totpSecret, existing.totpUpdatedAt);
  console.log(`✅ Admin password updated: ${file} (mode 0600).`);
  console.log('   Existing admin sessions are invalidated immediately (they are bound to the stored hash).');
  console.log(
    existing.totpSecret
      ? '   TOTP 2FA enrollment was preserved.'
      : '   TOTP 2FA is not enabled for this credential.'
  );
  if (process.env.ADMIN_TOTP_SECRET?.trim()) {
    console.log('   Note: ADMIN_TOTP_SECRET is set and remains the active TOTP source.');
  }
  console.log('   The running app reads the file on the next request; no restart is required.');
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
