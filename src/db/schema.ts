// .default() literals below are duplicated in src/constants.ts (DEFAULTS).
// Drizzle's .default() requires a literal, so the schema can't import them.
// If you change a default here, update DEFAULTS as well.
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';

// ============================================================
// URL monitoring
// ============================================================

export const urlMonitors = pgTable('url_monitors', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  url: text('url').notNull(),
  timeoutMs: integer('timeout_ms').notNull().default(30000),
  alertOnFailure: boolean('alert_on_failure').notNull().default(true),
  intervalSeconds: integer('interval_seconds').notNull().default(60),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const urlMonitorAssertions = pgTable('url_monitor_assertions', {
  id: serial('id').primaryKey(),
  urlMonitorId: integer('url_monitor_id')
    .notNull()
    .references(() => urlMonitors.id, { onDelete: 'cascade' }),
  operator: varchar('operator', { length: 50 }).notNull(),
  statusCode: integer('status_code').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const urlMonitorExecutions = pgTable(
  'url_monitor_executions',
  {
    id: serial('id').primaryKey(),
    urlMonitorId: integer('url_monitor_id')
      .notNull()
      .references(() => urlMonitors.id, { onDelete: 'cascade' }),
    regionId: integer('region_id').references(() => regions.id, { onDelete: 'set null' }),
    status: varchar('status', { length: 20 }).notNull(),
    statusCode: integer('status_code'),
    responseTimeMs: integer('response_time_ms'),
    errorMessage: text('error_message'),
    assertionResults: jsonb('assertion_results').$type<unknown[]>(),
    startTime: timestamp('start_time', { withTimezone: true }).notNull().defaultNow(),
    endTime: timestamp('end_time', { withTimezone: true }),
  },
  (t) => [
    index('idx_url_monitor_executions_monitor_id').on(t.urlMonitorId),
    index('idx_url_monitor_executions_start_time').on(t.startTime),
    index('idx_url_monitor_executions_region_id').on(t.regionId),
  ],
);

// ============================================================
// API monitoring
// ============================================================

export const apiChecks = pgTable('api_checks', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  url: text('url').notNull(),
  method: varchar('method', { length: 10 }).notNull().default('GET'),
  headers: jsonb('headers').$type<Record<string, string>>().default({}),
  body: text('body'),
  timeoutMs: integer('timeout_ms').notNull().default(5000),
  intervalSeconds: integer('interval_seconds').notNull().default(60),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const apiAssertions = pgTable('api_assertions', {
  id: serial('id').primaryKey(),
  apiCheckId: integer('api_check_id')
    .notNull()
    .references(() => apiChecks.id, { onDelete: 'cascade' }),
  type: varchar('type', { length: 50 }).notNull(),
  operator: varchar('operator', { length: 50 }).notNull(),
  path: varchar('path', { length: 255 }),
  value: text('value'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const apiExecutions = pgTable(
  'api_executions',
  {
    id: serial('id').primaryKey(),
    apiCheckId: integer('api_check_id')
      .notNull()
      .references(() => apiChecks.id, { onDelete: 'cascade' }),
    regionId: integer('region_id').references(() => regions.id, { onDelete: 'set null' }),
    status: varchar('status', { length: 20 }).notNull(),
    responseStatus: integer('response_status'),
    responseTimeMs: integer('response_time_ms'),
    responseBody: text('response_body'),
    responseHeaders: jsonb('response_headers').$type<Record<string, string>>(),
    errorMessage: text('error_message'),
    assertionResults: jsonb('assertion_results').$type<unknown[]>(),
    startTime: timestamp('start_time', { withTimezone: true }).notNull().defaultNow(),
    endTime: timestamp('end_time', { withTimezone: true }),
  },
  (t) => [
    index('idx_api_executions_check_id').on(t.apiCheckId),
    index('idx_api_executions_start_time').on(t.startTime),
    index('idx_api_executions_region_id').on(t.regionId),
  ],
);

// ============================================================
// TCP monitoring
// ============================================================

export const tcpMonitors = pgTable('tcp_monitors', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  host: varchar('host', { length: 255 }).notNull(),
  port: integer('port').notNull(),
  payloadHex: text('payload_hex'),
  expectBanner: text('expect_banner'),
  timeoutMs: integer('timeout_ms').notNull().default(5000),
  intervalSeconds: integer('interval_seconds').notNull().default(60),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const tcpExecutions = pgTable(
  'tcp_executions',
  {
    id: serial('id').primaryKey(),
    tcpMonitorId: integer('tcp_monitor_id')
      .notNull()
      .references(() => tcpMonitors.id, { onDelete: 'cascade' }),
    regionId: integer('region_id').references(() => regions.id, { onDelete: 'set null' }),
    status: varchar('status', { length: 20 }).notNull(),
    latencyMs: integer('latency_ms'),
    banner: text('banner'),
    errorMessage: text('error_message'),
    startTime: timestamp('start_time', { withTimezone: true }).notNull().defaultNow(),
    endTime: timestamp('end_time', { withTimezone: true }),
  },
  (t) => [
    index('idx_tcp_executions_monitor_id').on(t.tcpMonitorId),
    index('idx_tcp_executions_start_time').on(t.startTime),
    index('idx_tcp_executions_region_id').on(t.regionId),
  ],
);

// ============================================================
// UDP monitoring
// ============================================================

export const udpMonitors = pgTable('udp_monitors', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  host: varchar('host', { length: 255 }).notNull(),
  port: integer('port').notNull(),
  payloadHex: text('payload_hex'),
  expectResponse: boolean('expect_response').notNull().default(false),
  timeoutMs: integer('timeout_ms').notNull().default(5000),
  intervalSeconds: integer('interval_seconds').notNull().default(60),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const udpExecutions = pgTable(
  'udp_executions',
  {
    id: serial('id').primaryKey(),
    udpMonitorId: integer('udp_monitor_id')
      .notNull()
      .references(() => udpMonitors.id, { onDelete: 'cascade' }),
    regionId: integer('region_id').references(() => regions.id, { onDelete: 'set null' }),
    status: varchar('status', { length: 20 }).notNull(),
    latencyMs: integer('latency_ms'),
    responseBytes: integer('response_bytes'),
    errorMessage: text('error_message'),
    startTime: timestamp('start_time', { withTimezone: true }).notNull().defaultNow(),
    endTime: timestamp('end_time', { withTimezone: true }),
  },
  (t) => [
    index('idx_udp_executions_monitor_id').on(t.udpMonitorId),
    index('idx_udp_executions_start_time').on(t.startTime),
    index('idx_udp_executions_region_id').on(t.regionId),
  ],
);

export const dbMonitors = pgTable('db_monitors', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  protocol: varchar('protocol', { length: 16 }).notNull(),
  host: varchar('host', { length: 255 }).notNull(),
  port: integer('port').notNull(),
  timeoutMs: integer('timeout_ms').notNull().default(5000),
  intervalSeconds: integer('interval_seconds').notNull().default(60),
  tls: boolean('tls').notNull().default(false),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const dbExecutions = pgTable(
  'db_executions',
  {
    id: serial('id').primaryKey(),
    dbMonitorId: integer('db_monitor_id')
      .notNull()
      .references(() => dbMonitors.id, { onDelete: 'cascade' }),
    regionId: integer('region_id').references(() => regions.id, { onDelete: 'set null' }),
    status: varchar('status', { length: 20 }).notNull(),
    latencyMs: integer('latency_ms'),
    errorMessage: text('error_message'),
    startTime: timestamp('start_time', { withTimezone: true }).notNull().defaultNow(),
    endTime: timestamp('end_time', { withTimezone: true }),
  },
  (t) => [
    index('idx_db_executions_monitor_id').on(t.dbMonitorId),
    index('idx_db_executions_start_time').on(t.startTime),
    index('idx_db_executions_region_id').on(t.regionId),
  ],
);

// ============================================================
// TLS certificate-expiry monitoring
// ============================================================

export const tlsMonitors = pgTable('tls_monitors', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  host: varchar('host', { length: 255 }).notNull(),
  port: integer('port').notNull().default(443),
  servername: varchar('servername', { length: 255 }),
  warnDays: integer('warn_days').notNull().default(30),
  timeoutMs: integer('timeout_ms').notNull().default(5000),
  intervalSeconds: integer('interval_seconds').notNull().default(60),
  enabled: boolean('enabled').notNull().default(true),
  // 0018 — opt-in assertions, all default OFF (preserve self-signed
  // expiry-only posture). Independent: chain trust, hostname match, and
  // a regex the leaf CN or any DNS SAN must match.
  verifyChain: boolean('verify_chain').notNull().default(false),
  verifyHostname: boolean('verify_hostname').notNull().default(false),
  expectCnRegex: varchar('expect_cn_regex', { length: 255 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const tlsExecutions = pgTable(
  'tls_executions',
  {
    id: serial('id').primaryKey(),
    tlsMonitorId: integer('tls_monitor_id')
      .notNull()
      .references(() => tlsMonitors.id, { onDelete: 'cascade' }),
    regionId: integer('region_id').references(() => regions.id, { onDelete: 'set null' }),
    status: varchar('status', { length: 20 }).notNull(),
    latencyMs: integer('latency_ms'),
    daysRemaining: integer('days_remaining'),
    validTo: timestamp('valid_to', { withTimezone: true }),
    certSummary: text('cert_summary'),
    errorMessage: text('error_message'),
    startTime: timestamp('start_time', { withTimezone: true }).notNull().defaultNow(),
    endTime: timestamp('end_time', { withTimezone: true }),
  },
  (t) => [
    index('idx_tls_executions_monitor_id').on(t.tlsMonitorId),
    index('idx_tls_executions_start_time').on(t.startTime),
    index('idx_tls_executions_region_id').on(t.regionId),
  ],
);

// ============================================================
// Heartbeat monitors (Roadmap 8) — inverted-direction:
// the service pings us, we alert when it doesn't.
// ============================================================

export const heartbeatMonitors = pgTable(
  'heartbeat_monitors',
  {
    id: serial('id').primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    // 32 random bytes → 43 base64url chars; public path component on
    // POST /heartbeat/:token (no auth — services can't carry bearers).
    token: varchar('token', { length: 64 }).notNull().unique(),
    periodSeconds: integer('period_seconds').notNull(),
    graceSeconds: integer('grace_seconds').notNull().default(60),
    lastPingAt: timestamp('last_ping_at', { withTimezone: true }),
    // PENDING (just created, no ping yet) | UP (within grace) | OVERDUE.
    status: varchar('status', { length: 16 }).notNull().default('PENDING'),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_heartbeat_monitors_enabled_status').on(t.enabled, t.status),
    index('idx_heartbeat_monitors_token').on(t.token),
  ],
);

// ============================================================
// QA (Playwright) monitoring
// ============================================================

export const qaProjects = pgTable('qa_projects', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  notes: text('notes'),
  targetUrl: varchar('target_url', { length: 1024 }).notNull(),
  credentials: jsonb('credentials').$type<Record<string, string>>(),
  status: varchar('status', { length: 50 }).default('pending'),
  config: jsonb('config').$type<Record<string, unknown>>(),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  intervalSeconds: integer('interval_seconds').notNull().default(300),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const qaGeneratedTests = pgTable(
  'qa_generated_tests',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => qaProjects.id, { onDelete: 'cascade' }),
    testName: varchar('test_name', { length: 255 }),
    testType: varchar('test_type', { length: 50 }),
    script: text('script').notNull(),
    // When set, the script content lives in object storage at this key.
    // Reads prefer scriptUrl; the inline `script` column is the fallback
    // during the v1.0 backfill window. A future migration will drop the
    // inline column once all stacks have drained.
    scriptUrl: varchar('script_url', { length: 512 }),
    description: text('description'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_qa_generated_tests_project_id').on(t.projectId)],
);

// One QA project run (per project + region). region_id NULL = a master-run;
// non-null = a region-dispatched run. Groups the per-test executions so a run
// can be completion-detected by count, alerted exactly once (alerted_at), and
// compared against the previous run for the SAME region.
export const qaRuns = pgTable(
  'qa_runs',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => qaProjects.id, { onDelete: 'cascade' }),
    regionId: integer('region_id').references(() => regions.id, { onDelete: 'set null' }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    expectedTests: integer('expected_tests').notNull(),
    outcome: varchar('outcome', { length: 20 }),
    alertedAt: timestamp('alerted_at', { withTimezone: true }),
  },
  (t) => [index('idx_qa_runs_project_region_started').on(t.projectId, t.regionId, t.startedAt)],
);

export const qaTestExecutions = pgTable(
  'qa_test_executions',
  {
    id: serial('id').primaryKey(),
    testId: integer('test_id')
      .notNull()
      .references(() => qaGeneratedTests.id, { onDelete: 'cascade' }),
    projectId: integer('project_id')
      .notNull()
      .references(() => qaProjects.id, { onDelete: 'cascade' }),
    regionId: integer('region_id').references(() => regions.id, { onDelete: 'set null' }),
    runId: integer('run_id').references(() => qaRuns.id, { onDelete: 'cascade' }),
    status: varchar('status', { length: 20 }).notNull(),
    errorMessage: text('error_message'),
    logs: text('logs'),
    durationMs: integer('duration_ms'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    traceUrl: varchar('trace_url', { length: 512 }),
    screenshotUrls: jsonb('screenshot_urls').$type<string[]>(),
  },
  (t) => [
    index('idx_qa_test_executions_test_id').on(t.testId),
    index('idx_qa_test_executions_project_id').on(t.projectId),
    index('idx_qa_test_executions_region_id').on(t.regionId),
    index('idx_qa_test_executions_run_id').on(t.runId),
  ],
);

// ============================================================
// Auth — API keys
// ============================================================

export const apiKeys = pgTable('api_keys', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  keyPrefix: varchar('key_prefix', { length: 20 }).notNull(),
  keyHash: text('key_hash').notNull(),
  scopes: text('scopes').array().notNull().default(['write']),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ============================================================
// Users & sessions — email/password auth
// ============================================================

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  name: varchar('name', { length: 255 }).notNull().default(''),
  role: varchar('role', { length: 20 }).notNull().default('admin'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable('sessions', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ============================================================
// Multi-region — agents register as regions, monitors fan out
// ============================================================

export const regions = pgTable(
  'regions',
  {
    id: serial('id').primaryKey(),
    slug: varchar('slug', { length: 64 }).notNull().unique(),
    label: varchar('label', { length: 255 }).notNull(),
    apiKeyId: integer('api_key_id')
      .notNull()
      .references(() => apiKeys.id, { onDelete: 'restrict' }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    // Cached on every agent poll from the X-Agent-Version header.
    // Compared against the master's package.json on /api/regions GET.
    agentVersion: varchar('agent_version', { length: 32 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_regions_api_key_id').on(t.apiKeyId)],
);

// monitor_type is one of: 'url' | 'api' | 'tcp' | 'udp' | 'qa'.
// Not a real FK because per-type monitor tables are separate.
export const monitorRegions = pgTable(
  'monitor_regions',
  {
    monitorType: varchar('monitor_type', { length: 16 }).notNull(),
    monitorId: integer('monitor_id').notNull(),
    regionId: integer('region_id')
      .notNull()
      .references(() => regions.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.monitorType, t.monitorId, t.regionId] }),
    index('idx_monitor_regions_monitor').on(t.monitorType, t.monitorId),
    index('idx_monitor_regions_region').on(t.regionId),
  ],
);

// ============================================================
//   alert channels — Phase 5
// ============================================================

// Channel types: 'webhook' | 'discord' | 'slack'. Config is jsonb so
// each type can add per-shape fields (URL, custom headers, mention
// strings) without a migration.
export const alertChannels = pgTable(
  'alert_channels',
  {
    id: serial('id').primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    type: varchar('type', { length: 32 }).notNull(),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_alert_channels_enabled').on(t.enabled)],
);

// monitor_type is one of: 'url' | 'api' | 'tcp' | 'udp' | 'qa'. Same
// pattern as monitor_regions — no real FK because per-type monitor
// tables are separate; the application layer cleans up on monitor
// delete.
export const monitorAlertChannels = pgTable(
  'monitor_alert_channels',
  {
    monitorType: varchar('monitor_type', { length: 16 }).notNull(),
    monitorId: integer('monitor_id').notNull(),
    channelId: integer('channel_id')
      .notNull()
      .references(() => alertChannels.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.monitorType, t.monitorId, t.channelId] }),
    index('idx_monitor_alert_channels_monitor').on(t.monitorType, t.monitorId),
    index('idx_monitor_alert_channels_channel').on(t.channelId),
  ],
);

// ============================================================
//   status pages — Phase 5.5
// ============================================================

export const statusPages = pgTable('status_pages', {
  id: serial('id').primaryKey(),
  slug: varchar('slug', { length: 64 }).notNull().unique(),
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const statusPageMonitors = pgTable(
  'status_page_monitors',
  {
    statusPageId: integer('status_page_id')
      .notNull()
      .references(() => statusPages.id, { onDelete: 'cascade' }),
    monitorType: varchar('monitor_type', { length: 16 }).notNull(),
    monitorId: integer('monitor_id').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.statusPageId, t.monitorType, t.monitorId] }),
    index('idx_status_page_monitors_page').on(t.statusPageId),
    index('idx_status_page_monitors_monitor').on(t.monitorType, t.monitorId),
  ],
);

// Operator-authored incident timeline (migration 0017). `severity` is
// denormalised from the latest incident_update. `incident_updates.body`
// is RAW markdown — rendered to safe HTML at request time, never stored
// as HTML (see src/services/incident-render.ts).
export const incidents = pgTable(
  'incidents',
  {
    id: serial('id').primaryKey(),
    statusPageId: integer('status_page_id')
      .notNull()
      .references(() => statusPages.id, { onDelete: 'cascade' }),
    title: varchar('title', { length: 255 }).notNull(),
    severity: varchar('severity', { length: 16 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    index('idx_incidents_status_page_id').on(t.statusPageId),
    index('idx_incidents_resolved_at').on(t.resolvedAt),
  ],
);

export const incidentUpdates = pgTable(
  'incident_updates',
  {
    id: serial('id').primaryKey(),
    incidentId: integer('incident_id')
      .notNull()
      .references(() => incidents.id, { onDelete: 'cascade' }),
    severity: varchar('severity', { length: 16 }).notNull(),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_incident_updates_incident_id').on(t.incidentId)],
);
