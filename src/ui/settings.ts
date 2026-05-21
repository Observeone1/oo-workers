/**
 * Settings page rail + router. The four sections (Profile, Security,
 * API keys, Backup & restore) each live in `src/ui/settings/*.ts` and
 * own their own DOM/state. This file only renders the sidebar rail and
 * delegates to the section's render function.
 */

import { $, esc } from './helpers';
import { renderProfile, type ProfileMe } from './settings/profile.ts';
import { renderSecurity } from './settings/security.ts';
import { renderKeys } from './settings/api-keys.ts';
import { renderBackup } from './settings/backup.ts';

type SettingsTab = 'profile' | 'security' | 'keys' | 'backup';

let activeTab: SettingsTab = 'profile';

const SECTIONS: {
  id: SettingsTab;
  label: string;
  sub: string;
  icon: string;
  hideForApiKey?: boolean;
}[] = [
  {
    id: 'profile',
    label: 'Profile',
    sub: 'Name, email and appearance',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
  },
  {
    id: 'security',
    label: 'Security',
    sub: 'Password and active sessions',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
    hideForApiKey: true,
  },
  {
    id: 'keys',
    label: 'API keys',
    sub: 'Programmatic + agent access',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="15" r="4"/><path d="m10.85 12.15 9.15-9.15M18 5l3 3M15 8l3 3"/></svg>',
  },
  {
    id: 'backup',
    label: 'Backup & restore',
    sub: 'Export config · roll back',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/></svg>',
  },
];

export async function renderSettings(tab?: SettingsTab): Promise<void> {
  if (tab) activeTab = tab;

  const main = $('#main');
  const meRes: ProfileMe = await fetch('/api/auth/me', { credentials: 'include' })
    .then((r) => r.json())
    .catch(() => ({}));
  const isApiKey = !!meRes.prefix;

  const initials = getInitials(meRes.name ?? meRes.email ?? '?');
  const visibleSections = SECTIONS.filter((s) => !(isApiKey && s.hideForApiKey));

  // If active tab got hidden (e.g. password when using API key), fall back
  if (!visibleSections.find((s) => s.id === activeTab)) activeTab = 'profile';

  const rail = visibleSections
    .map(
      (s) => `
    <button class="set-step${s.id === activeTab ? ' active' : ''}" data-section="${s.id}" data-testid="settings-tab-${s.id}">
      <span class="ico">${s.icon}</span>
      <span class="lbl">
        <span class="t">${s.label}</span>
        <span class="d">${s.sub}</span>
      </span>
    </button>
  `,
    )
    .join('');

  main.innerHTML = `
    <div class="page-head">
      <div>
        <h2>Settings</h2>
        <div class="sub">Manage your account, security and instance data.</div>
      </div>
      <div class="row-flex" style="gap:8px">
        ${meRes.role ? `<span class="pill${meRes.role === 'admin' ? ' up' : ''}">${esc(meRes.role)}</span>` : ''}
      </div>
    </div>

    <div class="settings-layout">
      <aside class="settings-rail">
        <div class="set-id">
          <span class="avatar">${esc(initials)}</span>
          <span class="who">
            <span class="n">${esc(meRes.name ?? '—')}</span>
            <span class="e">${esc(meRes.email ?? '')}</span>
          </span>
        </div>
        <nav class="set-nav">${rail}</nav>
        <div class="set-foot">
          <div class="k">Instance</div>
          <div class="v mono">oo-workers</div>
          <div class="k" style="margin-top:8px">License</div>
          <div class="v mono">self-host · Apache-2.0</div>
        </div>
      </aside>
      <section class="settings-content" id="settings-content"></section>
    </div>
  `;

  document.querySelectorAll<HTMLButtonElement>('.set-step').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeTab = btn.dataset.section as SettingsTab;
      document.querySelectorAll('.set-step').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      void renderPanel(meRes, initials);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

  await renderPanel(meRes, initials);
}

async function renderPanel(meRes: ProfileMe, initials: string): Promise<void> {
  const panel = document.getElementById('settings-content');
  if (!panel) return;
  switch (activeTab) {
    case 'profile':
      return renderProfile(panel, meRes, initials);
    case 'security':
      return renderSecurity(panel);
    case 'keys':
      return renderKeys(panel);
    case 'backup':
      return renderBackup(panel);
  }
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}
