/**
 * Themed dialog primitives + the orchestrator that wires up every named
 * dialog at boot.
 *
 * - `confirmDialog({ title, body, confirmLabel?, danger? })` — themed
 *   modal confirm. Returns true if the user clicked the primary button.
 * - `alertDialog({ title, body })` — themed modal alert. Resolves when
 *   dismissed.
 * - `initDialogs()` — called once at boot from `app.ts`. Currently mounts
 *   the add-monitor and import dialogs. Add a new line here when a new
 *   named dialog joins the bundle.
 *
 * Dialog implementations live in `src/ui/dialogs/*.ts` — keeping them
 * out of this file means a reader looking up `confirmDialog` doesn't
 * have to page past 400 lines of add-monitor form wiring.
 */

import { initAddDialog } from './dialogs/add-monitor-dialog.ts';
import { initImportDialog } from './dialogs/import-dialog.ts';

let confirmDialogEl: HTMLDialogElement | null = null;
let alertDialogEl: HTMLDialogElement | null = null;

function getConfirmDialog(): HTMLDialogElement {
  if (!confirmDialogEl) {
    confirmDialogEl = document.createElement('dialog');
    confirmDialogEl.id = 'confirm-dialog';
    confirmDialogEl.className = 'confirm-dialog';
    confirmDialogEl.innerHTML = `
      <div class="confirm-dialog-inner">
        <h3 id="confirm-title"></h3>
        <p id="confirm-body"></p>
        <div class="dialog-actions">
          <button type="button" class="confirm-cancel" data-testid="confirm-cancel">Cancel</button>
          <button type="button" class="confirm-ok primary" data-testid="confirm-ok"></button>
        </div>
      </div>
    `;
    document.body.appendChild(confirmDialogEl);

    // Wire up explicit close handlers — more reliable than form method="dialog".
    confirmDialogEl.querySelector('.confirm-cancel')!.addEventListener('click', () => {
      confirmDialogEl!.close('cancel');
    });
    confirmDialogEl.querySelector('.confirm-ok')!.addEventListener('click', () => {
      confirmDialogEl!.close('confirm');
    });
  }
  return confirmDialogEl;
}

function getAlertDialog(): HTMLDialogElement {
  if (!alertDialogEl) {
    alertDialogEl = document.createElement('dialog');
    alertDialogEl.id = 'alert-dialog';
    alertDialogEl.className = 'alert-dialog';
    alertDialogEl.innerHTML = `
      <div class="alert-dialog-inner">
        <h3 id="alert-title"></h3>
        <p id="alert-body"></p>
        <div class="dialog-actions">
          <button type="button" class="alert-ok primary">OK</button>
        </div>
      </div>
    `;
    document.body.appendChild(alertDialogEl);

    alertDialogEl.querySelector('.alert-ok')!.addEventListener('click', () => {
      alertDialogEl!.close('ok');
    });
  }
  return alertDialogEl;
}

/**
 * Show a themed confirmation dialog. Returns true if the user confirmed.
 */
export function confirmDialog(opts: {
  title: string;
  body: string;
  confirmLabel?: string;
  danger?: boolean;
}): Promise<boolean> {
  const dlg = getConfirmDialog();
  const titleEl = dlg.querySelector('#confirm-title')!;
  const bodyEl = dlg.querySelector('#confirm-body')!;
  const okBtn = dlg.querySelector('.confirm-ok') as HTMLButtonElement;

  titleEl.textContent = opts.title;
  bodyEl.textContent = opts.body;
  okBtn.textContent = opts.confirmLabel ?? 'Confirm';
  okBtn.className = `confirm-ok primary${opts.danger ? ' danger' : ''}`;

  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'confirm'), { once: true });
    dlg.showModal();
  });
}

/**
 * Show a themed alert dialog. Resolves when dismissed.
 */
export function alertDialog(opts: { title: string; body: string }): Promise<void> {
  const dlg = getAlertDialog();
  dlg.querySelector('#alert-title')!.textContent = opts.title;
  dlg.querySelector('#alert-body')!.textContent = opts.body;

  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(), { once: true });
    dlg.showModal();
  });
}

export function initDialogs(): void {
  initAddDialog();
  initImportDialog();
}
