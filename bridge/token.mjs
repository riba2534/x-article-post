// Pairing token stored at ~/.config/x-article-post/token (0600).
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** XAP_TOKEN_FILE overrides the location (used by tests). */
export function tokenPath() {
  return process.env.XAP_TOKEN_FILE || path.join(os.homedir(), '.config', 'x-article-post', 'token');
}

export async function readToken(file = tokenPath()) {
  try {
    const token = (await readFile(file, 'utf8')).trim();
    return token || null;
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

/** Returns the existing token or creates a new one. */
export async function ensureToken(file = tokenPath()) {
  const existing = await readToken(file);
  if (existing) {
    await chmod(file, 0o600);
    return { token: existing, created: false };
  }
  const token = randomBytes(32).toString('base64url');
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, token + '\n', { mode: 0o600 });
  return { token, created: true };
}

/** Constant-time comparison. */
export function tokenMatches(expected, given) {
  if (typeof given !== 'string' || !given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function maskToken(token) {
  return token.length <= 8 ? '****' : `${token.slice(0, 4)}…${token.slice(-2)}`;
}
