// TOTP (RFC 6238: HMAC-SHA1, 6 digits, 30-second steps, one step of drift either way) and
// recovery codes.

import { randomBytes, timingSafeEqualText } from './crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_PERIOD = 30;
const DIGITS = 6;

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Uint8Array<ArrayBuffer> {
  const clean = text.toUpperCase().replace(/[^A-Z2-7]/g, '');
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function newTotpSecret(): Uint8Array<ArrayBuffer> {
  return randomBytes(20);
}

export async function hotp(secret: Uint8Array<ArrayBuffer>, counter: number): Promise<string> {
  const message = new Uint8Array(8);
  let rest = counter;
  for (let i = 7; i >= 0; i--) {
    message[i] = rest & 255;
    rest = Math.floor(rest / 256);
  }
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
  const offset = mac[mac.length - 1] & 15;
  const code = ((mac[offset] & 127) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(code % 10 ** DIGITS).padStart(DIGITS, '0');
}

export const timeStep = (ms = Date.now()) => Math.floor(ms / 1000 / TOTP_PERIOD);

/**
 * The time step a code matches (the current step or one either side), or undefined. Steps at or
 * before `lastStep` are refused, so each code works once.
 */
export async function matchTotp(secret: Uint8Array<ArrayBuffer>, code: string, lastStep: number | null, now = Date.now()): Promise<number | undefined> {
  const clean = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return undefined;
  const current = timeStep(now);
  let found: number | undefined;
  for (const step of [current - 1, current, current + 1]) {
    // Check every step, so the time taken does not depend on which one matched.
    const matches = timingSafeEqualText(await hotp(secret, step), clean);
    if (matches && found === undefined && (lastStep === null || step > lastStep)) found = step;
  }
  return found;
}

export function otpauthUri(secret: Uint8Array, email: string): string {
  const label = encodeURIComponent(`pi-rust:${email}`);
  return `otpauth://totp/${label}?secret=${base32Encode(secret)}&issuer=pi-rust&algorithm=SHA1&digits=${DIGITS}&period=${TOTP_PERIOD}`;
}

// Recovery codes: 10 codes of 10 characters (50 bits) shown as xxxxx-xxxxx, each usable once.
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const RECOVERY_CODE_COUNT = 10;

export function newRecoveryCode(): string {
  let out = '';
  while (out.length < 10) {
    for (const byte of randomBytes(16)) {
      // 248 is the largest multiple of 31 below 256, so every character is equally likely.
      if (byte < 248 && out.length < 10) out += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length];
    }
  }
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}

/** Lowercase, without spaces or dashes, so "ABCDE FGHJK" and "abcde-fghjk" match. */
export function normalizeRecoveryCode(code: string): string {
  return code.toLowerCase().replace(/[\s-]/g, '');
}
