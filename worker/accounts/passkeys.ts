// Passkeys with @simplewebauthn/server. The RP ID is the site host (pi-rust.com, or localhost in
// tests). Each ceremony's challenge is stored in D1 for 5 minutes and used once.

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { Context, User } from './context';
import { base64url, fromBase64url, randomId } from './crypto';
import { HttpError, type Json } from './http';

export interface PasskeyRow {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: string;
  counter: number;
  transports: string;
  device_type: string;
  backed_up: number;
  aaguid: string | null;
  name: string;
  created_at: number;
  last_used_at: number | null;
}

/** register: add a passkey. sign-in: passwordless. second-factor: after a password. reauth: confirm it's you. */
export type Ceremony = 'register' | 'sign-in' | 'second-factor' | 'reauth';

const CHALLENGE_TTL = 5 * 60 * 1000;

const rpId = (c: Context) => new URL(c.origin).hostname;

export async function passkeysOf(c: Context, userId: string): Promise<PasskeyRow[]> {
  const { results } = await c.env.DB.prepare('SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at').bind(userId).all<PasskeyRow>();
  return results;
}

async function saveChallenge(c: Context, challenge: string, purpose: Ceremony, userId: string | null): Promise<string> {
  const id = randomId();
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM webauthn_challenges WHERE expires_at < ?').bind(now),
    c.env.DB.prepare('INSERT INTO webauthn_challenges (id, challenge, purpose, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)').bind(
      id,
      challenge,
      purpose,
      userId,
      now,
      now + CHALLENGE_TTL,
    ),
  ]);
  return id;
}

/** Deletes the ceremony and returns its challenge, so it cannot be answered twice. */
async function takeChallenge(c: Context, id: unknown, purpose: Ceremony, userId: string | null): Promise<string> {
  if (typeof id !== 'string' || !id) throw new HttpError(400, 'invalid_passkey', 'The passkey request expired. Try again.');
  const row = await c.env.DB.prepare('DELETE FROM webauthn_challenges WHERE id = ? RETURNING challenge, purpose, user_id, expires_at')
    .bind(id)
    .first<{ challenge: string; purpose: string; user_id: string | null; expires_at: number }>();
  if (!row || row.purpose !== purpose || row.user_id !== userId || row.expires_at < Date.now()) {
    throw new HttpError(400, 'invalid_passkey', 'The passkey request expired. Try again.');
  }
  return row.challenge;
}

const transportsOf = (row: PasskeyRow): string[] => {
  try {
    const value: unknown = JSON.parse(row.transports);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
};

export async function registrationOptions(c: Context, user: User): Promise<Json> {
  const existing = await passkeysOf(c, user.id);
  const options = await generateRegistrationOptions({
    rpName: 'pi-rust',
    rpID: rpId(c),
    userName: user.email,
    userDisplayName: user.email,
    userID: fromBase64url(user.webauthn_user_id),
    attestationType: 'none',
    excludeCredentials: existing.map((row) => ({ id: row.credential_id, transports: transportsOf(row) })),
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'preferred' },
  });
  return { ceremony: await saveChallenge(c, options.challenge, 'register', user.id), options };
}

/** Verifies a new passkey and stores it. Returns the stored row. */
export async function register(c: Context, user: User, ceremony: unknown, response: unknown, name: string): Promise<PasskeyRow> {
  const challenge = await takeChallenge(c, ceremony, 'register', user.id);
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: response as RegistrationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: c.origin,
      expectedRPID: rpId(c),
      requireUserVerification: false,
    });
  } catch (error) {
    console.warn('passkey registration failed', (error as Error).message);
    throw new HttpError(400, 'invalid_passkey', 'The passkey could not be verified.');
  }
  if (!verification.verified) throw new HttpError(400, 'invalid_passkey', 'The passkey could not be verified.');
  const info = verification.registrationInfo;
  const row: PasskeyRow = {
    id: randomId(),
    user_id: user.id,
    credential_id: info.credential.id,
    public_key: base64url(info.credential.publicKey),
    counter: info.credential.counter,
    transports: JSON.stringify(info.credential.transports ?? []),
    device_type: info.credentialDeviceType,
    backed_up: info.credentialBackedUp ? 1 : 0,
    aaguid: info.aaguid,
    name,
    created_at: Date.now(),
    last_used_at: null,
  };
  try {
    await c.env.DB.prepare(
      'INSERT INTO passkeys (id, user_id, credential_id, public_key, counter, transports, device_type, backed_up, aaguid, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(row.id, row.user_id, row.credential_id, row.public_key, row.counter, row.transports, row.device_type, row.backed_up, row.aaguid, row.name, row.created_at)
      .run();
  } catch {
    throw new HttpError(409, 'passkey_exists', 'This passkey is already registered.');
  }
  return row;
}

/**
 * Options for using a passkey. Passwordless sign-in lists no credentials (the browser offers the
 * discoverable ones) and requires user verification.
 */
export async function authenticationOptions(c: Context, purpose: Exclude<Ceremony, 'register'>, user: User | null): Promise<Json> {
  const allow = user ? (await passkeysOf(c, user.id)).map((row) => ({ id: row.credential_id, transports: transportsOf(row) })) : [];
  const options = await generateAuthenticationOptions({
    rpID: rpId(c),
    allowCredentials: allow,
    userVerification: purpose === 'second-factor' ? 'preferred' : 'required',
  });
  return { ceremony: await saveChallenge(c, options.challenge, purpose, user?.id ?? null), options };
}

/**
 * Verifies a passkey assertion and returns the passkey used. With `user`, the passkey must be one of
 * theirs; without (passwordless), the user handle must match the passkey's owner.
 */
export async function authenticate(
  c: Context,
  purpose: Exclude<Ceremony, 'register'>,
  user: User | null,
  ceremony: unknown,
  response: unknown,
): Promise<PasskeyRow> {
  const challenge = await takeChallenge(c, ceremony, purpose, user?.id ?? null);
  const answer = response as AuthenticationResponseJSON;
  const invalid = new HttpError(400, 'invalid_passkey', 'That passkey did not work. Try again or use another way to sign in.');
  if (!answer || typeof answer !== 'object' || typeof answer.id !== 'string') throw invalid;
  const row = await c.env.DB.prepare('SELECT * FROM passkeys WHERE credential_id = ?').bind(answer.id).first<PasskeyRow>();
  if (!row || (user && row.user_id !== user.id)) throw invalid;
  if (!user) {
    const owner = await c.env.DB.prepare('SELECT webauthn_user_id FROM users WHERE id = ?').bind(row.user_id).first<{ webauthn_user_id: string }>();
    if (!owner || answer.response?.userHandle !== owner.webauthn_user_id) throw invalid;
  }
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: answer,
      expectedChallenge: challenge,
      expectedOrigin: c.origin,
      expectedRPID: rpId(c),
      credential: { id: row.credential_id, publicKey: fromBase64url(row.public_key), counter: row.counter, transports: transportsOf(row) },
      requireUserVerification: purpose !== 'second-factor',
    });
  } catch (error) {
    console.warn('passkey sign-in failed', (error as Error).message);
    throw invalid;
  }
  if (!verification.verified) throw invalid;
  const { newCounter, credentialBackedUp, credentialDeviceType } = verification.authenticationInfo;
  await c.env.DB.prepare('UPDATE passkeys SET counter = ?, backed_up = ?, device_type = ?, last_used_at = ? WHERE id = ?')
    .bind(newCounter, credentialBackedUp ? 1 : 0, credentialDeviceType, Date.now(), row.id)
    .run();
  return row;
}

/** A default name for a new passkey, from the browser that made it. */
export function defaultPasskeyName(label: string): string {
  return label === 'Browser' ? 'Passkey' : `Passkey on ${label.replace(/^.* on /, '')}`;
}
