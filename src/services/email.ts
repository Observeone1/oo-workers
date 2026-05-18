/**
 * SMTP email — used by the `email` alert channel.
 *
 * The SMTP server is an operator-level secret, configured once via env
 * (like Postgres/Redis/object-storage creds), not per channel. Each email
 * channel just stores its recipient (`config.to`). If SMTP isn't
 * configured the channel send fails loudly with a clear message — same
 * "no-op until you wire it" posture as object storage.
 *
 * Env:
 *   OO_SMTP_HOST     required to enable email at all
 *   OO_SMTP_PORT     default 587
 *   OO_SMTP_SECURE   "true" for implicit TLS (or auto-true on port 465)
 *   OO_SMTP_USER     optional (omit for unauthenticated relays)
 *   OO_SMTP_PASS     optional
 *   OO_SMTP_FROM     From: header; falls back to OO_SMTP_USER
 */

import nodemailer, { type Transporter } from 'nodemailer';

let cached: Transporter | null = null;
let resolved = false;

function getTransport(): Transporter | null {
  if (resolved) return cached;
  resolved = true;
  const host = process.env.OO_SMTP_HOST;
  if (!host) return (cached = null);
  const port = Number(process.env.OO_SMTP_PORT ?? 587);
  const user = process.env.OO_SMTP_USER;
  const pass = process.env.OO_SMTP_PASS;
  cached = nodemailer.createTransport({
    host,
    port,
    secure: process.env.OO_SMTP_SECURE === 'true' || port === 465,
    auth: user ? { user, pass } : undefined,
  });
  return cached;
}

export async function sendEmail(msg: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<void> {
  const transport = getTransport();
  if (!transport) {
    throw new Error('SMTP not configured — set OO_SMTP_HOST (see docs/.env.example)');
  }
  const from = process.env.OO_SMTP_FROM ?? process.env.OO_SMTP_USER ?? 'oo-workers@localhost';
  await transport.sendMail({
    from,
    to: msg.to,
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
  });
}
