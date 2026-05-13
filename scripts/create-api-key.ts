#!/usr/bin/env bun
/**
 * Generate a fresh API key for the oo-workers HTTP auth layer.
 *
 * Cleartext format: `oo_<43 base64url chars>` (32 random bytes).
 * The prefix (`oo_` + first 8 chars) is stored alongside the argon2id
 * hash of the full string. The cleartext is printed once and never
 * stored — copy it now or generate a new one.
 *
 * Usage:
 *   bun scripts/create-api-key.ts --name "samir-laptop"
 *   bun scripts/create-api-key.ts --name "ci" --scope write
 *   bun scripts/create-api-key.ts --name "ci" --quiet     # prints only the key
 *
 * Run inside the worker container during normal operation:
 *   docker compose exec worker bun scripts/create-api-key.ts --name first
 */

import { randomBytes } from 'node:crypto';
import { apiKeyRepo } from '../src/db/repositories/api-key.repo.ts';
import { sql } from '../src/config/db.ts';
import { KEY_PREFIX_LEN } from '../src/middleware/auth.ts';

interface Args {
  name: string;
  scope: 'read' | 'write';
  quiet: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let name = '';
  let scope: 'read' | 'write' = 'write';
  let quiet = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--name') name = argv[++i] ?? '';
    else if (arg === '--scope') {
      const v = argv[++i];
      if (v !== 'read' && v !== 'write') {
        console.error(`--scope must be 'read' or 'write', got '${v}'`);
        process.exit(2);
      }
      scope = v;
    } else if (arg === '--quiet') quiet = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: bun scripts/create-api-key.ts --name <name> [--scope write] [--quiet]');
      process.exit(0);
    }
  }
  if (!name) {
    console.error('--name is required');
    process.exit(2);
  }
  return { name, scope, quiet };
}

async function main() {
  const { name, scope, quiet } = parseArgs();

  // 32 bytes → 43 base64url chars (no padding).
  const raw = randomBytes(32).toString('base64url');
  const cleartext = `oo_${raw}`;
  const keyPrefix = cleartext.slice(0, KEY_PREFIX_LEN);
  const keyHash = await Bun.password.hash(cleartext, { algorithm: 'argon2id' });

  const [row] = await apiKeyRepo.create({ name, keyPrefix, keyHash, scopes: [scope] });

  if (quiet) {
    process.stdout.write(cleartext);
  } else {
    console.log(`✅ created API key #${row.id} "${name}" (scope: ${scope})`);
    console.log(`   prefix: ${keyPrefix}`);
    console.log('');
    console.log('   key (copy now — it will not be shown again):');
    console.log(`   ${cleartext}`);
  }
  await sql.end();
}

main().catch((err) => {
  console.error('create-api-key failed:', err);
  process.exit(1);
});
