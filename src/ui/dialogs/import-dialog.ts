/**
 * The bulk-import dialog. Paste JSON, parse, POST /api/import, surface
 * the response counters + skip notes + ACTION-NEEDED warnings. Used to
 * onboard a SaaS export.
 */
import { $ } from '../helpers';
import { importJson } from '../api';
import { renderList } from '../list';
import { alertDialog } from '../dialogs';

export function initImportDialog(): void {
  const importDialog = $<HTMLDialogElement>('#import-dialog');

  $('#import-btn').addEventListener('click', () => importDialog.showModal());
  $('#import-cancel').addEventListener('click', () => importDialog.close());
  // New design also has a close button in the dialog-head
  importDialog.querySelectorAll('[data-close-import-dialog]').forEach((btn) => {
    btn.addEventListener('click', () => importDialog.close());
  });
  $('#import-submit').addEventListener('click', async () => {
    const text = $<HTMLTextAreaElement>('#import-text').value.trim();
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      alertDialog({ title: 'Import error', body: 'Not valid JSON' });
      return;
    }
    const { res, result } = await importJson(payload);
    if (!res.ok) {
      alertDialog({ title: 'Import failed', body: `Failed: ${JSON.stringify(result)}` });
      return;
    }
    const warnings = result.warnings?.length
      ? `\n\n⚠ ACTION NEEDED — imported but won’t fully work yet:\n${result.warnings
          .map((w) => `• ${w}`)
          .join('\n')}`
      : '';
    const skipped = result.skipped?.length ? `\n\nSkipped:\n${result.skipped.join('\n')}` : '';
    alertDialog({
      title: 'Import complete',
      body:
        `Created url=${result.url}, api=${result.api}, qa=${result.qa}, ` +
        `channels=${result.channels}${warnings}${skipped}`,
    });
    importDialog.close();
    renderList();
  });
}
