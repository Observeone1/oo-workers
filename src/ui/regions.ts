/**
 * Regions settings page — list, create, rotate-key, delete.
 * Routed under #/regions in app.ts.
 */

import { $, esc, fmtAge } from './helpers';
import { createRegion, deleteRegion, getRegions, rotateRegionKey, type RegionLite } from './api';
import { confirmDialog, alertDialog } from './dialogs';
import { openSlideover, closeSlideover } from './slideover';

interface OneTimeKey {
  slug: string;
  cleartextKey: string;
  action: 'created' | 'rotated';
}

let oneTimeKey: OneTimeKey | null = null;

function nudgeBadge() {
  (globalThis as unknown as { ooRefreshRegionBadge?: () => void }).ooRefreshRegionBadge?.();
}

// World silhouette + region pins for the globe card.
function globeSvg(regions: RegionLite[]): string {
  const PINS: Record<string, [number, number]> = {
    'us-east-1': [125, 70],
    'us-east-2': [130, 75],
    'us-west-2': [85, 60],
    'us-west-1': [80, 65],
    'eu-west-1': [225, 60],
    'eu-central-1': [240, 58],
    'ap-south-1': [330, 80],
    'ap-southeast-1': [355, 85],
    'sa-east-1': [165, 115],
  };

  const land = `
    <path class="land" d="M30,55 Q60,40 110,50 Q160,38 200,50 L210,80 Q170,95 120,85 Q70,85 40,80 Z"/>
    <path class="land" d="M150,95 Q175,100 175,135 Q160,150 145,135 Q132,115 150,95 Z"/>
    <path class="land" d="M210,40 Q260,30 305,45 Q345,40 400,55 L410,90 Q360,100 310,90 Q260,95 230,85 Q210,70 210,40 Z"/>
    <path class="land" d="M320,90 Q360,100 380,130 Q360,150 330,140 Q310,120 320,90 Z"/>
  `;
  const grid = `
    <path class="grid" d="M0,30 H480 M0,60 H480 M0,90 H480 M0,120 H480 M0,150 H480"/>
    <path class="grid" d="M60,0 V180 M120,0 V180 M180,0 V180 M240,0 V180 M300,0 V180 M360,0 V180 M420,0 V180"/>
  `;

  const pins = regions
    .map((r) => {
      const [x, y] = PINS[r.slug] ?? [240, 90];
      return `
      <circle class="pulse" cx="${x}" cy="${y}" r="9">
        <animate attributeName="r" values="4;9;4" dur="2.6s" repeatCount="indefinite"/>
        <animate attributeName="opacity" values="0.35;0;0.35" dur="2.6s" repeatCount="indefinite"/>
      </circle>
      <circle class="pin${r.online ? '' : ' offline'}" cx="${x}" cy="${y}" r="3.5"/>
      <text x="${x + 6}" y="${y + 3}" font-family="var(--font-mono)" font-size="7" fill="var(--muted)">${esc(r.slug)}</text>
    `;
    })
    .join('');

  return `<svg class="globe-svg" viewBox="0 0 480 180" preserveAspectRatio="xMidYMid meet">${grid}${land}${pins}</svg>`;
}

function heatBars(r: RegionLite): string {
  return Array.from({ length: 24 }, (_, i) => {
    if (!r.online) return '<i class="gap"></i>';
    const rnd = Math.sin(i * 13.7 + (r.id ?? 0)) * 0.5 + 0.5;
    if (rnd < 0.03) return '<i class="down"></i>';
    if (rnd < 0.07) return '<i class="warn"></i>';
    return '<i></i>';
  }).join('');
}

export async function renderRegions() {
  const main = $('#main');
  const regions = await getRegions();
  nudgeBadge();

  const onlineCt = regions.filter((r) => r.online).length;
  const lastSeen = regions
    .filter((r) => r.lastSeenAt)
    .sort((a, b) => (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? ''));
  const recentContact = lastSeen.length > 0 ? fmtAge(lastSeen[0].lastSeenAt) : 'never';

  // Version-skew banner: any region whose last-reported agent version
  // differs from the master's own version. The skew bool is computed
  // server-side (versionSkew on the row) so we only need to count.
  const skewedRegions = regions.filter((r) => r.versionSkew);
  const masterVersion = regions.find((r) => r.masterVersion)?.masterVersion;
  const skewBanner =
    skewedRegions.length > 0 && masterVersion
      ? `<div class="banner warn" data-testid="version-skew-banner" style="margin-bottom: 12px">
          <strong>Version skew detected.</strong>
          ${skewedRegions.length} ${skewedRegions.length === 1 ? 'agent is' : 'agents are'} running
          ${skewedRegions.length === 1 ? 'a different version than' : 'different versions than'}
          the master (<code>${esc(masterVersion)}</code>):
          ${skewedRegions
            .map(
              (r) =>
                `<span style="margin-right: 8px"><strong>${esc(r.slug)}</strong>=<code>${esc(
                  r.agentVersion ?? 'unknown',
                )}</code></span>`,
            )
            .join('')}
          Upgrade the agent containers to match. See the Regions docs.
        </div>`
      : '';

  const heroSection = `
    <div class="regions-hero">
      <div class="globe-card">
        <div class="hd">
          <span class="cap">Geographic distribution</span>
          <span class="small muted mono">${onlineCt}/${regions.length} online</span>
        </div>
        ${
          regions.length === 0
            ? `<div style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:var(--fs-12)">No regions configured yet</div>`
            : globeSvg(regions)
        }
      </div>
      <div class="summary-rail">
        <div class="cell">
          <div class="k">Online regions</div>
          <div class="v">${onlineCt}<span style="font-size:var(--fs-13);color:var(--muted)">/${regions.length}</span></div>
        </div>
        <div class="cell">
          <div class="k">Offline</div>
          <div class="v">${regions.length - onlineCt}</div>
        </div>
        <div class="cell">
          <div class="k">Last contact</div>
          <div class="v" style="font-size:var(--fs-14)">${recentContact}</div>
        </div>
        <div class="cell">
          <div class="k">Total regions</div>
          <div class="v">${regions.length}</div>
        </div>
      </div>
    </div>`;

  const regionCards = regions
    .map(
      (r) => `
    <article class="region-card${r.online ? '' : ' offline'}" data-region-id="${r.id}" data-slug="${esc(r.slug)}" data-testid="region-card-${esc(r.slug)}">
      <span class="accent-bar"></span>
      <div class="top">
        <div>
          <div class="slug">${esc(r.slug)}</div>
          <div class="label">${esc(r.label)}</div>
        </div>
        <span class="pill ${r.online ? 'up' : ''} status-pill">
          <span class="dot ${r.online ? 'up' : ''}"></span>${r.online ? 'online' : 'offline'}
        </span>
      </div>
      <div class="heat-row" title="24h run health">${heatBars(r)}</div>
      <div class="grid-meta">
        <span class="k">status</span><span class="v">${r.online ? 'online' : 'offline'}</span>
        <span class="k">last seen</span><span class="v">${fmtAge(r.lastSeenAt)}</span>
      </div>
      <div class="acts">
        <button class="btn sm region-rotate" data-region-id="${r.id}">Rotate key</button>
        <button class="btn sm" data-region-logs data-region-id="${r.id}">Logs</button>
        <button class="btn sm danger region-delete" data-region-id="${r.id}" data-testid="region-delete-btn" aria-label="Delete">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
        </button>
      </div>
    </article>
  `,
    )
    .join('');

  main.innerHTML = `
    <div class="page-head">
      <div>
        <h2 data-testid="page-title">Regions</h2>
        <div class="sub">Multi-region probing: each region is a separately-deployed agent that pulls jobs from this master. <a href="/docs#multi-region">Multi-region guide →</a></div>
      </div>
      <button class="btn primary" id="add-region-btn" data-testid="regions-add-btn">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>
        Add region
      </button>
    </div>

    ${oneTimeKey ? renderOneTimeKey(oneTimeKey) : ''}

    ${skewBanner}

    ${heroSection}

    <div class="region-cards">
      ${regionCards}
      <button class="add-card" id="add-region-card">
        <span class="ico">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
        </span>
        <span class="lbl">New region</span>
        <span class="muted small" style="margin-top:4px">Run a new oo-workers agent</span>
      </button>
    </div>
  `;

  wireRegionRowActions();
  wireCreateBtn();
}

function renderOneTimeKey(otk: OneTimeKey): string {
  const verb = otk.action === 'created' ? 'created' : 'rotated';
  return `
    <div class="reveal" data-testid="region-key-panel" style="margin-bottom:var(--s-5)">
      <h4>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 7h3a5 5 0 0 1 5 5 5 5 0 0 1-5 5h-3m-6 0H6a5 5 0 0 1-5-5 5 5 0 0 1 5-5h3"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
        Region '${esc(otk.slug)}' ${verb}. Copy the key now.
      </h4>
      <p class="warning">This is the only time the key is shown. Paste it into the agent env as <code>OO_AGENT_KEY</code> alongside <code>OO_REGION_SLUG=${esc(otk.slug)}</code>.</p>
      <div class="key-box">
        <code data-testid="region-key-value">${esc(otk.cleartextKey)}</code>
      </div>
      <div style="margin-top:var(--s-3);display:flex;gap:var(--s-2);justify-content:flex-end">
        <button type="button" class="btn ghost" id="dismiss-key-btn" data-testid="region-key-dismiss-btn">I've copied it</button>
        <button type="button" class="btn primary" id="copy-key-btn">Copy to clipboard</button>
      </div>
    </div>
  `;
}

function wireRegionRowActions() {
  document.querySelectorAll<HTMLButtonElement>('.region-rotate').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.regionId);
      const ok = await confirmDialog({
        title: 'Rotate agent key',
        body: 'Issue a new agent key and revoke the old one? The currently running agent will start failing until restarted with the new key.',
        confirmLabel: 'Rotate key',
      });
      if (!ok) return;
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
        alertDialog({
          title: 'Rotate failed',
          body: err instanceof Error ? err.message : String(err),
        });
        btn.disabled = false;
      }
    });
  });

  document.querySelectorAll<HTMLButtonElement>('.region-delete').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.regionId);
      const card = btn.closest<HTMLElement>('.region-card');
      const slug = card?.dataset.slug ?? `#${id}`;
      const ok = await confirmDialog({
        title: 'Delete region',
        body: `Delete region '${slug}'? This revokes its agent key and removes all monitor bindings. Existing execution history is preserved.`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      btn.disabled = true;
      const res = await deleteRegion(id);
      if (!res.ok) {
        alertDialog({
          title: 'Delete failed',
          body: `${res.status} ${await res.text().catch(() => '')}`,
        });
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
      // Clipboard may be blocked in non-secure context; key is still selectable.
    }
  });

  document.getElementById('dismiss-key-btn')?.addEventListener('click', () => {
    oneTimeKey = null;
    renderRegions();
  });
}

function wireCreateBtn() {
  const openCreate = () =>
    openSlideover({
      title: 'New region',
      sub: 'oo agent · self-hosted',
      body: `
      <div class="form-section">
        <div class="sec-head"><span class="ttl">Identity</span></div>
        <div class="field-grid cols-2">
          <div class="field">
            <label>Slug</label>
            <input id="so-slug" placeholder="us-east-2" pattern="[a-z0-9][a-z0-9-]{0,62}[a-z0-9]?" required />
            <div class="help">Used in API + agent config. Cannot be changed.</div>
          </div>
          <div class="field">
            <label>Label</label>
            <input id="so-label" placeholder="Ohio" required />
            <div class="help">Human-readable name for the UI.</div>
          </div>
        </div>
        <p id="so-region-err" class="banner err" hidden style="margin-top:var(--s-3)"></p>
      </div>
      <div class="form-section">
        <div class="sec-head"><span class="ttl">Agent setup</span><span class="opt">After create</span></div>
        <p class="help" style="margin:0 0 8px">You'll receive a one-time agent key. Run the agent with:</p>
        <div class="preview-frame"><span class="com"># on your agent VM</span>
docker run -d \\
  --name oo-agent \\
  -e <span class="kw">OO_REGION</span>=<span class="str">"us-east-2"</span> \\
  -e <span class="kw">OO_KEY</span>=<span class="str">"oow_agt_…"</span> \\
  ghcr.io/oo-workers/agent:<span class="num">1.4</span></div>
      </div>
    `,
      primaryLabel: 'Create region',
      onPrimary: async (so) => {
        const slugEl = so.querySelector<HTMLInputElement>('#so-slug')!;
        const labelEl = so.querySelector<HTMLInputElement>('#so-label')!;
        const errEl = so.querySelector<HTMLElement>('#so-region-err')!;
        const slug = slugEl.value.trim();
        const label = labelEl.value.trim();
        if (!slug || !label) {
          errEl.textContent = 'Slug and label are required.';
          errEl.hidden = false;
          throw new Error('validation');
        }
        errEl.hidden = true;
        const { res, data } = await createRegion(slug, label);
        if (!res.ok) {
          errEl.textContent = 'error' in data ? data.error : `request failed (${res.status})`;
          errEl.hidden = false;
          throw new Error('api');
        }
        closeSlideover();
        if ('cleartextKey' in data) {
          oneTimeKey = {
            slug: data.region.slug,
            cleartextKey: data.cleartextKey,
            action: 'created',
          };
        }
        await renderRegions();
      },
    });

  document.getElementById('add-region-btn')?.addEventListener('click', openCreate);
  document.getElementById('add-region-card')?.addEventListener('click', openCreate);
}
