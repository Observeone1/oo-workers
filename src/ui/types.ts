export type MonType = 'url' | 'api' | 'qa';

export interface RunLite {
  id: number;
  status: string;
  statusCode?: number | null;
  responseTimeMs?: number | null;
  durationMs?: number | null;
  errorMessage?: string | null;
  startTime: string;
}

export interface Monitor {
  id: number;
  name: string;
  type: MonType;
  enabled: boolean;
  intervalSeconds: number;
  url?: string;
  targetUrl?: string;
  latest?: RunLite | null;
  testCount?: number;
}

export interface MonitorsByType {
  url: Monitor[];
  api: Monitor[];
  qa: Monitor[];
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
  skipped?: string[];
}
