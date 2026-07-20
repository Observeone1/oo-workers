/**
 * Cross-spec module mocks. bun test runs every spec file in ONE process
 * with a shared mock.module registry, so two specs mocking the same module
 * with different export shapes poison each other (the later import binds
 * against the earlier registration and blows up on a missing named
 * export). Every spec that needs one of these modules mocked registers it
 * through the helpers here, so the shape AND the mock instances are
 * identical no matter which spec file loads first.
 *
 * Because the instances are shared process-wide, specs must prime the
 * behaviour they rely on in their own beforeEach (never trust defaults
 * left behind by another file).
 */

import { mock } from 'bun:test';
// Imported for its real pure helpers, which mockObjectStorage keeps intact.
// This runs during the import phase, before any spec body registers a mock,
// so it always binds the genuine module.
import * as realObjectStorage from '../services/object-storage.ts';
// Safe to import for real: it pulls only node builtins. transition-detector
// is deliberately NOT imported here, because it reaches config/db.ts, which
// throws at import time when DATABASE_URL is unset.
import * as realPlaywrightService from '../services/playwright.service.ts';

type AnyRow = Record<string, unknown>;

/** Mirrors src/middleware/auth.ts ("oo_" + first 8 random chars). */
export const KEY_PREFIX_LEN = 11;

// ---- src/middleware/auth.ts ----
export const authMiddlewareMock = {
  /** What extractKey returns for the current request. */
  keyCtl: { value: null as string | null },
  requireAuth: mock((_scope: string) => async (_c: unknown, next: () => Promise<void>) => next()),
  validateKey: mock(async (_k: string): Promise<unknown> => null),
};

export function mockAuthMiddleware(): void {
  mock.module('../middleware/auth.ts', () => ({
    KEY_PREFIX_LEN,
    requireAuth: authMiddlewareMock.requireAuth,
    validateKey: authMiddlewareMock.validateKey,
    extractKey: () => authMiddlewareMock.keyCtl.value,
  }));
}

// ---- src/services/auth.service.ts ----
export const authServiceMock = {
  needsSetup: mock(async (): Promise<boolean> => false),
  register: mock(async (_e: string, _p: string, _n: string): Promise<unknown> => ({})),
  createSession: mock(async (_u: unknown): Promise<string> => 'tok'),
  login: mock(async (_e: string, _p: string): Promise<unknown> => null),
  logoutSession: mock(async (_t: string): Promise<void> => {}),
  validateSession: mock(async (_t: string): Promise<unknown> => null),
  updateProfile: mock(async (_id: number, _p: unknown): Promise<unknown> => ({})),
  changePassword: mock(async (): Promise<{ ok: boolean; error?: string }> => ({ ok: true })),
};

export function mockAuthService(): void {
  mock.module('../services/auth.service.ts', () => ({
    SESSION_COOKIE: 'oo_session',
    authService: authServiceMock,
  }));
}

// ---- src/db/repositories/region.repo.ts ----
export const regionRepoMock = {
  list: mock(async (): Promise<AnyRow[]> => []),
  findBySlug: mock(async (_slug: string): Promise<unknown> => null),
  findById: mock(async (_id: number): Promise<unknown> => null),
};
export const monitorRegionRepoMock = {
  set: mock(async (_t: string, _id: number, _r: number[]): Promise<void> => {}),
};

export function mockRegionRepo(): void {
  mock.module('../db/repositories/region.repo.ts', () => ({
    regionRepo: regionRepoMock,
    monitorRegionRepo: monitorRegionRepoMock,
  }));
}

// ---- src/db/repositories/status-page.repo.ts ----
export const statusPageRepoMock = {
  list: mock(async (): Promise<AnyRow[]> => []),
  create: mock(async (_v: AnyRow): Promise<AnyRow[]> => []),
  findBySlug: mock(async (_s: string): Promise<unknown> => null),
  findById: mock(async (_id: number): Promise<unknown> => null),
  update: mock(async (_id: number, _p: AnyRow): Promise<void> => {}),
  deleteById: mock(async (_id: number): Promise<void> => {}),
};
export const statusPageMonitorRepoMock = {
  forPage: mock(async (_id: number): Promise<AnyRow[]> => []),
  set: mock(async (_id: number, _b: unknown[]): Promise<void> => {}),
  clearForMonitor: mock(async (_t: string, _id: number): Promise<void> => {}),
};

export function mockStatusPageRepo(): void {
  mock.module('../db/repositories/status-page.repo.ts', () => ({
    statusPageRepo: statusPageRepoMock,
    statusPageMonitorRepo: statusPageMonitorRepoMock,
  }));
}

// ---- src/db/repositories/alert-channel.repo.ts ----
export const alertChannelRepoMock = {
  list: mock(async (): Promise<AnyRow[]> => []),
  create: mock(async (_v: AnyRow): Promise<AnyRow[]> => []),
  findById: mock(async (_id: number): Promise<unknown> => null),
  deleteById: mock(async (_id: number): Promise<void> => {}),
};
export const monitorAlertChannelRepoMock = {
  set: mock(async (_t: string, _id: number, _c: number[]): Promise<void> => {}),
  clearForMonitor: mock(async (_t: string, _id: number): Promise<void> => {}),
};

export function mockAlertChannelRepo(): void {
  mock.module('../db/repositories/alert-channel.repo.ts', () => ({
    alertChannelRepo: alertChannelRepoMock,
    monitorAlertChannelRepo: monitorAlertChannelRepoMock,
  }));
}

// ---- src/config/db.ts ----
/**
 * The drizzle handle has no single shape that suits every caller (one spec
 * wants a select chain, another a transaction, another a per-table row
 * map), so this registration delegates to whatever the running spec put in
 * `dbMock` — set it in your beforeEach. Delegating rather than
 * re-registering keeps the module identity stable across load orders.
 */
export const dbMock = {
  db: {} as Record<string, unknown>,
  sql: ((..._args: unknown[]) => Promise.resolve([])) as (...args: unknown[]) => unknown,
};

export function mockDb(): void {
  mock.module('../config/db.ts', () => ({
    db: new Proxy(
      {},
      {
        get: (_t, prop) => dbMock.db[prop as string],
        has: (_t, prop) => (prop as string) in dbMock.db,
      },
    ),
    sql: (...args: unknown[]) => dbMock.sql(...args),
  }));
}

// ---- src/services/object-storage.ts ----
/**
 * Only the I/O calls are stubbed. The pure key helpers (qaScriptKey,
 * qaRunArtifactKey, isLegacyQaScriptKey) stay real so specs assert the
 * keys actually written rather than a reimplementation of them.
 */
export const objectStorageMock = {
  /** isStorageConfigured()'s answer. */
  configured: { value: true },
  putObject: mock(async (_k: string, _b: unknown, _ct?: string): Promise<void> => {}),
  getObjectResponse: mock(async (_k: string): Promise<Response> => new Response('')),
  listObjects: mock(async (_p: string): Promise<string[]> => []),
  listObjectsWithSize: mock(async (_p: string): Promise<{ key: string; size: number }[]> => []),
  moveObject: mock(async (_from: string, _to: string): Promise<void> => {}),
  deleteObject: mock(async (_k: string): Promise<void> => {}),
};

export function mockObjectStorage(): void {
  mock.module('../services/object-storage.ts', () => ({
    ...realObjectStorage,
    isStorageConfigured: () => objectStorageMock.configured.value,
    putObject: objectStorageMock.putObject,
    getObjectResponse: objectStorageMock.getObjectResponse,
    listObjects: objectStorageMock.listObjects,
    listObjectsWithSize: objectStorageMock.listObjectsWithSize,
    moveObject: objectStorageMock.moveObject,
    deleteObject: objectStorageMock.deleteObject,
  }));
}

/** Reset every object-storage stub to an inert default. */
export function resetObjectStorageMock(): void {
  objectStorageMock.configured.value = true;
  objectStorageMock.putObject.mockReset();
  objectStorageMock.getObjectResponse.mockReset();
  objectStorageMock.listObjects.mockReset();
  objectStorageMock.listObjectsWithSize.mockReset();
  objectStorageMock.moveObject.mockReset();
  objectStorageMock.deleteObject.mockReset();
  objectStorageMock.putObject.mockResolvedValue(undefined);
  objectStorageMock.getObjectResponse.mockResolvedValue(new Response(''));
  objectStorageMock.listObjects.mockResolvedValue([]);
  objectStorageMock.listObjectsWithSize.mockResolvedValue([]);
  objectStorageMock.moveObject.mockResolvedValue(undefined);
  objectStorageMock.deleteObject.mockResolvedValue(undefined);
}

// ---- src/services/playwright.service.ts ----
/**
 * Only executePlaywrightTest is stubbed. The rest of the module is spread
 * through untouched, because other specs exercise buildCredentialEnv and
 * extractStderrSummary for real and a narrow registration would strip them.
 */
export const playwrightServiceMock = {
  executePlaywrightTest: mock(
    async (
      _file: string,
      _url: string,
      _creds: unknown,
      _opts: unknown,
    ): Promise<Record<string, unknown>> => ({
      success: true,
      error: null,
      logs: [],
      artifacts: [],
      duration_ms: 0,
    }),
  ),
};

export function mockPlaywrightService(): void {
  mock.module('../services/playwright.service.ts', () => ({
    ...realPlaywrightService,
    executePlaywrightTest: playwrightServiceMock.executePlaywrightTest,
  }));
}

// ---- src/services/transition-detector.ts ----
/**
 * Fully stubbed rather than spread: importing the real module would drag in
 * config/db.ts, which throws without DATABASE_URL. Both exports are declared
 * so the shape stays complete for any importer. No unit spec exercises the
 * real transition logic (the integration suite owns it).
 */
export const transitionDetectorMock = {
  maybeAlertOnTransition: mock(async (..._args: unknown[]): Promise<void> => {}),
  maybeAlertOnQaRunTransition: mock(async (_runId: number): Promise<void> => {}),
};

export function mockTransitionDetector(): void {
  mock.module('../services/transition-detector.ts', () => ({
    maybeAlertOnTransition: transitionDetectorMock.maybeAlertOnTransition,
    maybeAlertOnQaRunTransition: transitionDetectorMock.maybeAlertOnQaRunTransition,
  }));
}

// ---- src/db/repositories/qa-project.repo.ts ----
/** Union of what the monitors routes and the qa processor both need. */
export const qaProjectRepoMock = {
  findAllWithLatest: mock(async (): Promise<AnyRow[]> => []),
  findById: mock(async (_id: number): Promise<AnyRow[]> => []),
  findExecutionsByMonitorId: mock(async (_id: number): Promise<AnyRow[]> => []),
  create: mock(async (v: AnyRow): Promise<AnyRow[]> => [{ id: 9, ...v }]),
  createExecution: mock(
    async (
      _a: number,
      _b?: number,
      _c?: string,
      _d?: number | null,
      _e?: number,
    ): Promise<AnyRow[]> => [{ id: 77 }],
  ),
  deleteById: mock(async (_id: number): Promise<void> => {}),
  update: mock(async (_id: number, _v: AnyRow): Promise<AnyRow[]> => []),
  updateEnabled: mock(async (_id: number, _e: boolean): Promise<void> => {}),
  findTestsByProjectId: mock(async (_id: number, _o?: AnyRow): Promise<AnyRow[]> => []),
  findExecutionsByProjectId: mock(async (_id: number): Promise<AnyRow[]> => []),
  createTests: mock(async (_id: number, _t: AnyRow[]): Promise<void> => {}),
  updateFirstTestScript: mock(async (_id: number, _s: string): Promise<void> => {}),
  createRun: mock(async (_v: AnyRow): Promise<AnyRow[]> => [{ id: 900 }]),
  updateExecution: mock(async (_id: number, _v: AnyRow): Promise<void> => {}),
  touchLastRunAt: mock(async (_id: number): Promise<void> => {}),
  claimRunAlert: mock(async (_runId: number, _outcome: string): Promise<boolean> => true),
};

export function mockQaProjectRepo(): void {
  mock.module('../db/repositories/qa-project.repo.ts', () => ({
    qaProjectRepo: qaProjectRepoMock,
  }));
}

// ---- src/services/exec-events.ts ----
export const execEventsMock = {
  emitExecution: mock((_t: string, _id: number, _row: AnyRow): void => {}),
  emitMonitorCreated: mock((_t: string, _id: number): void => {}),
  emitMonitorDeleted: mock((_t: string, _id: number): void => {}),
};

export function mockExecEvents(): void {
  mock.module('../services/exec-events.ts', () => ({
    emitExecution: execEventsMock.emitExecution,
    emitMonitorCreated: execEventsMock.emitMonitorCreated,
    emitMonitorDeleted: execEventsMock.emitMonitorDeleted,
  }));
}
