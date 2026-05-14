export type MonType = 'url' | 'api' | 'qa' | 'tcp' | 'udp';

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
  latest?: RunLite | null;
  testCount?: number;
}

export interface MonitorsByType {
  url: Monitor[];
  api: Monitor[];
  qa: Monitor[];
  tcp: Monitor[];
  udp: Monitor[];
}

export interface MonitorDetail {
  monitor: Monitor & Record<string, unknown>;
  runs: RunLite[];
  error?: string;
}

export interface ImportResult {
  url: number;
  api: number;
  qa: number;
  tcp: number;
  udp: number;
  skipped?: string[];
}
