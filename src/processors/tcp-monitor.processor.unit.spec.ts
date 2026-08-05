/**
 * TCP monitor processor — payload parsing plus the shared runProbeProcessor
 * success/fail skeleton. tcpProbe is stubbed at the module boundary;
 * parseHexPayload is kept real so the invalid-payload path exercises the
 * actual error message. The repo, transition detector and exec-events are
 * mocked the same way the other processor specs do.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  execEventsMock,
  mockExecEvents,
  mockTransitionDetector,
  transitionDetectorMock,
} from '../test-support/shared-mocks.ts';

type Row = Record<string, unknown>;

const tcpMonitorRepoMock = {
  updateExecution: mock(async (_id: number, _v: Row): Promise<void> => {}),
};
mock.module('../db/repositories/tcp-monitor.repo.ts', () => ({
  tcpMonitorRepo: tcpMonitorRepoMock,
}));

mockTransitionDetector();
mockExecEvents();

const { maybeAlertOnTransition } = transitionDetectorMock;
const { emitExecution } = execEventsMock;

const { tcpMonitorProcessor, tcpProcessorDeps } = await import('./tcp-monitor.processor.ts');

// Deps-injection seam (not mock.module): tcp-probe.ts has its own
// real-behavior unit spec (tcp-probe.unit.spec.ts) that shares this bun
// test process, and mock.module would poison it process-wide.
const tcpProbeMock = mock(async (_opts: Row): Promise<Row> => ({ ok: true, latencyMs: 5 }));
tcpProcessorDeps.tcpProbe = tcpProbeMock as never;

function makeJob(over: Row = {}, monitorOver: Row = {}) {
  return {
    id: 'job-1',
    data: {
      executionId: 500,
      monitor: {
        id: 1,
        host: 'example.test',
        port: 22,
        payloadHex: null,
        timeoutMs: null,
        expectBanner: null,
        ...monitorOver,
      },
    },
    attemptsMade: 0,
    opts: { attempts: 1 },
    ...over,
  } as never;
}

beforeEach(() => {
  tcpMonitorRepoMock.updateExecution.mockReset();
  tcpProbeMock.mockReset();
  maybeAlertOnTransition.mockReset();
  emitExecution.mockReset();
  tcpMonitorRepoMock.updateExecution.mockResolvedValue(undefined);
  maybeAlertOnTransition.mockResolvedValue(undefined);
  tcpProbeMock.mockResolvedValue({ ok: true, latencyMs: 5 });
});

describe('tcpMonitorProcessor — invalid payload_hex', () => {
  test('records FAILED, emits, alerts and rethrows without ever probing', async () => {
    const err = await tcpMonitorProcessor(makeJob({}, { payloadHex: 'zz' })).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(
      'payload_hex must be an even-length string of hex characters',
    );
    expect(tcpProbeMock).not.toHaveBeenCalled();
    const [id, patch] = tcpMonitorRepoMock.updateExecution.mock.calls[0] as [number, Row];
    expect(id).toBe(500);
    expect(patch).toMatchObject({
      status: 'FAILED',
      errorMessage: 'payload_hex must be an even-length string of hex characters',
    });
    expect(emitExecution).toHaveBeenCalledWith(
      'tcp',
      1,
      expect.objectContaining({ status: 'FAILED' }),
    );
    expect(maybeAlertOnTransition).toHaveBeenCalledWith(
      'tcp',
      1,
      500,
      'FAILED',
      expect.objectContaining({
        errorMessage: 'payload_hex must be an even-length string of hex characters',
      }),
    );
  });
});

describe('tcpMonitorProcessor — probe dispatch', () => {
  test('parses a valid hex payload and forwards banner/timeout/expectBanner to tcpProbe', async () => {
    tcpProbeMock.mockResolvedValue({ ok: true, latencyMs: 12, banner: 'SSH-2.0' });

    const out = await tcpMonitorProcessor(
      makeJob({}, { payloadHex: 'deadbeef', timeoutMs: 9000, expectBanner: 'SSH' }),
    );

    expect(out).toEqual({ success: true });
    const [opts] = tcpProbeMock.mock.calls[0] as [Row];
    expect(opts).toMatchObject({
      host: 'example.test',
      port: 22,
      timeoutMs: 9000,
      expectBanner: 'SSH',
    });
    expect(Buffer.isBuffer(opts.payload)).toBe(true);
    expect((opts.payload as Buffer).toString('hex')).toBe('deadbeef');
    const [, patch] = tcpMonitorRepoMock.updateExecution.mock.calls[0] as [number, Row];
    expect(patch).toMatchObject({ status: 'SUCCESS', banner: 'SSH-2.0' });
  });

  test('falls back to the default timeout and null banner/expectBanner when unset', async () => {
    tcpProbeMock.mockResolvedValue({ ok: true, latencyMs: 3 });

    await tcpMonitorProcessor(makeJob({}, { timeoutMs: null, expectBanner: null }));

    const [opts] = tcpProbeMock.mock.calls[0] as [Row];
    expect(opts.expectBanner).toBeNull();
    expect(typeof opts.timeoutMs).toBe('number');
    const [, patch] = tcpMonitorRepoMock.updateExecution.mock.calls[0] as [number, Row];
    expect(patch).toMatchObject({ status: 'SUCCESS', banner: null });
  });

  test('a failed probe records FAILED with the banner/errorMessage fields', async () => {
    tcpProbeMock.mockResolvedValue({ ok: false, latencyMs: 8, errorMessage: 'connect refused' });

    const err = await tcpMonitorProcessor(makeJob()).catch((e) => e);

    expect((err as Error).message).toBe('connect refused');
    const [, patch] = tcpMonitorRepoMock.updateExecution.mock.calls[0] as [number, Row];
    expect(patch).toMatchObject({
      status: 'FAILED',
      banner: null,
      errorMessage: 'connect refused',
    });
  });
});
