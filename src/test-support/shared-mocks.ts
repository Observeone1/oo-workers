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
