/**
 * Alert channels settings page — list, create, test-fire, delete.
 *
 * Routed under #/channels in app.ts. Mirrors the regions page UX: list
 * on the left, create form on the right, inline "Send test alert" per
 * row so operators verify the URL before binding to monitors.
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

const TYPE_LABEL: Record<ChannelType, string> = {
  webhook: 'Webhook',
  discord: 'Discord',
  slack: 'Slack',
};

const TYPE_HINT: Record<ChannelType, string> = {
  webhook: 'Raw JSON POST to any URL.',
  discord:
    'Paste the channel’s incoming-webhook URL from Discord → Server settings → Integrations.',
  slack: 'Paste an incoming-webhook URL from Slack → Apps → Incoming Webhooks.',
};

let lastBanner: { kind: 'ok' | 'err'; text: string } | null = null;

function nudgeBadge() {
  // Reuse the same pattern regions.ts uses for the header badge.
  (globalThis as unknown as { ooRefreshRegionBadge?: () => void }).ooRefreshRegionBadge?.();
}

export async function renderChannels() {
  const main = $('#main');
  const channels = await getChannels();

  main.innerHTML = `
    <div class="channels-page">
      <div class="channels-header">
        <h2>Alert channels</h2>
        <p class="meta">
          Send a notification when a monitor flips from up to down (and again on recovery). Bind
          channels to specific monitors via the <strong>Alert via</strong> picker in the
          + Add monitor dialog.
        </p>
      </div>

      ${lastBanner ? renderBanner(lastBanner) : ''}

      <div class="channels-grid">
        <section class="channels-list">
          <h3>Existing (${channels.length})</h3>
          ${
            channels.length === 0
              ? '<p class="meta empty">No channels yet — create one on the right.</p>'
              : ''
          }
          ${channels.map(renderChannelRow).join('')}
        </section>

        <section class="channels-create">
          <h3>Add a channel</h3>
          <form id="channel-create-form">
            <label>Type</label>
            <select name="type" id="channel-type">
              <option value="webhook">Webhook (raw JSON)</option>
              <option value="discord">Discord</option>
              <option value="slack">Slack</option>
            </select>
            <p class="meta" id="channel-type-hint">${esc(TYPE_HINT.webhook)}</p>

            <label>Name</label>
            <input name="name" required placeholder="oncall-discord" />

            <label>URL</label>
            <input name="url" required type="url" placeholder="https://discord.com/api/webhooks/..." />

            <div class="dialog-actions">
              <button type="submit" class="primary">Create channel</button>
            </div>
            <p id="channel-create-error" class="login-error" hidden></p>
          </form>
        </section>
      </div>
    </div>
  `;

  lastBanner = null;
  wireChannelRowActions();
  wireCreateForm();
  nudgeBadge();
}

function renderBanner(b: { kind: 'ok' | 'err'; text: string }): string {
  return `<div class="banner banner-${b.kind}">${esc(b.text)}</div>`;
}

function renderChannelRow(c: ChannelLite): string {
  return `
    <div class="channel-row" data-channel-id="${c.id}" data-channel-name="${esc(c.name)}">
      <div class="channel-row-main">
        <div class="channel-type-pill type-${c.type}">${esc(TYPE_LABEL[c.type])}</div>
        <div class="channel-info">
          <div class="channel-name">${esc(c.name)}</div>
          <div class="meta">created ${fmtAge(c.createdAt)}</div>
        </div>
      </div>
      <div class="channel-actions">
        <button class="channel-test" data-channel-id="${c.id}">Send test alert</button>
        <button class="channel-delete danger" data-channel-id="${c.id}">Delete</button>
      </div>
    </div>
  `;
}

function wireChannelRowActions() {
  document.querySelectorAll<HTMLButtonElement>('.channel-test').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.channelId);
      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Sending…';
      const { res, data } = await testChannel(id);
      btn.disabled = false;
      btn.textContent = original;
      if (res.ok && data.ok) {
        lastBanner = { kind: 'ok', text: 'Test alert delivered — check the destination.' };
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
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.channelId);
      const row = btn.closest<HTMLElement>('.channel-row');
      const name = row?.dataset.channelName ?? `#${id}`;
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

function wireCreateForm() {
  const form = document.getElementById('channel-create-form') as HTMLFormElement | null;
  if (!form) return;
  const typeSelect = document.getElementById('channel-type') as HTMLSelectElement;
  const typeHint = document.getElementById('channel-type-hint') as HTMLElement;
  typeSelect.addEventListener('change', () => {
    typeHint.textContent = TYPE_HINT[typeSelect.value as ChannelType];
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const name = String(fd.get('name') ?? '').trim();
    const type = String(fd.get('type') ?? 'webhook') as ChannelType;
    const url = String(fd.get('url') ?? '').trim();
    if (!name || !url) return;

    const errEl = document.getElementById('channel-create-error') as HTMLElement;
    errEl.hidden = true;
    const { res, data } = await createChannel(name, type, url);
    if (!res.ok) {
      errEl.textContent = 'error' in data ? data.error : `request failed (${res.status})`;
      errEl.hidden = false;
      return;
    }
    lastBanner = { kind: 'ok', text: `Channel '${name}' created — try Send test alert next.` };
    await renderChannels();
  });
}
