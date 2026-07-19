/**
 * SMTP email contract — env-driven transport construction (port/secure/auth
 * rules), the From fallback chain, transport caching, and the loud failure
 * when SMTP is unconfigured. nodemailer is mocked at the module boundary;
 * module state is reset per test via cache-busted dynamic imports because
 * the transport is memoized at module level.
 */

import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';

const createTransport = mock((_opts: Record<string, unknown>) => ({ sendMail }));
const sendMail = mock(async (_msg: Record<string, unknown>) => ({}));

mock.module('nodemailer', () => ({ default: { createTransport } }));

let importCounter = 0;
/** Fresh module instance so the memoized transport does not leak between tests. */
async function freshEmail(): Promise<{
  sendEmail: (msg: { to: string; subject: string; text: string; html?: string }) => Promise<void>;
}> {
  return import(`./email.ts?fresh=${++importCounter}`);
}

const ENV_KEYS = [
  'OO_SMTP_HOST',
  'OO_SMTP_PORT',
  'OO_SMTP_SECURE',
  'OO_SMTP_USER',
  'OO_SMTP_PASS',
  'OO_SMTP_FROM',
];
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  createTransport.mockClear();
  sendMail.mockClear();
});

function clearSmtpEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

const msg = { to: 'ops@example.com', subject: 'alert', text: 'down' };

describe('sendEmail', () => {
  test('fails loudly when SMTP is not configured', async () => {
    clearSmtpEnv();
    const { sendEmail } = await freshEmail();

    const err = await sendEmail(msg).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('SMTP not configured');
    expect(createTransport).not.toHaveBeenCalled();
  });

  test('builds an authenticated STARTTLS transport by default and caches it', async () => {
    clearSmtpEnv();
    process.env.OO_SMTP_HOST = 'smtp.example.com';
    process.env.OO_SMTP_USER = 'mailer';
    process.env.OO_SMTP_PASS = 'hunter2';
    process.env.OO_SMTP_FROM = 'alerts@example.com';
    const { sendEmail } = await freshEmail();

    await sendEmail(msg);
    await sendEmail({ ...msg, subject: 'again' });

    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(createTransport.mock.calls[0][0]).toEqual({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      auth: { user: 'mailer', pass: 'hunter2' },
    });
    expect(sendMail).toHaveBeenCalledTimes(2);
    expect(sendMail.mock.calls[0][0]).toEqual({
      from: 'alerts@example.com',
      to: 'ops@example.com',
      subject: 'alert',
      text: 'down',
      html: undefined,
    });
  });

  test('switches to implicit TLS on port 465 and skips auth without a user', async () => {
    clearSmtpEnv();
    process.env.OO_SMTP_HOST = 'smtp.example.com';
    process.env.OO_SMTP_PORT = '465';
    const { sendEmail } = await freshEmail();

    await sendEmail(msg);

    expect(createTransport.mock.calls[0][0]).toEqual({
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      auth: undefined,
    });
    // From falls back to the local default without OO_SMTP_FROM/USER.
    expect(sendMail.mock.calls[0][0]).toMatchObject({ from: 'oo-workers@localhost' });
  });

  test('honours OO_SMTP_SECURE and falls back to the user for From', async () => {
    clearSmtpEnv();
    process.env.OO_SMTP_HOST = 'smtp.example.com';
    process.env.OO_SMTP_SECURE = 'true';
    process.env.OO_SMTP_USER = 'mailer@example.com';
    const { sendEmail } = await freshEmail();

    await sendEmail(msg);

    expect(createTransport.mock.calls[0][0]).toMatchObject({ secure: true });
    expect(sendMail.mock.calls[0][0]).toMatchObject({ from: 'mailer@example.com' });
  });
});
