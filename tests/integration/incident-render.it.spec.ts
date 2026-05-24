/**
 * Pure gating test for incident-render.ts — no DB, no network.
 * Ported from scripts/incident-render-test.ts.
 */

import { describe, test, expect } from 'bun:test';
import { renderIncidentMarkdown } from '../../src/services/incident-render.ts';

function onlyAllowedTags(html: string): boolean {
  const tags = html.match(/<[^>]*>/g) ?? [];
  return tags.every((t) => /^<\/?(p|br|strong|code)>$/.test(t));
}

describe('incident-render: XSS neutralisation', () => {
  test('bold-wrapped <script> is escaped, not live', () => {
    const s = renderIncidentMarkdown('**<script>alert(1)</script>**');
    expect(s).toContain('<strong>');
    expect(s).toContain('&lt;script&gt;');
    expect(s).not.toContain('<script');
    expect(onlyAllowedTags(s)).toBe(true);
  });

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
    '﹤script﹥',
  ];

  for (const attack of attacks) {
    test(`neutralised: ${attack.slice(0, 38)}`, () => {
      const out = renderIncidentMarkdown(attack);
      const bad =
        !onlyAllowedTags(out) ||
        /<(script|img|svg|iframe|a|body|link|style|object|embed)\b/i.test(out);
      expect(bad).toBe(false);
    });
  }
});

describe('incident-render: safe subset renders correctly', () => {
  test('**bold** → <strong>', () => {
    expect(renderIncidentMarkdown('**up**')).toContain('<strong>up</strong>');
  });

  test('`code` → <code>', () => {
    expect(renderIncidentMarkdown('see `db.host`')).toContain('<code>db.host</code>');
  });

  test('blank line = paragraph, newline = <br>', () => {
    const para = renderIncidentMarkdown('first line\nsame para\n\nsecond para');
    expect((para.match(/<p>/g) ?? []).length).toBe(2);
    expect(para).toContain('same para');
    expect(para).toContain('<br>');
  });

  test('empty input → empty string', () => {
    expect(renderIncidentMarkdown('')).toBe('');
  });
});
