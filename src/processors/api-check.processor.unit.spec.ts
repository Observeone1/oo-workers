/**
 * API Check processor — the BullMQ job handler that fires the outbound
 * HTTP request, evaluates assertions and persists the execution.
 *
 * fetch is stubbed at the global boundary (this processor makes a real
 * network call otherwise); the repo, transition detector and exec-events
 * module are mocked at their module edges via shared-mocks. Assertion
 * evaluation and error classification are kept real — both are pure and
 * specs assert against their actual output.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  apiCheckRepoMock,
  execEventsMock,
  mockApiCheckRepo,
  mockExecEvents,
  mockTransitionDetector,
  transitionDetectorMock,
} from '../test-support/shared-mocks.ts';

type Row = Record<string, unknown>;

mockApiCheckRepo();
mockTransitionDetector();
mockExecEvents();

const apiCheckRepo = apiCheckRepoMock;
const { maybeAlertOnTransition } = transitionDetectorMock;
const { emitExecution } = execEventsMock;

const { apiCheckProcessor } = await import('./api-check.processor.ts');

const realFetch = globalThis.fetch;

interface JobOpts {
  apiCheck?: Row;
  assertions?: Row[];
  attemptsMade?: number;
  attempts?: number;
}

function makeJob(opts: JobOpts = {}) {
  return {
    id: 'job-1',
    data: {
      executionId: 500,
      apiCheck: { id: 1, url: 'https://api.test/things', method: 'GET', ...opts.apiCheck },
      assertions: opts.assertions ?? [],
    },
    attemptsMade: opts.attemptsMade ?? 0,
    opts: { attempts: opts.attempts ?? 1 },
  } as never;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

/** Bun's fetch type carries a `preconnect` member a plain mock fn lacks. */
function setFetch(fn: (url: string, init?: RequestInit) => Promise<Response>): void {
  globalThis.fetch = mock(fn) as unknown as typeof fetch;
}

beforeEach(() => {
  apiCheckRepo.updateExecution.mockReset();
  maybeAlertOnTransition.mockReset();
  emitExecution.mockReset();
  apiCheckRepo.updateExecution.mockResolvedValue(undefined);
  maybeAlertOnTransition.mockResolvedValue(undefined);
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('apiCheckProcessor — success path', () => {
  test('records SUCCESS and alerts when every assertion passes', async () => {
    setFetch(async () => jsonResponse({ ok: true }));

    const out = await apiCheckProcessor(makeJob());

    expect(out).toEqual({ success: true });
    const [id, patch] = apiCheckRepo.updateExecution.mock.calls[0] as [number, Row];
    expect(id).toBe(500);
    expect(patch).toMatchObject({ status: 'SUCCESS', responseStatus: 200, errorMessage: null });
    expect(emitExecution).toHaveBeenCalledWith(
      'api',
      1,
      expect.objectContaining({ status: 'SUCCESS' }),
    );
    expect(maybeAlertOnTransition).toHaveBeenCalledWith(
      'api',
      1,
      500,
      'SUCCESS',
      expect.any(Object),
    );
  });

  test('a GET never attaches a body even when one is set on the check', async () => {
    let sentBody: unknown;
    setFetch(async (_url: string, init?: RequestInit) => {
      sentBody = init?.body;
      return jsonResponse({});
    });

    await apiCheckProcessor(makeJob({ apiCheck: { method: 'GET', body: { a: 1 } } }));

    expect(sentBody).toBeUndefined();
  });

  test.each(['POST', 'PUT', 'PATCH', 'QUERY'])(
    '%s attaches a JSON-serialized object body and defaults Content-Type',
    async (method) => {
      let sentInit: RequestInit | undefined;
      setFetch(async (_url: string, init?: RequestInit) => {
        sentInit = init;
        return jsonResponse({});
      });

      await apiCheckProcessor(makeJob({ apiCheck: { method, body: { q: 'term' } } }));

      expect(sentInit?.method).toBe(method);
      expect(sentInit?.body).toBe(JSON.stringify({ q: 'term' }));
      expect((sentInit?.headers as Record<string, string>)['Content-Type']).toBe(
        'application/json',
      );
    },
  );

  test('a string body is sent as-is, not re-serialized', async () => {
    let sentBody: unknown;
    setFetch(async (_url: string, init?: RequestInit) => {
      sentBody = init?.body;
      return jsonResponse({});
    });

    await apiCheckProcessor(makeJob({ apiCheck: { method: 'POST', body: 'raw text' } }));

    expect(sentBody).toBe('raw text');
  });

  test('an existing Content-Type header is not overwritten', async () => {
    let sentInit: RequestInit | undefined;
    setFetch(async (_url: string, init?: RequestInit) => {
      sentInit = init;
      return jsonResponse({});
    });

    await apiCheckProcessor(
      makeJob({
        apiCheck: { method: 'POST', body: { a: 1 }, headers: { 'Content-Type': 'text/plain' } },
      }),
    );

    expect((sentInit?.headers as Record<string, string>)['Content-Type']).toBe('text/plain');
  });
});

describe('apiCheckProcessor — assertion failures', () => {
  const failingAssertion = [{ type: 'statusCode', operator: 'equals', value: 200 }];

  test('a failing assertion on a non-final attempt records PENDING and rethrows', async () => {
    setFetch(async () => jsonResponse({}, { status: 500 }));

    const err = await apiCheckProcessor(
      makeJob({ assertions: failingAssertion, attemptsMade: 0, attempts: 3 }),
    ).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('One or more assertions failed');
    // Written twice: once by the try block (PENDING, full assertion detail),
    // once by the outer catch when the deliberate throw is caught there too.
    expect(apiCheckRepo.updateExecution).toHaveBeenCalledTimes(2);
    const [, firstPatch] = apiCheckRepo.updateExecution.mock.calls[0] as [number, Row];
    expect(firstPatch).toMatchObject({ status: 'PENDING' });
    const [, secondPatch] = apiCheckRepo.updateExecution.mock.calls[1] as [number, Row];
    expect(secondPatch).toMatchObject({
      status: 'PENDING',
      errorMessage: 'One or more assertions failed',
    });
    expect(maybeAlertOnTransition).not.toHaveBeenCalled();
  });

  test('a failing assertion on the final attempt records FAILED and alerts', async () => {
    setFetch(async () => jsonResponse({}, { status: 500 }));

    const err = await apiCheckProcessor(
      makeJob({ assertions: failingAssertion, attemptsMade: 0, attempts: 1 }),
    ).catch((e) => e);

    expect((err as Error).message).toBe('One or more assertions failed');
    expect(maybeAlertOnTransition).toHaveBeenCalledWith(
      'api',
      1,
      500,
      'FAILED',
      expect.objectContaining({ errorMessage: 'One or more assertions failed' }),
    );
  });
});

describe('apiCheckProcessor — transport failures', () => {
  test('a network error on a non-final attempt records PENDING, no alert, and rethrows', async () => {
    setFetch(async () => {
      throw new Error('boom');
    });

    const err = await apiCheckProcessor(makeJob({ attemptsMade: 0, attempts: 3 })).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('boom');
    const [, patch] = apiCheckRepo.updateExecution.mock.calls[0] as [number, Row];
    expect(patch).toMatchObject({ status: 'PENDING', errorMessage: 'boom' });
    expect(maybeAlertOnTransition).not.toHaveBeenCalled();
  });

  test('a network error on the final attempt records FAILED and alerts', async () => {
    setFetch(async () => {
      throw new Error('boom');
    });

    const err = await apiCheckProcessor(makeJob({ attemptsMade: 0, attempts: 1 })).catch((e) => e);

    expect((err as Error).message).toBe('boom');
    const [, patch] = apiCheckRepo.updateExecution.mock.calls[0] as [number, Row];
    expect(patch).toMatchObject({ status: 'FAILED', errorMessage: 'boom' });
    expect(emitExecution).toHaveBeenCalledWith(
      'api',
      1,
      expect.objectContaining({ status: 'FAILED', errorMessage: 'boom' }),
    );
    expect(maybeAlertOnTransition).toHaveBeenCalledWith('api', 1, 500, 'FAILED', {
      errorMessage: 'boom',
    });
  });
});
