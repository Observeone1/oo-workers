import type { MonType } from '../types';
import { createMonitor, updateMonitor, setMonitorChannels, setMonitorRegions } from '../api';
import { renderList, setActiveTab } from '../list';
import { alertDialog } from '../dialogs';
import { buildMonitorBodyFromForm } from './add-monitor-form-body';

const DETAIL_HASH_RE = /^#\/(?:url|api|qa|tcp|udp|db|tls|heartbeat)\/\d+$/;

export type AddMonitorSubmitCtx = {
  form: HTMLFormElement;
  dialog: HTMLDialogElement;
  getType: () => MonType;
  getEditModeId: () => number | null;
  setEditModeId: (id: number | null) => void;
  syncFields: () => void;
  collectRegionIds: () => number[];
  collectChannelIds: () => number[];
};

async function bindMonitorAssociations(
  type: MonType,
  monitorId: number,
  regionIds: number[],
  channelIds: number[],
): Promise<void> {
  if (regionIds.length > 0) {
    try {
      await setMonitorRegions(type, monitorId, regionIds);
    } catch (err) {
      alertDialog({
        title: 'Region binding failed',
        body: `Monitor created but region binding failed: ${
          err instanceof Error ? err.message : String(err)
        }. Fix it from the Regions page.`,
      });
    }
  }
  if (channelIds.length > 0) {
    try {
      await setMonitorChannels(type, monitorId, channelIds);
    } catch (err) {
      alertDialog({
        title: 'Channel binding failed',
        body: `Monitor created but alert-channel binding failed: ${
          err instanceof Error ? err.message : String(err)
        }. Fix it from the Channels page.`,
      });
    }
  }
}

function navigateAfterSubmit(
  type: MonType,
  editModeId: number | null,
  editedId: number | null,
): void {
  const cameFromDetail = DETAIL_HASH_RE.test(location.hash);
  if (editModeId === null) {
    setActiveTab(type);
    if (cameFromDetail) location.hash = '#/';
    else renderList();
    return;
  }
  if (cameFromDetail && editedId !== null) {
    location.hash = `#/${type}/${editedId}`;
    return;
  }
  setActiveTab(type);
  renderList();
}

export async function handleAddMonitorSubmit(ctx: AddMonitorSubmitCtx): Promise<void> {
  const type = ctx.getType();
  const editModeId = ctx.getEditModeId();
  const built = buildMonitorBodyFromForm(type, new FormData(ctx.form), ctx.dialog);
  if (!built.ok) {
    alertDialog({ title: 'Validation error', body: built.message });
    return;
  }

  const res =
    editModeId === null
      ? await createMonitor(type, built.body)
      : await updateMonitor(type, editModeId, built.body);
  if (!res.ok) {
    const label = editModeId === null ? 'Create failed' : 'Update failed';
    alertDialog({ title: label, body: `Failed: ${await res.text()}` });
    return;
  }

  const created = (await res.json().catch(() => null)) as { id?: number } | null;
  if (created?.id) {
    await bindMonitorAssociations(
      type,
      created.id,
      ctx.collectRegionIds(),
      ctx.collectChannelIds(),
    );
  }

  const editedId = editModeId;
  ctx.dialog.close();
  ctx.form.reset();
  ctx.syncFields();
  ctx.setEditModeId(null);
  navigateAfterSubmit(type, editModeId, editedId);
}
