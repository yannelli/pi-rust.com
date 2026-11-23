// Account email: one subject, a plain-text body, and a simple HTML body per message.

export type EmailMessage =
  | { kind: 'verify'; link: string }
  | { kind: 'sign-up-existing'; signInLink: string; resetLink: string }
  | { kind: 'reset'; link: string }
  | { kind: 'password-changed'; resetLink: string }
  | { kind: 'two-step-on'; resetLink: string }
  | { kind: 'two-step-off'; resetLink: string }
  | { kind: 'passkey-added'; name: string; resetLink: string }
  | { kind: 'passkey-removed'; name: string; resetLink: string }
  | { kind: 'recovery-code-used'; left: number; resetLink: string }
  | { kind: 'account-deleted' }
  | { kind: 'email-change'; link: string }
  | { kind: 'email-change-taken' }
  | { kind: 'email-change-requested'; newEmail: string; resetLink: string }
  | { kind: 'email-changed'; newEmail: string; undoLink: string }
  | { kind: 'email-change-undone'; resetLink: string };

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

/** A paragraph of text, or a link the email shows as a button. */
type Block = string | { label: string; href: string };

const escapeHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function notYou(resetLink: string): Block[] {
  return ['If you did not do this, reset your password now.', { label: 'Reset password', href: resetLink }];
}

function content(message: EmailMessage): { subject: string; heading: string; blocks: Block[] } {
  switch (message.kind) {
    case 'verify':
      return {
        subject: 'Verify your email for pi-rust',
        heading: 'Verify your email',
        blocks: [
          'Confirm this address for your pi-rust account. You need a verified address to share sessions and to connect the pi CLI.',
          { label: 'Verify email', href: message.link },
          'The link works for 24 hours. If you did not create an account, ignore this email.',
        ],
      };
    case 'sign-up-existing':
      return {
        subject: 'Sign-up attempt for your pi-rust account',
        heading: 'You already have an account',
        blocks: [
          'Someone tried to create a pi-rust account with this email address. It already has an account, so nothing changed.',
          { label: 'Sign in', href: message.signInLink },
          'Forgot your password? Reset it here:',
          { label: 'Reset password', href: message.resetLink },
          'If this was not you, ignore this email.',
        ],
      };
    case 'reset':
      return {
        subject: 'Reset your pi-rust password',
        heading: 'Reset your password',
        blocks: [
          'Use this link to choose a new password. Resetting signs you out everywhere and revokes your CLI tokens.',
          { label: 'Reset password', href: message.link },
          'The link works for 30 minutes. If you did not ask for this, ignore this email. Your password stays the same.',
        ],
      };
    case 'password-changed':
      return {
        subject: 'Your pi-rust password was changed',
        heading: 'Password changed',
        blocks: ['The password for your pi-rust account was changed.', ...notYou(message.resetLink)],
      };
    case 'two-step-on':
      return {
        subject: 'Two-step verification is on',
        heading: 'Two-step verification is on',
        blocks: ['Signing in to your pi-rust account with a password now also needs a code from your authenticator app.', ...notYou(message.resetLink)],
      };
    case 'two-step-off':
      return {
        subject: 'Two-step verification is off',
        heading: 'Two-step verification is off',
        blocks: ['Two-step verification with an authenticator app was turned off for your pi-rust account.', ...notYou(message.resetLink)],
      };
    case 'passkey-added':
      return {
        subject: 'A passkey was added to your pi-rust account',
        heading: 'Passkey added',
        blocks: [`The passkey “${message.name}” was added to your pi-rust account.`, ...notYou(message.resetLink)],
      };
    case 'passkey-removed':
      return {
        subject: 'A passkey was removed from your pi-rust account',
        heading: 'Passkey removed',
        blocks: [`The passkey “${message.name}” was removed from your pi-rust account.`, ...notYou(message.resetLink)],
      };
    case 'recovery-code-used':
      return {
        subject: 'A recovery code was used to sign in',
        heading: 'Recovery code used',
        blocks: [
          `A recovery code was used to sign in to your pi-rust account. ${message.left === 1 ? '1 code is' : `${message.left} codes are`} left.`,
          ...notYou(message.resetLink),
        ],
      };
    case 'account-deleted':
      return {
        subject: 'Your pi-rust account was deleted',
        heading: 'Account deleted',
        blocks: ['Your pi-rust account, its shared sessions, and its CLI tokens were deleted.'],
      };
    case 'email-change':
      return {
        subject: 'Confirm your new email for pi-rust',
        heading: 'Confirm your new email',
        blocks: [
          'Open this link to make this the email address of your pi-rust account. You sign in with it from then on.',
          { label: 'Confirm email', href: message.link },
          'The link works for 24 hours. If you did not ask for this, ignore this email. Nothing changes.',
        ],
      };
    case 'email-change-taken':
      return {
        subject: 'Email change attempt for your pi-rust account',
        heading: 'You already have an account',
        blocks: [
          'Someone asked to move another pi-rust account to this email address. This address already has an account, so nothing changed.',
          'If this was not you, ignore this email.',
        ],
      };
    case 'email-change-requested':
      return {
        subject: 'Your pi-rust email is about to change',
        heading: 'Email change requested',
        blocks: [
          `Someone signed in to your pi-rust account asked to change its email to ${message.newEmail}. It changes only after the link sent to that address is opened.`,
          'If this was not you, reset your password now. That also cancels the change.',
          { label: 'Reset password', href: message.resetLink },
        ],
      };
    case 'email-changed':
      return {
        subject: 'Your pi-rust email was changed',
        heading: 'Email changed',
        blocks: [
          `The email of your pi-rust account was changed to ${message.newEmail}. You sign in with that address now.`,
          'If you did not do this, undo it. Undoing puts this address back, signs out everywhere, removes the passkeys and two-step verification added since the change was asked for, and sends you a link to set a new password.',
          { label: 'Undo the change', href: message.undoLink },
          'The link works for 7 days.',
        ],
      };
    case 'email-change-undone':
      return {
        subject: 'The change of your pi-rust email was undone',
        heading: 'Change undone',
        blocks: [
          'Your pi-rust account has this email address again. It was signed out everywhere, and its old password no longer works. Set a new password:',
          { label: 'Set a new password', href: message.resetLink },
          'The link works for 30 minutes. After that, use “Forgot password?” on the sign-in page.',
        ],
      };
  }
}

export function renderEmail(message: EmailMessage): RenderedEmail {
  const { subject, heading, blocks } = content(message);
  const text = [heading, '', ...blocks.flatMap((block) => (typeof block === 'string' ? [block, ''] : [`${block.label}: ${block.href}`, ''])), '-- ', 'pi-rust.com', ''].join('\n');
  const body = blocks
    .map((block) =>
      typeof block === 'string'
        ? `<p style="margin:0 0 16px;color:#4d4d4d;font-size:15px;line-height:1.6">${escapeHtml(block)}</p>`
        : `<p style="margin:0 0 20px"><a href="${escapeHtml(block.href)}" style="display:inline-block;padding:10px 18px;border-radius:999px;background:#171717;color:#fafafa;font-size:14px;font-weight:500;text-decoration:none">${escapeHtml(block.label)}</a></p>`,
    )
    .join('\n');
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:32px 16px;background:#fafafa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#171717">
<div style="max-width:480px;margin:0 auto;padding:32px;border:1px solid #ebebeb;border-radius:12px;background:#ffffff">
<p style="margin:0 0 24px;font-size:14px;font-weight:600">pi-rust</p>
<h1 style="margin:0 0 16px;font-size:20px;font-weight:600;letter-spacing:-0.01em">${escapeHtml(heading)}</h1>
${body}
</div>
<p style="max-width:480px;margin:16px auto 0;color:#6b6b6b;font-size:12px">pi-rust.com</p>
</body>
</html>`;
  return { subject, text, html };
}
