/**
 * Region admin contract — slug validation, the create/rotate/delete key
 * lifecycle, and the "cleartext key is returned once, stored only as an
 * argon2id hash" guarantee (verified with a real Bun.password.verify).
 * The database transaction and region repo are mocked at the db boundary;
 * every statement inside the transaction is captured for assertion.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';

interface Op {
  op: 'insert' | 'update' | 'delete';
  table: unknown;
  values?: Record<string, unknown>;
}

const ops: Op[] = [];
let nextId = 100;

// Chain links live at module level to keep function nesting flat (S2004).
function txInsert(table: unknown) {
  return {
    values: (values: Record<string, unknown>) => ({
      returning: async () => {
        const row = { id: nextId++, ...values };
        ops.push({ op: 'insert', table, values: row });
        return [row];
      },
    }),
  };
}

function txUpdate(table: unknown) {
  return {
    set: (values: Record<string, unknown>) => ({
      where: () => {
        ops.push({ op: 'update', table, values });
        const result = Promise.resolve([]);
        return Object.assign(result, {
          returning: async () => [{ id: 1, ...values }],
        });
      },
    }),
  };
}

function txDelete(table: unknown) {
  return {
    where: async () => {
      ops.push({ op: 'delete', table });
    },
  };
}

function makeTx() {
  return { insert: txInsert, update: txUpdate, delete: txDelete };
}

import {
  KEY_PREFIX_LEN,
  mockAuthMiddleware,
  mockRegionRepo,
  regionRepoMock,
} from '../test-support/shared-mocks.ts';

const { findBySlug, findById } = regionRepoMock;

mock.module('../config/db.ts', () => ({
  db: { transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(makeTx()) },
  sql: {},
}));
mockRegionRepo();
mockAuthMiddleware();

const { createRegionWithKey, deleteRegion, RegionAdminError, rotateRegionKey } =
  await import('./region-admin.ts');
const schema = await import('../db/schema.ts');

beforeEach(() => {
  ops.length = 0;
  findBySlug.mockReset();
  findById.mockReset();
  findBySlug.mockResolvedValue(null);
  findById.mockResolvedValue(null);
});

function opsFor(table: unknown): Op[] {
  return ops.filter((o) => o.table === table);
}

describe('createRegionWithKey', () => {
  test.each(['EU-Central', '-leading', 'a'.repeat(70), ''])(
    'rejects the invalid slug %j',
    async (slug) => {
      const err = await createRegionWithKey(slug, 'label').catch((e) => e);
      expect(err).toBeInstanceOf(RegionAdminError);
      expect(err.code).toBe('invalid_slug');
      expect(ops).toHaveLength(0);
    },
  );

  test('rejects a slug that already exists', async () => {
    findBySlug.mockResolvedValue({ id: 1, slug: 'eu-central' });

    const err = await createRegionWithKey('eu-central', 'EU').catch((e) => e);
    expect(err).toBeInstanceOf(RegionAdminError);
    expect(err.code).toBe('slug_taken');
  });

  test('creates the agent key and region, returning the cleartext exactly once', async () => {
    const { region, cleartextKey } = await createRegionWithKey('eu-central', 'EU Central');

    expect(cleartextKey).toStartWith('oo_');

    const [keyInsert] = opsFor(schema.apiKeys);
    expect(keyInsert.values).toMatchObject({
      name: 'agent:eu-central',
      scopes: ['agent'],
      keyPrefix: cleartextKey.slice(0, KEY_PREFIX_LEN),
    });
    // Only the argon2id hash is persisted, and it verifies the cleartext.
    const hash = keyInsert.values!.keyHash as string;
    expect(hash).not.toContain(cleartextKey);
    expect(await Bun.password.verify(cleartextKey, hash)).toBe(true);

    const [regionInsert] = opsFor(schema.regions);
    expect(regionInsert.values).toMatchObject({
      slug: 'eu-central',
      label: 'EU Central',
      apiKeyId: keyInsert.values!.id,
    });
    expect(region.slug).toBe('eu-central');
  });
});

describe('rotateRegionKey', () => {
  test('fails for an unknown region', async () => {
    const err = await rotateRegionKey(99).catch((e) => e);
    expect(err).toBeInstanceOf(RegionAdminError);
    expect(err.code).toBe('not_found');
  });

  test('issues a new key, points the region at it, and revokes the old key', async () => {
    findById.mockResolvedValue({ id: 3, slug: 'us-east', apiKeyId: 41 });

    const { cleartextKey } = await rotateRegionKey(3);

    const [keyInsert] = opsFor(schema.apiKeys).filter((o) => o.op === 'insert');
    expect(keyInsert.values).toMatchObject({ name: 'agent:us-east', scopes: ['agent'] });
    expect(await Bun.password.verify(cleartextKey, keyInsert.values!.keyHash as string)).toBe(true);

    const regionUpdate = opsFor(schema.regions).find((o) => o.op === 'update');
    expect(regionUpdate?.values).toEqual({ apiKeyId: keyInsert.values!.id });

    const revoke = opsFor(schema.apiKeys).find((o) => o.op === 'update');
    expect(revoke?.values).toHaveProperty('revokedAt');
  });
});

describe('deleteRegion', () => {
  test('fails for an unknown region', async () => {
    const err = await deleteRegion(99).catch((e) => e);
    expect(err).toBeInstanceOf(RegionAdminError);
    expect(err.code).toBe('not_found');
  });

  test('revokes the agent key before deleting the region row', async () => {
    findById.mockResolvedValue({ id: 3, slug: 'us-east', apiKeyId: 41 });

    await deleteRegion(3);

    expect(ops.map((o) => o.op)).toEqual(['update', 'delete']);
    expect(ops[0].table).toBe(schema.apiKeys);
    expect(ops[0].values).toHaveProperty('revokedAt');
    expect(ops[1].table).toBe(schema.regions);
  });
});
