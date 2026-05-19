#!/usr/bin/env bun
/**
 * Gating security test for incident-render.ts — the only path that emits
 * operator text as HTML onto the public, unauthenticated status page.
 * Pure (no DB/HTTP/egress); fast; in run-integration.sh + pre-push + CI.
 *
 * Anti-vacuous in BOTH directions:
 *  - escaper regression → an attack payload produces a live tag → the
 *    "only <p|br|strong|code> ever emitted" invariant + per-payload
 *    checks FAIL.
 *  - rewriter regression → **bold** / `code` / paragraphs stop working
 *    → the functional checks FAIL.
 * A no-op passthrough fails both halves; a "strip everything" renderer
 * fails the functional half. The test cannot pass vacuously.
 */

import { renderIncidentMarkdown } from '../src/services/incident-render.ts';

let failed = false;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed = true;
}

// The structural invariant: the renderer must ONLY ever emit tags from
// the allow-list. Any other tag in the output = an escape hole.
function onlyAllowedTags(html: string): boolean {
  const tags = html.match(/<[^>]*>/g) ?? [];
  return tags.every((t) => /^<\/?(p|br|strong|code)>$/.test(t));
}

// 1. The discriminating case the whole feature hinges on.
const s = renderIncidentMarkdown('**<script>alert(1)</script>**');
check(
  'bold-wrapped <script> is escaped, not live',
  s.includes('<strong>') &&
    s.includes('&lt;script&gt;') &&
    !s.includes('<script') &&
    onlyAllowedTags(s),
  s,
);

// 2. OWASP-class evasion corpus — none may yield a live/dangerous tag,
//    and only allow-listed tags may appear.
const attacks = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<svg/onload=alert(1)>',
  '<a href="javascript:alert(1)">x</a>',
  '"><script>alert(1)</script>',
  '`</code><script>alert(1)</script>`',
  '&#60;script&#62;alert(1)&#60;/script&#62;',
  '<iframe src=javascript:alert(1)>',
  '<body onload=alert(1)>',
  '<<script>script>alert(1)<</script>/script>',
  '﹤script﹥', // small less/greater-than — must stay literal
];
for (const a of attacks) {
  const out = renderIncidentMarkdown(a);
  // Safe iff (a) every emitted tag is allow-listed AND (b) no *live*
  // dangerous element opener exists (a real `<` char — escaped payloads
  // are `&lt;…` so the literal "onerror="/"javascript:" inside them is
  // inert text, not an attribute, and must NOT be flagged).
  const bad =
    !onlyAllowedTags(out) || /<(script|img|svg|iframe|a|body|link|style|object|embed)\b/i.test(out);
  check(`neutralised: ${a.slice(0, 38)}`, !bad, out.slice(0, 90));
}

// 3. Anti-vacuous functional half — the safe subset must actually work.
check(
  '**bold** → <strong>',
  renderIncidentMarkdown('**up**').includes('<strong>up</strong>'),
  renderIncidentMarkdown('**up**'),
);
check(
  '`code` → <code>',
  renderIncidentMarkdown('see `db.host`').includes('<code>db.host</code>'),
  renderIncidentMarkdown('see `db.host`'),
);
{
  const para = renderIncidentMarkdown('first line\nsame para\n\nsecond para');
  check(
    'blank line = paragraph, newline = <br>',
    (para.match(/<p>/g) ?? []).length === 2 && para.includes('same para') && para.includes('<br>'),
    para,
  );
}
check('empty input → empty string', renderIncidentMarkdown('') === '', JSON.stringify(''));

console.log(
  failed ? '\nincident-render-test: FAILED' : '\nincident-render-test: all checks passed',
);
process.exit(failed ? 1 : 0);
