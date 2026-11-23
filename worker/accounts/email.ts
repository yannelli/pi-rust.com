// Sends account email through the EMAIL binding, or writes it to the dev mailbox in local tests.
// A failed send is logged and never fails the request.

import type { AccountEnv, ExecutionContext } from './env';
import { isLocalHost } from './http';
import { renderEmail, type EmailMessage } from './templates';

/** The dev mailbox is on only with DEV_MAILBOX=1 and only for a request to localhost or 127.0.0.1. */
export function devMailboxOn(env: AccountEnv, request: Request): boolean {
  return env.DEV_MAILBOX === '1' && isLocalHost(new URL(request.url).hostname);
}

async function deliver(env: AccountEnv, request: Request, to: string, message: EmailMessage): Promise<void> {
  const { subject, text, html } = renderEmail(message);
  try {
    if (devMailboxOn(env, request)) {
      await env.DB.prepare('INSERT INTO dev_mailbox (to_address, subject, text, html, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(to, subject, text, html, Date.now())
        .run();
      return;
    }
    await env.EMAIL.send({ to, from: { email: env.ACCOUNT_EMAIL_FROM, name: 'pi-rust' }, subject, text, html });
  } catch (error) {
    const { code, message: detail } = (error ?? {}) as { code?: string; message?: string };
    console.error('account email failed', message.kind, code, detail);
  }
}

/**
 * Sends after the response, so a request that sends email takes as long as one that does not
 * (sign-up and reset must not reveal whether an address has an account).
 */
export function sendEmail(env: AccountEnv, request: Request, ctx: ExecutionContext, to: string, message: EmailMessage): void {
  ctx.waitUntil(deliver(env, request, to, message));
}
