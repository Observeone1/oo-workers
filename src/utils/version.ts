// Shared package-version lookup used by the master (compare against
// agent.X-Agent-Version on /api/regions GET) and the agent itself
// (sends as X-Agent-Version on every poll). Cached after first read
// since package.json never changes at runtime.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let cached: string | null = null;

export function packageVersion(): string {
  if (cached !== null) return cached;
  try {
    const raw = readFileSync(resolve(import.meta.dir, '../../package.json'), 'utf8');
    cached = (JSON.parse(raw) as { version: string }).version ?? 'unknown';
  } catch {
    cached = 'unknown';
  }
  return cached;
}
