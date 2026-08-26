#!/usr/bin/env bun
/**
 * Merge the unit + integration lcov reports bun test writes and emit one
 * reproducible JSON summary. Bun's --coverage-reporter only knows 'text'
 * and 'lcov' (no built-in json), so this parses lcov.info by hand — no new
 * dependency, matches the "dependency-light by design" house rule.
 *
 * Usage: bun scripts/coverage-report.ts [lcov paths...]
 * Defaults to coverage-unit/lcov.info and coverage-it/lcov.info (whichever
 * exist — run `bun run test:coverage` / `test:it:coverage` first).
 * Writes coverage/coverage-summary.json and prints the totals.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

interface FileCoverage {
  path: string;
  lines: Map<number, number>; // line number -> max hit count seen across reports
}

function parseLcov(content: string): Map<string, Map<number, number>> {
  const files = new Map<string, Map<number, number>>();
  let current: Map<number, number> | null = null;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('SF:')) {
      const path = line.slice(3);
      current = files.get(path) ?? new Map<number, number>();
      files.set(path, current);
    } else if (line.startsWith('DA:') && current) {
      const [lineNoStr, hitsStr] = line.slice(3).split(',');
      const lineNo = Number(lineNoStr);
      const hits = Number(hitsStr);
      // Union across reports: a line counts as covered if any suite hit it.
      current.set(lineNo, Math.max(current.get(lineNo) ?? 0, hits));
    } else if (line === 'end_of_record') {
      current = null;
    }
  }
  return files;
}

async function main() {
  const args = process.argv.slice(2);
  const defaultPaths = ['coverage-unit/lcov.info', 'coverage-it/lcov.info'];
  const candidatePaths = args.length > 0 ? args : defaultPaths;
  const paths = candidatePaths.filter((p) => existsSync(p));

  if (paths.length === 0) {
    console.error(
      `No lcov reports found. Looked for: ${candidatePaths.join(', ')}\n` +
        'Run `bun run test:coverage` and/or `bun run test:it:coverage` first.',
    );
    process.exit(1);
  }

  const merged = new Map<string, Map<number, number>>();
  for (const p of paths) {
    const content = await readFile(p, 'utf8');
    const parsed = parseLcov(content);
    for (const [file, lines] of parsed) {
      const existing = merged.get(file) ?? new Map<number, number>();
      for (const [lineNo, hits] of lines) {
        existing.set(lineNo, Math.max(existing.get(lineNo) ?? 0, hits));
      }
      merged.set(file, existing);
    }
  }

  const files: FileCoverage[] = [...merged.entries()]
    .map(([path, lines]) => ({ path, lines }))
    .sort((a, b) => a.path.localeCompare(b.path));

  let totalLines = 0;
  let coveredLines = 0;
  const perFile = files.map(({ path, lines }) => {
    const found = lines.size;
    const hit = [...lines.values()].filter((h) => h > 0).length;
    totalLines += found;
    coveredLines += hit;
    return {
      path,
      linesFound: found,
      linesHit: hit,
      pct: found === 0 ? 100 : Number(((hit / found) * 100).toFixed(2)),
    };
  });

  const summary = {
    generatedAt: new Date().toISOString(),
    sources: paths,
    totals: {
      linesFound: totalLines,
      linesHit: coveredLines,
      pct: totalLines === 0 ? 0 : Number(((coveredLines / totalLines) * 100).toFixed(2)),
    },
    files: perFile,
  };

  await mkdir('coverage', { recursive: true });
  const outPath = 'coverage/coverage-summary.json';
  await writeFile(outPath, JSON.stringify(summary, null, 2));

  console.log(`Merged ${paths.length} lcov report(s): ${paths.join(', ')}`);
  console.log(
    `Total: ${summary.totals.linesHit}/${summary.totals.linesFound} lines (${summary.totals.pct}%)`,
  );
  console.log(`Wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
