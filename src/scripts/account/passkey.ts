/** Passkey ceremonies in the browser, with @simplewebauthn/browser. */

import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { api, ApiError, type Json } from './api';

export const passkeysSupported = () => browserSupportsWebAuthn();

/** The browser's own errors (cancelled, timed out) as one plain message. */
function browserError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  const name = (error as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'AbortError') return new ApiError(0, 'cancelled', 'The passkey request was cancelled or timed out.');
  if (name === 'InvalidStateError') return new ApiError(0, 'passkey_exists', 'This device already has a passkey for your account.');
  return new ApiError(0, 'passkey_failed', 'Your browser could not use a passkey. Try again.');
}

/** Runs a passkey sign-in or confirmation: options from `optionsPath`, the answer to `verifyPath`. */
export async function usePasskey(optionsPath: string, verifyPath: string, extra: Json = {}): Promise<Json> {
  const { ceremony, options } = await api<{ ceremony: string; options: PublicKeyCredentialRequestOptionsJSON }>(optionsPath, { body: extra });
  let response;
  try {
    response = await startAuthentication({ optionsJSON: options });
  } catch (error) {
    throw browserError(error);
  }
  return api(verifyPath, { body: { ...extra, ceremony, response } });
}

/** Adds a passkey to the signed-in account. */
export async function addPasskey(): Promise<{ passkey: { id: string; name: string }; recoveryCodes?: string[] }> {
  const { ceremony, options } = await api<{ ceremony: string; options: PublicKeyCredentialCreationOptionsJSON }>('passkeys/options', { body: {} });
  let response;
  try {
    response = await startRegistration({ optionsJSON: options });
  } catch (error) {
    throw browserError(error);
  }
  return api('passkeys', { body: { ceremony, response } });
}
