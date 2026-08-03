import type { MonType } from './types';
import { renderList } from './list';
import { renderDetail } from './detail';
import { renderRegions } from './regions';
import { renderChannels } from './channels';
import { renderStatusPages } from './status-pages';
import { renderIncidents } from './incidents';
import { renderSettings } from './settings';
import { renderDocs } from './docs-view';

type SectionRoute = 'regions' | 'channels' | 'status-pages' | 'incidents' | 'docs';

const SECTION_ROUTES: Array<{
  prefix: string;
  route: SectionRoute;
  render: (hash: string) => void;
}> = [
  { prefix: '#/regions', route: 'regions', render: () => renderRegions() },
  { prefix: '#/channels', route: 'channels', render: () => renderChannels() },
  { prefix: '#/status-pages', route: 'status-pages', render: () => renderStatusPages() },
  { prefix: '#/incidents', route: 'incidents', render: () => renderIncidents() },
  {
    prefix: '#/docs',
    route: 'docs',
    render: (hash) => renderDocs(hash.startsWith('#/docs/') ? hash.slice('#/docs/'.length) : null),
  },
];

const DETAIL_RE = /^#\/(url|api|qa|tcp|udp|db|tls|heartbeat)\/(\d+)$/;

export function routeAppHash(
  hash: string,
  setActiveNav: (route: SectionRoute | 'list' | null) => void,
): void {
  if (hash === '#/settings') {
    setActiveNav(null);
    renderSettings();
    return;
  }
  for (const { prefix, route, render } of SECTION_ROUTES) {
    if (hash === prefix || hash.startsWith(prefix + '/')) {
      setActiveNav(route);
      render(hash);
      return;
    }
  }
  const m = DETAIL_RE.exec(hash);
  if (m) {
    setActiveNav(null);
    renderDetail(m[1] as MonType, Number(m[2]));
    return;
  }
  setActiveNav('list');
  renderList();
}
