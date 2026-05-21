/**
 * Shared dependencies passed to every `routes/*.ts` `register*()` function.
 *
 * server.ts builds these once per `buildApp(connection)` call (queues,
 * write-auth middleware, the dedicated blocking-pop Redis connection for
 * agent long-polls) and passes them down. Each routes file imports only
 * the deps it actually uses — TypeScript's structural typing keeps the
 * interface honest.
 */
import type { MiddlewareHandler } from 'hono';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

export interface RouteDeps {
  writeAuth: MiddlewareHandler;
  /** Per-type BullMQ queues used by the run-now + scheduler paths. */
  urlQ: Queue;
  apiQ: Queue;
  qaQ: Queue;
  tcpQ: Queue;
  udpQ: Queue;
  dbQ: Queue;
  tlsQ: Queue;
  /**
   * Dedicated connection for `BRPOPLPUSH` in `/api/agent/jobs`. Must NOT
   * be the same as the BullMQ Queue connection — a long-running BRPOP
   * would block other queue ops.
   */
  blockingConn: Redis;
}
