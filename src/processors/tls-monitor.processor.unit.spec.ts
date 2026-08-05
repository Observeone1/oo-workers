/**
 * TLS monitor processor — thin wrapper around the shared runProbeProcessor
 * skeleton. tlsProbe is stubbed at the module boundary; the repo,
 * transition detector and exec-events are mocked the same way the other
 * processor specs do.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  execEventsMock,
  mockExecEvents,
  mockTransitionDetector,
  transitionDetectorMock,
} from '../test-support/shared-mocks.ts';

type Row = Record<string, unknown>;

const tlsMonitorRepoMock = {
  updateExecution: mock(async (_id: number, _v: Row): Promise<void> => {}),
};
mock.module('../db/repositories/tls-monitor.repo.ts', () => ({
  tlsMonitorRepo: tlsMonitorRepoMock,
}));

mockTransitionDetector();
mockExecEvents();

const { maybeAlertOnTransition } = transitionDetectorMock;
const { emitExecution } = execEventsMock;

const { tlsMonitorProcessor, tlsProcessorDeps } = await import('./tls-monitor.processor.ts');

// Deps-injection seam (not mock.module): tls-probe.ts has its own
// real-behavior unit spec (tls-probe.unit.spec.ts) that shares this bun
// test process, and mock.module would poison it process-wide.
const tlsProbeMock = mock(async (_opts: Row): Promise<Row> => ({ ok: true, latencyMs: 5 }));
tlsProcessorDeps.tlsProbe = tlsProbeMock as never;

function makeJob(monitorOver: Row = {}) {
  return {
    id: 'job-1',
    data: {
      executionId: 500,
      monitor: {
        id: 1,
        host: 'example.test',
        port: 443,
        timeoutMs: null,
        warnDays: null,
        servername: null,
        verifyChain: null,
        verifyHostname: null,
        expectCnRegex: null,
        ...monitorOver,
      },
    },
    attemptsMade: 0,
    opts: { attempts: 1 },
  } as never;
}

beforeEach(() => {
  tlsMonitorRepoMock.updateExecution.mockReset();
  tlsProbeMock.mockReset();
  maybeAlertOnTransition.mockReset();
  emitExecution.mockReset();
  tlsMonitorRepoMock.updateExecution.mockResolvedValue(undefined);
  maybeAlertOnTransition.mockResolvedValue(undefined);
  tlsProbeMock.mockResolvedValue({ ok: true, latencyMs: 5 });
});

describe('tlsMonitorProcessor — probe dispatch', () => {
  test('forwards host/port and defaults warnDays/verify flags to tlsProbe', async () => {
    tlsProbeMock.mockResolvedValue({
      ok: true,
      latencyMs: 14,
      daysRemaining: 42,
      validTo: new Date('2027-01-01'),
      certSummary: 'CN=example.test',
    });

    const out = await tlsMonitorProcessor(makeJob());

    expect(out).toEqual({ success: true });
    const [opts] = tlsProbeMock.mock.calls[0] as [Row];
    expect(opts).toMatchObject({
      host: 'example.test',
      port: 443,
      warnDays: 30,
      servername: null,
      verifyChain: false,
      verifyHostname: false,
      expectCnRegex: null,
    });
    const [id, patch] = tlsMonitorRepoMock.updateExecution.mock.calls[0] as [number, Row];
    expect(id).toBe(500);
    expect(patch).toMatchObject({
      status: 'SUCCESS',
      daysRemaining: 42,
      certSummary: 'CN=example.test',
    });
  });

  test('forwards explicit warnDays/servername/verify flags/expectCnRegex when set', async () => {
    await tlsMonitorProcessor(
      makeJob({
        warnDays: 7,
        servername: 'alt.example.test',
        verifyChain: true,
        verifyHostname: true,
        expectCnRegex: '^example',
      }),
    );

    const [opts] = tlsProbeMock.mock.calls[0] as [Row];
    expect(opts).toMatchObject({
      warnDays: 7,
      servername: 'alt.example.test',
      verifyChain: true,
      verifyHostname: true,
      expectCnRegex: '^example',
    });
  });

  test('a failed probe records FAILED with the null cert fields and errorMessage', async () => {
    tlsProbeMock.mockResolvedValue({ ok: false, latencyMs: 9, errorMessage: 'cert expired' });

    const err = await tlsMonitorProcessor(makeJob()).catch((e) => e);

    expect((err as Error).message).toBe('cert expired');
    const [, patch] = tlsMonitorRepoMock.updateExecution.mock.calls[0] as [number, Row];
    expect(patch).toMatchObject({
      status: 'FAILED',
      daysRemaining: null,
      validTo: null,
      certSummary: null,
      errorMessage: 'cert expired',
    });
    expect(emitExecution).toHaveBeenCalledWith(
      'tls',
      1,
      expect.objectContaining({ status: 'FAILED' }),
    );
    expect(maybeAlertOnTransition).toHaveBeenCalledWith(
      'tls',
      1,
      500,
      'FAILED',
      expect.objectContaining({ errorMessage: 'cert expired' }),
    );
  });
});
