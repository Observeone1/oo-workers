/**
 * UDP monitor processor — payload parsing plus the shared runProbeProcessor
 * success/fail skeleton. udpProbe is stubbed at the module boundary;
 * parseHexPayload is kept real (same real function tcp's spec exercises)
 * so the invalid-payload path proves the actual error message.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  execEventsMock,
  mockExecEvents,
  mockTransitionDetector,
  transitionDetectorMock,
} from '../test-support/shared-mocks.ts';

type Row = Record<string, unknown>;

const udpMonitorRepoMock = {
  updateExecution: mock(async (_id: number, _v: Row): Promise<void> => {}),
};
mock.module('../db/repositories/udp-monitor.repo.ts', () => ({
  udpMonitorRepo: udpMonitorRepoMock,
}));

mockTransitionDetector();
mockExecEvents();

const { maybeAlertOnTransition } = transitionDetectorMock;
const { emitExecution } = execEventsMock;

const { udpMonitorProcessor, udpProcessorDeps } = await import('./udp-monitor.processor.ts');

// Deps-injection seam (not mock.module): udp-probe.ts has its own
// real-behavior unit spec (udp-probe.unit.spec.ts, including the real
// parseHexPayload the processor imports directly) that shares this bun
// test process, and mock.module would poison it process-wide.
const udpProbeMock = mock(async (_opts: Row): Promise<Row> => ({ ok: true, latencyMs: 5 }));
udpProcessorDeps.udpProbe = udpProbeMock as never;

function makeJob(monitorOver: Row = {}) {
  return {
    id: 'job-1',
    data: {
      executionId: 500,
      monitor: {
        id: 1,
        host: 'example.test',
        port: 53,
        payloadHex: null,
        timeoutMs: null,
        expectResponse: false,
        ...monitorOver,
      },
    },
    attemptsMade: 0,
    opts: { attempts: 1 },
  } as never;
}

beforeEach(() => {
  udpMonitorRepoMock.updateExecution.mockReset();
  udpProbeMock.mockReset();
  maybeAlertOnTransition.mockReset();
  emitExecution.mockReset();
  udpMonitorRepoMock.updateExecution.mockResolvedValue(undefined);
  maybeAlertOnTransition.mockResolvedValue(undefined);
  udpProbeMock.mockResolvedValue({ ok: true, latencyMs: 5 });
});

describe('udpMonitorProcessor — invalid payload_hex', () => {
  test('records FAILED, emits and rethrows without ever probing', async () => {
    const err = await udpMonitorProcessor(makeJob({ payloadHex: 'zz' })).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(
      'payload_hex must be an even-length string of hex characters',
    );
    expect(udpProbeMock).not.toHaveBeenCalled();
    const [id, patch] = udpMonitorRepoMock.updateExecution.mock.calls[0] as [number, Row];
    expect(id).toBe(500);
    expect(patch).toMatchObject({
      status: 'FAILED',
      errorMessage: 'payload_hex must be an even-length string of hex characters',
    });
    expect(emitExecution).toHaveBeenCalledWith(
      'udp',
      1,
      expect.objectContaining({ status: 'FAILED' }),
    );
    // Unlike tcp, the udp processor does not alert on this early parse failure.
    expect(maybeAlertOnTransition).not.toHaveBeenCalled();
  });
});

describe('udpMonitorProcessor — probe dispatch', () => {
  test('parses a valid hex payload and forwards it plus expectResponse/timeout to udpProbe', async () => {
    udpProbeMock.mockResolvedValue({ ok: true, latencyMs: 12, responseBytes: 4 });

    const out = await udpMonitorProcessor(
      makeJob({ payloadHex: 'cafe', timeoutMs: 4000, expectResponse: true }),
    );

    expect(out).toEqual({ success: true });
    const [opts] = udpProbeMock.mock.calls[0] as [Row];
    expect(opts).toMatchObject({
      host: 'example.test',
      port: 53,
      timeoutMs: 4000,
      expectResponse: true,
    });
    expect(Buffer.isBuffer(opts.payload)).toBe(true);
    expect((opts.payload as Buffer).toString('hex')).toBe('cafe');
    const [, patch] = udpMonitorRepoMock.updateExecution.mock.calls[0] as [number, Row];
    expect(patch).toMatchObject({ status: 'SUCCESS', responseBytes: 4 });
  });

  test('falls back to the default timeout and null responseBytes when unset', async () => {
    udpProbeMock.mockResolvedValue({ ok: true, latencyMs: 3 });

    await udpMonitorProcessor(makeJob({ timeoutMs: null }));

    const [opts] = udpProbeMock.mock.calls[0] as [Row];
    expect(typeof opts.timeoutMs).toBe('number');
    const [, patch] = udpMonitorRepoMock.updateExecution.mock.calls[0] as [number, Row];
    expect(patch).toMatchObject({ status: 'SUCCESS', responseBytes: null });
  });

  test('a failed probe records FAILED with the errorMessage field', async () => {
    udpProbeMock.mockResolvedValue({ ok: false, latencyMs: 8, errorMessage: 'no response' });

    const err = await udpMonitorProcessor(makeJob()).catch((e) => e);

    expect((err as Error).message).toBe('no response');
    const [, patch] = udpMonitorRepoMock.updateExecution.mock.calls[0] as [number, Row];
    expect(patch).toMatchObject({ status: 'FAILED', errorMessage: 'no response' });
  });
});
