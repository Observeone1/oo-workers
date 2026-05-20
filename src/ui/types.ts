export type MonType = 'url' | 'api' | 'qa' | 'tcp' | 'udp' | 'db' | 'tls' | 'heartbeat';

export interface RunLite {
  id: number;
  status: string;
  statusCode?: number | null;
  responseTimeMs?: number | null;
  durationMs?: number | null;
  errorMessage?: string | null;
  startTime: string;
  regionId?: number | null;
  /** QA-only: bucket key for the Playwright trace.zip (failed runs). */
  traceUrl?: string | null;
  /** QA-only: bucket keys for per-failure screenshots (failed runs). */
  screenshotUrls?: string[] | null;
}

export interface Monitor {
  id: number;
  name: string;
  type: MonType;
  enabled: boolean;
  intervalSeconds: number;
  url?: string;
  targetUrl?: string;
  host?: string;
  port?: number;
  protocol?: string;
  latest?: RunLite | null;
  testCount?: number;
  // Heartbeat-only: bundled together because the detail/list views
  // need them for the public URL + status surface. periodSeconds maps
  // to intervalSeconds conceptually but the worker doesn't run on it.
  token?: string;
  periodSeconds?: number;
  graceSeconds?: number;
  lastPingAt?: string | null;
  status?: 'PENDING' | 'UP' | 'OVERDUE';
}

export interface MonitorsByType {
  url: Monitor[];
  api: Monitor[];
  qa: Monitor[];
  tcp: Monitor[];
  udp: Monitor[];
  db: Monitor[];
  tls: Monitor[];
  heartbeat: Monitor[];
}

export interface MonitorDetail {
  monitor: Monitor & Record<string, unknown>;
  runs: RunLite[];
  error?: string;
}

export interface AvailabilityDay {
  date: string; // YYYY-MM-DD
  total: number;
  passed: number;
}

export interface ImportResult {
  url: number;
  api: number;
  qa: number;
  tcp: number;
  udp: number;
  channels: number;
  skipped?: string[];
  // Imported, but won't fully work without operator follow-up (e.g.
  // monitors have no alert-channel bindings yet). Server-emitted.
  warnings?: string[];
}
