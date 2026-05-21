/**
 * Settings → Backup & restore section. Download (with optional artifacts +
 * scope picker) + drop-zone restore (with destructive confirm).
 */
import { backupEstimate, backupUrl, restoreBackup } from '../api';
import { confirmDialog, alertDialog } from '../dialogs';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  const mb = n / (1024 * 1024);
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

export function renderBackup(panel: HTMLElement): void {
  panel.innerHTML = `
    <div class="set-section-head">
      <div>
        <h3>Backup &amp; restore</h3>
        <p class="sub">Export your monitors, channels, regions and status pages. Restore from an earlier snapshot.</p>
      </div>
    </div>

    <div class="backup-hero">
      <div class="cell">
        <div class="k">Download scope</div>
        <div class="v">Config + history</div>
        <div class="sub">last 90 days of runs</div>
      </div>
      <div class="cell">
        <div class="k">Format</div>
        <div class="v">.tar.gz</div>
        <div class="sub">gzipped JSON dump</div>
      </div>
    </div>

    <div class="set-card">
      <div class="form-section" style="border:none;padding:0;margin:0">
        <div class="sec-head"><span class="ttl">Download backup</span></div>
        <p class="help" style="margin-bottom:var(--s-3)">Full logical dump of config + execution history. Restore replaces <strong>all</strong> data.</p>
        <div class="field">
          <label>History window</label>
          <div class="seg-inline" id="s-scope-seg">
            <button data-val="window" data-testid="backup-scope-window" class="seg-btn on">Last 90 days</button>
            <button data-val="all" data-testid="backup-scope-all" class="seg-btn">All history</button>
            <button data-val="none" data-testid="backup-scope-none" class="seg-btn">Config only</button>
          </div>
        </div>
        <div class="field" style="margin-top:var(--s-3)">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
            <input type="checkbox" id="s-include-artifacts" data-testid="backup-include-artifacts" checked />
            <span>Include browser run artifacts <span id="s-artifacts-estimate" class="opt"></span></span>
          </label>
          <p class="help" style="margin-top:6px">QA test scripts and Playwright trace/screenshot files for failed browser runs. Without these, a restored host has dangling references.</p>
        </div>
        <div style="margin-top:var(--s-4);display:flex;justify-content:flex-end">
          <button class="btn primary" id="s-backup-download" data-testid="backup-download-btn">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Download
          </button>
        </div>
      </div>
    </div>

    <div class="set-card">
      <div class="form-section" style="border:none;padding:0;margin:0">
        <div class="sec-head"><span class="ttl">Restore from file</span><span class="opt">accepts .tar.gz</span></div>
        <label class="drop-zone" id="s-drop-zone">
          <div class="ico">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5-5 5 5M12 5v15"/></svg>
          </div>
          <div class="t">Drop a backup file here or <span class="link-look">browse</span></div>
          <div class="d mono">.tar.gz · up to 50 MB</div>
          <input type="file" id="s-backup-file" accept=".gz,application/gzip" hidden />
        </label>
        <p class="help" style="margin-top:8px">A restore wipes all current monitors, channels, regions and status pages and replaces them with the backup. This cannot be undone.</p>
        <p id="s-restore-err" class="banner err" hidden></p>
        <div style="margin-top:var(--s-3);display:flex;justify-content:flex-end">
          <button class="btn danger" id="s-backup-restore">Restore from file</button>
        </div>
      </div>
    </div>
  `;

  // Scope segmented control
  panel.querySelectorAll<HTMLButtonElement>('#s-scope-seg button').forEach((btn) => {
    btn.addEventListener('click', () => {
      panel.querySelectorAll('#s-scope-seg button').forEach((b) => b.classList.remove('on'));
      btn.classList.add('on');
    });
  });

  // Artifacts estimate — fetch once on mount; tag onto the checkbox label.
  // No warning threshold: just show the count + size next to the label.
  const estimateEl = panel.querySelector<HTMLElement>('#s-artifacts-estimate');
  const artifactsBox = panel.querySelector<HTMLInputElement>('#s-include-artifacts');
  if (estimateEl) {
    void backupEstimate().then((est) => {
      if (est.artifactCount === 0) {
        estimateEl.textContent = '(no artifacts yet)';
        return;
      }
      const size = formatBytes(est.artifactBytes);
      estimateEl.textContent = `(~${est.artifactCount} object${est.artifactCount === 1 ? '' : 's'}, ${size})`;
    });
  }

  // Download
  panel.querySelector('#s-backup-download')?.addEventListener('click', () => {
    const scope =
      panel.querySelector<HTMLButtonElement>('#s-scope-seg button.on')?.dataset.val ?? 'window';
    const includeArtifacts = artifactsBox?.checked ?? true;
    const a = document.createElement('a');
    a.href = backupUrl(scope, 90, includeArtifacts);
    a.click();
  });

  // Drop zone
  const drop = panel.querySelector<HTMLElement>('#s-drop-zone');
  if (drop) {
    ['dragenter', 'dragover'].forEach((ev) =>
      drop.addEventListener(ev, (e) => {
        e.preventDefault();
        drop.classList.add('over');
      }),
    );
    ['dragleave', 'drop'].forEach((ev) =>
      drop.addEventListener(ev, (e) => {
        e.preventDefault();
        drop.classList.remove('over');
      }),
    );
  }

  // Restore
  panel.querySelector('#s-backup-restore')?.addEventListener('click', async () => {
    const input = panel.querySelector<HTMLInputElement>('#s-backup-file')!;
    const file = input.files?.[0];
    const errEl = panel.querySelector<HTMLElement>('#s-restore-err')!;
    errEl.hidden = true;
    if (!file) {
      errEl.textContent = 'Select a backup file first.';
      errEl.hidden = false;
      return;
    }
    const ok = await confirmDialog({
      title: 'Restore from backup',
      body: `Restoring "${file.name}" wipes every monitor, channel, and execution and replaces them with the backup. This cannot be undone.`,
      confirmLabel: 'Wipe and restore',
      danger: true,
    });
    if (!ok) return;
    const { res, result } = await restoreBackup(file, true);
    if (!res.ok) {
      errEl.textContent = result.error ?? `Restore failed (${res.status})`;
      errEl.hidden = false;
      return;
    }
    const total = Object.values(result.counts ?? {}).reduce(
      (a: number, b: unknown) => a + (b as number),
      0,
    );
    alertDialog({ title: 'Restore complete', body: `${total} rows restored.` });
  });

  // File input trigger on click (browse)
  const fileInput = panel.querySelector<HTMLInputElement>('#s-backup-file');
  drop?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('input[type="file"]')) return;
    fileInput?.click();
  });
}
