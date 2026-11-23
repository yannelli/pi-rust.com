// WebCrypto helpers: random tokens, hashes, password hashing, constant-time comparison, and
// AES-GCM for TOTP secrets at rest.

const encoder = new TextEncoder();

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  return fromBase64url(text.trim().replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
}

const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

/** A random token with `bytes` bytes of entropy, base64url. 32 bytes is 256 bits. */
export function randomToken(bytes = 32): string {
  return base64url(randomBytes(bytes));
}

/** A random ID for rows and URLs: 128 bits, 22 base64url characters. */
export function randomId(): string {
  return randomToken(16);
}

/** SHA-256 of a token, hex. Tokens with 256 bits of entropy are stored this way. */
export async function sha256(text: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

/** HMAC-SHA256 of `text` with `secret`, as bytes. */
export async function hmac(secret: string, text: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(text)));
}

export async function hmacHex(secret: string, text: string): Promise<string> {
  return hex(await hmac(secret, text));
}

/** Compares two byte strings in time that depends only on their lengths. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export function timingSafeEqualText(a: string, b: string): boolean {
  return timingSafeEqual(encoder.encode(a), encoder.encode(b));
}

// Passwords: PBKDF2-SHA256 over HMAC-SHA256(AUTH_PEPPER, password). 100,000 iterations is the most
// the Workers runtime allows. The stored string names the algorithm, iterations, and pepper, so a
// later change can rehash each password at its next sign-in.
const PASSWORD_ALGORITHM = 'pbkdf2-sha256';
export const PASSWORD_ITERATIONS = 100_000;
const PEPPER_ID = 'p1';

async function derive(password: string, pepper: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const peppered = await hmac(pepper, password);
  const key = await crypto.subtle.importKey('raw', peppered, 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string, pepper: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(password, pepper, salt, PASSWORD_ITERATIONS);
  return [PASSWORD_ALGORITHM, PASSWORD_ITERATIONS, PEPPER_ID, base64url(salt), base64url(hash)].join('$');
}

export async function verifyPassword(password: string, stored: string, pepper: string): Promise<boolean> {
  const [algorithm, iterations, pepperId, salt, hash] = stored.split('$');
  const rounds = Number(iterations);
  if (algorithm !== PASSWORD_ALGORITHM || pepperId !== PEPPER_ID || !Number.isInteger(rounds) || rounds < 1 || rounds > PASSWORD_ITERATIONS) {
    return false;
  }
  const actual = await derive(password, pepper, fromBase64url(salt), rounds);
  return timingSafeEqual(actual, fromBase64url(hash));
}

/** True when a stored hash uses older parameters than hashPassword writes today. */
export function passwordNeedsRehash(stored: string): boolean {
  const [algorithm, iterations, pepperId] = stored.split('$');
  return algorithm !== PASSWORD_ALGORITHM || Number(iterations) !== PASSWORD_ITERATIONS || pepperId !== PEPPER_ID;
}

/** No password matches this hash. Checking it makes a sign-in for an unknown email take as long as a real one. */
export const DUMMY_PASSWORD_HASH = [PASSWORD_ALGORITHM, PASSWORD_ITERATIONS, PEPPER_ID, 'A'.repeat(22), 'A'.repeat(43)].join('$');

// TOTP secrets at rest: AES-256-GCM with a random 96-bit IV, bound to the user ID as associated data.
async function aesKey(base64Key: string): Promise<CryptoKey> {
  const raw = fromBase64(base64Key);
  if (raw.byteLength !== 32) throw new Error('TOTP_ENCRYPTION_KEY must be 32 bytes in base64');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(plain: Uint8Array<ArrayBuffer>, base64Key: string, userId: string): Promise<string> {
  const iv = randomBytes(12);
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(userId) }, await aesKey(base64Key), plain);
  return `v1.${base64url(iv)}.${base64url(new Uint8Array(sealed))}`;
}

export async function decryptSecret(sealed: string, base64Key: string, userId: string): Promise<Uint8Array<ArrayBuffer>> {
  const [version, iv, data] = sealed.split('.');
  if (version !== 'v1' || !iv || !data) throw new Error('Unknown TOTP secret format');
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64url(iv), additionalData: encoder.encode(userId) },
    await aesKey(base64Key),
    fromBase64url(data),
  );
  return new Uint8Array(plain);
}
