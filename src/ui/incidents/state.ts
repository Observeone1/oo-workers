/**
 * Shared state + helpers for the incidents list + editor views.
 * Module-local state (selectedPageId, filter, lastBanner) is held in
 * a plain object so both views read/write the same values without
 * import-binding gymnastics.
 */
import { esc } from '../helpers';
import type { Severity } from '../api';

export const SEVERITIES: Severity[] = ['investigating', 'identified', 'monitoring', 'resolved'];

export const SEV_LABEL: Record<Severity, string> = {
  investigating: 'Investigating',
  identified: 'Identified',
  monitoring: 'Monitoring',
  resolved: 'Resolved',
};

export const SEV_COLOR: Record<Severity, string> = {
  investigating: '#d97706',
  identified: '#ea580c',
  monitoring: '#65a30d',
  resolved: '#16a34a',
};

export interface IncidentsState {
  selectedPageId: number | null;
  filter: 'all' | 'active' | 'resolved';
  lastBanner: { kind: 'ok' | 'err'; text: string } | null;
  // Tracked in state so the panel survives a renderList() triggered
  // by the page-select change or filter-tab click — without this, any
  // page selector change immediately closes the open panel and loses
  // the operator's in-progress typing.
  createPanelOpen: boolean;
}

export const state: IncidentsState = {
  selectedPageId: null,
  filter: 'all',
  lastBanner: null,
  createPanelOpen: false,
};

export function renderBanner(b: { kind: 'ok' | 'err'; text: string }): string {
  return `<div class="banner banner-${b.kind}" data-testid="banner-${b.kind}">${esc(b.text)}</div>`;
}

export function sevPill(s: string): string {
  const sev = (SEVERITIES as string[]).includes(s) ? (s as Severity) : 'investigating';
  return `<span class="sev-pill sev-${sev}">${esc(SEV_LABEL[sev])}</span>`;
}
