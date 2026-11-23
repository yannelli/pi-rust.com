/** JSON calls to /api/account/* (and /api/admin/*). State-changing calls send JSON, which the Worker requires (CSRF). */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

export type Json = Record<string, unknown>;

export async function api<T = Json>(path: string, options: { method?: string; body?: Json } = {}): Promise<T> {
  return callJson<T>(`/api/account/${path}`, options);
}

/** A JSON call to a same-origin API path. Throws an ApiError with the Worker's error code and description. */
export async function callJson<T = Json>(url: string, options: { method?: string; body?: Json } = {}): Promise<T> {
  const method = options.method ?? (options.body ? 'POST' : 'GET');
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: method === 'GET' ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}),
    });
  } catch {
    throw new ApiError(0, 'network', 'Could not reach pi-rust.com. Check your connection and try again.');
  }
  let data: Json = {};
  try {
    data = (await response.json()) as Json;
  } catch {
    // An empty or non-JSON body is handled below.
  }
  if (!response.ok || data.ok === false) {
    const description = typeof data.description === 'string' ? data.description : 'Something went wrong. Try again.';
    throw new ApiError(response.status, typeof data.error === 'string' ? data.error : 'error', description, typeof data.field === 'string' ? data.field : undefined);
  }
  return data as T;
}

export interface Account {
  email: string;
  verified: boolean;
  createdAt: string;
  totp: boolean;
  passkeys: number;
  recoveryCodes: number;
  admin: boolean;
  /** The new address of a change waiting for its link to be opened, or null. */
  pendingEmail: string | null;
}

export interface Me {
  account: Account;
  session: { reauthUntil: string | null };
}

/** The signed-in account, or a redirect to sign-in when the session ended. */
export async function loadMe(): Promise<Me> {
  try {
    return await api<Me>('me');
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) toSignIn();
    throw error;
  }
}

export function toSignIn(): never {
  const next = location.pathname + location.search;
  location.assign(`/account/sign-in/?next=${encodeURIComponent(next)}`);
  throw new ApiError(401, 'unauthorized', 'Sign in to continue.');
}

/** An account, admin, or device path, or a share (/s/<id>), on this site to go to after sign-in, else the account home. */
export function nextPath(): string {
  const next = new URLSearchParams(location.search).get('next') ?? '';
  if (next.startsWith('//') || /[\\\s]/.test(next)) return '/account/';
  return /^\/(account|admin|device)(\/|\?|$)/.test(next) || /^\/s\/[A-Za-z0-9_-]{22}$/.test(next) ? next : '/account/';
}
