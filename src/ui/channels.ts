/**
 * Alert channels settings page — list, create, test-fire, delete.
 * Routed under #/channels in app.ts.
 */

import { $, esc, fmtAge } from './helpers';
import {
  createChannel,
  deleteChannel,
  getChannels,
  testChannel,
  type ChannelLite,
  type ChannelType,
} from './api';
import { confirmDialog, alertDialog } from './dialogs';
import { openSlideover, closeSlideover } from './slideover';

const TYPE_LABEL: Record<ChannelType, string> = {
  webhook: 'Webhook',
  discord: 'Discord',
  slack: 'Slack',
  email: 'Email',
};

const TYPE_HINT: Record<ChannelType, string> = {
  webhook: 'Raw JSON POST to any URL.',
  discord:
    "Paste the channel's incoming-webhook URL from Discord → Server settings → Integrations.",
  slack: 'Paste an incoming-webhook URL from Slack → Apps → Incoming Webhooks.',
  email:
    'Recipient address. The SMTP server is configured once on the server via OO_SMTP_* env vars — see docs.',
};

// Email collects a recipient address; the others collect a webhook URL.
const DEST_FIELD: Record<ChannelType, { label: string; type: string; placeholder: string }> = {
  webhook: { label: 'URL', type: 'url', placeholder: 'https://example.com/hook' },
  discord: { label: 'URL', type: 'url', placeholder: 'https://discord.com/api/webhooks/...' },
  slack: { label: 'URL', type: 'url', placeholder: 'https://hooks.slack.com/services/...' },
  email: { label: 'Recipient', type: 'email', placeholder: 'alerts@example.com' },
};

const CHANNEL_ICON: Record<ChannelType, string> = {
  webhook: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
  slack: `<svg viewBox="0 0 127 127" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M27.2 80c0 7.3-5.9 13.2-13.2 13.2C6.7 93.2.8 87.3.8 80c0-7.3 5.9-13.2 13.2-13.2h13.2V80zm6.6 0c0-7.3 5.9-13.2 13.2-13.2 7.3 0 13.2 5.9 13.2 13.2v33c0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V80z" fill="currentColor" opacity=".9"/><path d="M47 27c-7.3 0-13.2-5.9-13.2-13.2C33.8 6.5 39.7.6 47 .6c7.3 0 13.2 5.9 13.2 13.2V27H47zm0 6.7c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H13.9C6.6 60.1.7 54.2.7 46.9c0-7.3 5.9-13.2 13.2-13.2H47z" fill="currentColor" opacity=".9"/><path d="M99.9 46.9c0-7.3 5.9-13.2 13.2-13.2 7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H99.9V46.9zm-6.6 0c0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V13.8C66.9 6.5 72.8.6 80.1.6c7.3 0 13.2 5.9 13.2 13.2v33.1z" fill="currentColor" opacity=".9"/><path d="M80.1 99.8c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V99.8h13.2zm0-6.6c-7.3 0-13.2-5.9-13.2-13.2 0-7.3 5.9-13.2 13.2-13.2h33.1c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H80.1z" fill="currentColor" opacity=".9"/></svg>`,
  discord: `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M20.317 4.492c-1.53-.69-3.17-1.2-4.885-1.49a.075.075 0 0 0-.079.036c-.21.369-.444.85-.608 1.23a18.566 18.566 0 0 0-5.487 0 12.36 12.36 0 0 0-.617-1.23A.077.077 0 0 0 8.562 3c-1.714.29-3.354.8-4.885 1.491a.07.07 0 0 0-.032.027C.533 9.093-.32 13.555.099 17.961a.08.08 0 0 0 .031.055 20.03 20.03 0 0 0 5.993 2.98.078.078 0 0 0 .084-.026c.462-.62.874-1.275 1.226-1.963.021-.04.001-.088-.041-.104a13.201 13.201 0 0 1-1.872-.878.075.075 0 0 1-.008-.125c.126-.093.252-.19.372-.287a.075.075 0 0 1 .078-.01c3.927 1.764 8.18 1.764 12.061 0a.075.075 0 0 1 .079.009c.12.098.245.195.372.288a.075.075 0 0 1-.006.125c-.598.344-1.22.635-1.873.877a.075.075 0 0 0-.041.105c.36.687.772 1.341 1.225 1.962a.077.077 0 0 0 .084.028 19.963 19.963 0 0 0 6.002-2.981.076.076 0 0 0 .032-.054c.5-5.094-.838-9.52-3.549-13.442a.06.06 0 0 0-.031-.028zM8.02 15.278c-1.182 0-2.157-1.069-2.157-2.38 0-1.312.956-2.38 2.157-2.38 1.21 0 2.176 1.077 2.157 2.38 0 1.312-.956 2.38-2.157 2.38zm7.975 0c-1.183 0-2.157-1.069-2.157-2.38 0-1.312.955-2.38 2.157-2.38 1.21 0 2.176 1.077 2.157 2.38 0 1.312-.946 2.38-2.157 2.38z"/></svg>`,
  email: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2 7 10 7 10-7"/></svg>`,
};

let lastBanner: { kind: 'ok' | 'err'; text: string } | null = null;

export async function renderChannels() {
  const main = $('#main');
  const channels = await getChannels();

  const cards = channels.map(renderChannelCard).join('');

  main.innerHTML = `
    <div class="page-head">
      <div>
        <h2 data-testid="page-title">Alert channels</h2>
        <div class="sub">How oo-workers reaches you when a monitor flips up→down and on recovery.</div>
      </div>
      <button class="btn primary" id="add-channel-btn" data-testid="channels-add-btn">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>
        Add channel
      </button>
    </div>

    ${lastBanner ? renderBanner(lastBanner) : ''}

    <div class="channel-cards">
      ${cards}
      <button class="add-card" id="add-channel-trigger">
        <span class="ico">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
        </span>
        <span class="lbl">New channel</span>
        <span class="muted small" style="margin-top:4px">Webhook · Slack · Discord · Email</span>
      </button>
    </div>
  `;

  lastBanner = null;
  wireChannelRowActions();
  wireCreateBtn();
}

function renderBanner(b: { kind: 'ok' | 'err'; text: string }): string {
  return `<div class="banner banner-${b.kind}" data-testid="banner-${b.kind}">${esc(b.text)}</div>`;
}

// Destination hint per type (URL is stored server-side, not returned for security)
const DEST_HINT: Record<ChannelType, string> = {
  webhook: 'https://…  (stored encrypted)',
  discord: 'https://discord.com/api/webhooks/…  (stored encrypted)',
  slack: 'https://hooks.slack.com/…  (stored encrypted)',
  email: 'recipient address  (stored encrypted)',
};

function renderChannelCard(c: ChannelLite): string {
  const icon = CHANNEL_ICON[c.type] ?? '';
  return `
    <article class="channel-card t-${c.type}" data-channel-id="${c.id}" data-channel-name="${esc(c.name)}" data-testid="channel-card-${esc(c.name)}">
      <div class="row1">
        <div style="display:flex;gap:10px;align-items:flex-start;min-width:0">
          <span class="ch-icon">${icon}</span>
          <div style="min-width:0">
            <div class="ch-name">${esc(c.name)}</div>
            <div class="ch-type">${esc(TYPE_LABEL[c.type])}</div>
          </div>
        </div>
        <span class="pill up" title="channel configured"><span class="dot up"></span>active</span>
      </div>
      <div class="ch-url ch-url-masked">
        <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;opacity:.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        ${esc(DEST_HINT[c.type])}
      </div>
      <div class="ch-stats">
        <span>created ${fmtAge(c.createdAt)}</span>
      </div>
      <div class="ch-acts">
        <button class="btn sm channel-test" data-channel-id="${c.id}" data-testid="channel-test-btn">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M13 5l7 7-7 7"/></svg>
          Send test
        </button>
        <button class="btn sm danger channel-delete" data-channel-id="${c.id}" data-testid="channel-delete-btn" aria-label="Delete">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
        </button>
      </div>
    </article>
  `;
}

function wireChannelRowActions() {
  document.querySelectorAll<HTMLButtonElement>('.channel-test').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = Number(btn.dataset.channelId);
      const original = btn.innerHTML;
      btn.disabled = true;
      btn.textContent = 'Sending…';
      const { res, data } = await testChannel(id);
      btn.disabled = false;
      btn.innerHTML = original;
      if (res.ok && data.ok) {
        // Dev: when SMTP points at a local Mailpit the server reads it
        // back and tells us the mail actually landed (not just "SMTP
        // accepted it"). Absent in production / non-email → unchanged.
        const mp = data.mailpit;
        if (mp?.delivered) {
          lastBanner = {
            kind: 'ok',
            text: `Test alert delivered ✓ landed in Mailpit — “${mp.subject}”`,
          };
        } else if (mp) {
          lastBanner = {
            kind: 'ok',
            text: 'Test alert sent — Mailpit read-back timed out; check http://localhost:8025',
          };
        } else {
          lastBanner = { kind: 'ok', text: 'Test alert delivered — check the destination.' };
        }
      } else {
        lastBanner = {
          kind: 'err',
          text: `Test failed: ${data.error ?? `HTTP ${res.status}`}. Check the URL and worker logs.`,
        };
      }
      await renderChannels();
    });
  });

  document.querySelectorAll<HTMLButtonElement>('.channel-delete').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = Number(btn.dataset.channelId);
      const card = btn.closest<HTMLElement>('.channel-card');
      const name = card?.dataset.channelName ?? `#${id}`;
      const ok = await confirmDialog({
        title: 'Delete channel',
        body: `Delete channel '${name}'? Monitor bindings using this channel are removed too — they'll stop alerting unless you bind them to another channel.`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      btn.disabled = true;
      const res = await deleteChannel(id);
      if (!res.ok) {
        alertDialog({ title: 'Delete failed', body: `Delete failed: ${res.status}` });
        btn.disabled = false;
        return;
      }
      await renderChannels();
    });
  });
}

function wireCreateBtn() {
  const openCreate = () =>
    openSlideover({
      title: 'New alert channel',
      body: `
      <div class="form-section">
        <div class="sec-head"><span class="ttl">Channel type</span></div>
        <div class="choice-row" id="so-ch-type-row">
          <label class="choice">
            <input type="radio" name="so-ch-type" value="webhook" checked />
            <div class="info">
              <div class="ttl">${CHANNEL_ICON.webhook}<span style="margin-left:6px">Webhook</span></div>
              <div class="desc">POST JSON to any URL. Works with PagerDuty, Opsgenie, custom bots.</div>
            </div>
          </label>
          <label class="choice">
            <input type="radio" name="so-ch-type" value="slack" />
            <div class="info">
              <div class="ttl">${CHANNEL_ICON.slack}<span style="margin-left:6px">Slack</span></div>
              <div class="desc">Incoming webhook URL from a Slack app. Posts a formatted card.</div>
            </div>
          </label>
          <label class="choice">
            <input type="radio" name="so-ch-type" value="discord" />
            <div class="info">
              <div class="ttl">${CHANNEL_ICON.discord}<span style="margin-left:6px">Discord</span></div>
              <div class="desc">Webhook URL from a Discord channel integration.</div>
            </div>
          </label>
          <label class="choice">
            <input type="radio" name="so-ch-type" value="email" />
            <div class="info">
              <div class="ttl">${CHANNEL_ICON.email}<span style="margin-left:6px">Email (SMTP)</span></div>
              <div class="desc">Send alert emails via your configured SMTP server.</div>
            </div>
          </label>
        </div>
      </div>
      <div class="form-section">
        <div class="sec-head"><span class="ttl">Connection</span></div>
        <div class="field">
          <label>Name</label>
          <input id="so-ch-name" placeholder="PagerDuty primary" required />
          <div class="help">Shown in monitor edit screens.</div>
        </div>
        <div class="field" id="so-ch-url-field">
          <label>URL</label>
          <input id="so-ch-url" type="url" placeholder="https://discord.com/api/webhooks/…" required />
          <div class="help">Sensitive. Stored encrypted at rest.</div>
        </div>
        <div class="field" id="so-ch-email-field" hidden>
          <label>Recipient address</label>
          <input id="so-ch-email" type="email" placeholder="alerts@example.com" />
          <div class="help">Requires SMTP configured in worker env.</div>
        </div>
        <p id="so-ch-err" class="banner err" hidden style="margin-top:var(--s-3)"></p>
      </div>
      <div class="form-section" id="so-ch-payload-preview">
        <div class="sec-head">
          <span class="ttl">Payload preview</span>
          <span class="sec-status"><span class="dot up"></span>auto-generated</span>
        </div>
        <div class="preview-frame">{
  <span class="kw">"monitor"</span>: <span class="str">"API gateway"</span>,
  <span class="kw">"status"</span>:  <span class="str">"down"</span>,
  <span class="kw">"latencyMs"</span>: <span class="num">4900</span>,
  <span class="kw">"timestamp"</span>: <span class="str">"2026-05-17T17:42:01Z"</span>
}</div>
      </div>
    `,
      primaryLabel: 'Create channel',
      onPrimary: async (so) => {
        const typeEl = so.querySelector<HTMLInputElement>('input[name="so-ch-type"]:checked');
        const nameEl = so.querySelector<HTMLInputElement>('#so-ch-name')!;
        const urlEl = so.querySelector<HTMLInputElement>('#so-ch-url')!;
        const emailEl = so.querySelector<HTMLInputElement>('#so-ch-email')!;
        const errEl = so.querySelector<HTMLElement>('#so-ch-err')!;
        const name = nameEl.value.trim();
        const type = (typeEl?.value ?? 'webhook') as ChannelType;
        const url = type === 'email' ? emailEl.value.trim() : urlEl.value.trim();
        if (!name || !url) {
          errEl.textContent = 'Name and destination are required.';
          errEl.hidden = false;
          throw new Error('validation');
        }
        errEl.hidden = true;
        const { res, data } = await createChannel(name, type, url);
        if (!res.ok) {
          errEl.textContent = 'error' in data ? data.error : `request failed (${res.status})`;
          errEl.hidden = false;
          throw new Error('api');
        }
        closeSlideover();
        lastBanner = { kind: 'ok', text: `Channel '${name}' created — try Test next.` };
        await renderChannels();
      },
    });

  const openAndWire = () => {
    openCreate();
    const so = document.querySelector<HTMLElement>('.slideover');
    if (!so) return;
    so.querySelectorAll<HTMLInputElement>('input[name="so-ch-type"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        const isEmail = radio.value === 'email';
        const urlField = so.querySelector<HTMLElement>('#so-ch-url-field');
        const emailField = so.querySelector<HTMLElement>('#so-ch-email-field');
        const preview = so.querySelector<HTMLElement>('#so-ch-payload-preview');
        if (urlField) urlField.hidden = isEmail;
        if (emailField) emailField.hidden = !isEmail;
        if (preview) preview.hidden = isEmail;
      });
    });
  };

  document.getElementById('add-channel-btn')?.addEventListener('click', openAndWire);
  document.getElementById('add-channel-trigger')?.addEventListener('click', openAndWire);
}
