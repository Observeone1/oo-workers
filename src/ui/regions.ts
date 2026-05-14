/**
 * Regions settings page — list, create, rotate-key, revoke.
 *
 * Routed under #/regions in app.ts. The cleartext API key returned by
 * create + rotate is surfaced once in an inline panel; we never store
 * it locally. Operator pastes it into the agent's env and continues.
 */

import { $, esc, fmtAge } from './helpers';
import { createRegion, deleteRegion, getRegions, rotateRegionKey, type RegionLite } from './api';

interface OneTimeKey {
  slug: string;
  cleartextKey: string;
  action: 'created' | 'rotated';
}

let oneTimeKey: OneTimeKey | null = null;

export async function renderRegions() {
  const main = $('#main');
  const regions = await getRegions();

  main.innerHTML = `
    <div class="regions-page">
      <div class="regions-header">
        <h2>Regions</h2>
        <p class="meta">
          Multi-region probing — each region is a separately-deployed agent that pulls jobs from this master.
          See the <a href="/docs#multi-region">multi-region guide</a> for the agent quickstart.
        </p>
      </div>

      ${oneTimeKey ? renderOneTimeKey(oneTimeKey) : ''}

      <div class="regions-grid">
        <section class="regions-list">
          <h3>Existing (${regions.length})</h3>
          ${regions.length === 0 ? '<p class="meta empty">No regions yet — create one on the right to add a probe origin.</p>' : ''}
          ${regions.map(renderRegionRow).join('')}
        </section>

        <section class="regions-create">
          <h3>Add a region</h3>
          <form id="region-create-form">
            <label>Slug (lowercase, dashes)</label>
            <input name="slug" required pattern="[a-z0-9][a-z0-9-]{0,62}[a-z0-9]?" placeholder="us-east" />

            <label>Label</label>
            <input name="label" required placeholder="US East (Virginia)" />

            <div class="dialog-actions">
              <button type="submit" class="primary">Create region</button>
            </div>
            <p id="region-create-error" class="login-error" hidden></p>
          </form>
        </section>
      </div>
    </div>
  `;

  wireRegionRowActions();
  wireCreateForm();
}

function renderRegionRow(r: RegionLite): string {
  const onlineClass = r.online ? 'online' : 'offline';
  const onlineLabel = r.online ? 'online' : 'offline';
  return `
    <div class="region-row" data-region-id="${r.id}" data-slug="${esc(r.slug)}">
      <div class="region-row-main">
        <div class="region-status ${onlineClass}" title="${onlineLabel} (last seen ${fmtAge(r.lastSeenAt)})"></div>
        <div class="region-info">
          <div class="region-slug"><code>${esc(r.slug)}</code></div>
          <div class="region-label">${esc(r.label)}</div>
          <div class="meta">${onlineLabel} · last seen ${fmtAge(r.lastSeenAt)}</div>
        </div>
      </div>
      <div class="region-actions">
        <button class="region-rotate" data-region-id="${r.id}">Rotate key</button>
        <button class="region-delete danger" data-region-id="${r.id}">Delete</button>
      </div>
    </div>
  `;
}

function renderOneTimeKey(otk: OneTimeKey): string {
  const verb = otk.action === 'created' ? 'created' : 'rotated';
  return `
    <div class="one-time-key">
      <h3>Region '${esc(otk.slug)}' ${verb} — copy the key now</h3>
      <p class="meta">This is the only time the key is displayed. Paste it into the agent box's env as <code>OO_AGENT_KEY</code> alongside <code>OO_REGION_SLUG=${esc(otk.slug)}</code>.</p>
      <pre class="one-time-key-value"><code>${esc(otk.cleartextKey)}</code></pre>
      <div class="dialog-actions">
        <button type="button" id="copy-key-btn">Copy to clipboard</button>
        <button type="button" id="dismiss-key-btn" class="primary">I've copied it</button>
      </div>
    </div>
  `;
}

function wireRegionRowActions() {
  // Delegate clicks for rotate / delete buttons.
  document.querySelectorAll<HTMLButtonElement>('.region-rotate').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.regionId);
      if (
        !confirm(
          'Issue a new agent key and revoke the old one? The currently running agent will start failing until restarted with the new key.',
        )
      )
        return;
      btn.disabled = true;
      try {
        const result = await rotateRegionKey(id);
        oneTimeKey = {
          slug: result.region.slug,
          cleartextKey: result.cleartextKey,
          action: 'rotated',
        };
        await renderRegions();
      } catch (err) {
        alert(`Rotate failed: ${err instanceof Error ? err.message : String(err)}`);
        btn.disabled = false;
      }
    });
  });

  document.querySelectorAll<HTMLButtonElement>('.region-delete').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.regionId);
      const row = btn.closest<HTMLElement>('.region-row');
      const slug = row?.dataset.slug ?? `#${id}`;
      if (
        !confirm(
          `Delete region '${slug}'? This revokes its agent key and removes all monitor bindings (cascading). Existing execution history is preserved (region_id is set to NULL).`,
        )
      )
        return;
      btn.disabled = true;
      const res = await deleteRegion(id);
      if (!res.ok) {
        alert(`Delete failed: ${res.status} ${await res.text().catch(() => '')}`);
        btn.disabled = false;
        return;
      }
      await renderRegions();
    });
  });

  document.getElementById('copy-key-btn')?.addEventListener('click', async () => {
    if (!oneTimeKey) return;
    try {
      await navigator.clipboard.writeText(oneTimeKey.cleartextKey);
      const btn = document.getElementById('copy-key-btn') as HTMLButtonElement;
      btn.textContent = 'Copied!';
      setTimeout(() => {
        btn.textContent = 'Copy to clipboard';
      }, 1500);
    } catch {
      // Clipboard may be blocked (non-secure context); the textarea is still selectable.
    }
  });

  document.getElementById('dismiss-key-btn')?.addEventListener('click', () => {
    oneTimeKey = null;
    renderRegions();
  });
}

function wireCreateForm() {
  const form = document.getElementById('region-create-form') as HTMLFormElement | null;
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const slug = String(fd.get('slug') ?? '').trim();
    const label = String(fd.get('label') ?? '').trim();
    if (!slug || !label) return;

    const errEl = document.getElementById('region-create-error') as HTMLElement;
    errEl.hidden = true;

    const { res, data } = await createRegion(slug, label);
    if (!res.ok) {
      errEl.textContent = 'error' in data ? data.error : `request failed (${res.status})`;
      errEl.hidden = false;
      return;
    }
    if ('cleartextKey' in data) {
      oneTimeKey = {
        slug: data.region.slug,
        cleartextKey: data.cleartextKey,
        action: 'created',
      };
      await renderRegions();
    }
  });
}
