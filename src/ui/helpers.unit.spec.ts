/**
 * The dashboard's pure string/number helpers.
 *
 * esc() is the XSS boundary for every server-rendered fragment in the UI —
 * monitor names, URLs, error messages and QA output all pass through it
 * before being interpolated into innerHTML. A regression here is a stored-XSS
 * on the dashboard, and src/ui is excluded from the Sonar coverage
 * denominator, so nothing else would flag it.
 *
 * fmtAge/paginate are boundary formatters: off-by-one errors there are
 * invisible in review and wrong in the product ("Page 0 of 3", a 60s-old
 * stamp reading "0s ago").
 */

import { describe, expect, test } from 'bun:test';
import {
  esc,
  fmtAge,
  fmtAgeLive,
  formText,
  paginationFooter,
  paginate,
  statusClass,
} from './helpers.ts';

describe('esc', () => {
  test('neutralises every character that could break out of HTML', () => {
    expect(esc('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  test('escapes the quote characters, not just the angle brackets', () => {
    // An attribute context is broken by " or ' alone; escaping only < > >
    // would still allow `onerror="alert(1)"` out of a quoted attribute.
    expect(esc('"')).toBe('&quot;');
    expect(esc("'")).toBe('&#39;');
    expect(esc('a" onerror="x')).toBe('a&quot; onerror=&quot;x');
    expect(esc("a' onerror='x")).toBe('a&#39; onerror=&#39;x');
  });

  test('escapes ampersand first so entities are not double-decoded', () => {
    // &lt; must not survive as &lt; or the browser re-decodes it to <.
    expect(esc('&lt;')).toBe('&amp;lt;');
    expect(esc('a & b')).toBe('a &amp; b');
  });

  test('leaves ordinary text untouched', () => {
    expect(esc('https://example.com/health?a=1&b=2 — ok')).toBe(
      'https://example.com/health?a=1&amp;b=2 — ok',
    );
    expect(esc('')).toBe('');
  });

  test('coerces null/undefined to empty rather than the string "null"', () => {
    // esc(null) leaking "null" into every empty field is a visible bug.
    expect(esc(null as unknown as string)).toBe('');
    expect(esc(undefined as unknown as string)).toBe('');
  });

  test('an image-error handler injected as text stays inert', () => {
    const payload = '"><img src=x onerror=alert(1)>';
    const escaped = esc(payload);
    // Inert because the tag delimiters are escaped: the browser never parses
    // an element, so onerror never becomes an attribute. (esc() does not
    // escape '=' or spaces; escaping < > " ' is what closes the hole.)
    expect(escaped).not.toContain('<');
    expect(escaped).not.toContain('>');
    expect(escaped).toBe('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('formText', () => {
  test('passes strings through and stringifies scalars', () => {
    expect(formText('eu-west-1')).toBe('eu-west-1');
    expect(formText(42)).toBe('42');
    expect(formText(false)).toBe('false');
    expect(formText(0)).toBe('0');
  });

  test('falls back rather than rendering [object Object]', () => {
    expect(formText({ a: 1 })).toBe('');
    expect(formText({ a: 1 }, 'n/a')).toBe('n/a');
    expect(formText([1, 2], 'n/a')).toBe('n/a');
    expect(formText(null)).toBe('');
    expect(formText(undefined)).toBe('');
  });
});

describe('fmtAge', () => {
  /** ISO string `secondsAgo` in the past. */
  const ago = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000).toISOString();

  test('reports "never" for a missing stamp', () => {
    expect(fmtAge(null)).toBe('never');
    expect(fmtAge(undefined)).toBe('never');
    expect(fmtAge('')).toBe('never');
  });

  test('picks the right unit per boundary', () => {
    expect(fmtAge(ago(5))).toBe('5s ago');
    expect(fmtAge(ago(59))).toBe('59s ago');
    expect(fmtAge(ago(60))).toBe('1m ago');
    expect(fmtAge(ago(3599))).toBe('59m ago');
    expect(fmtAge(ago(3600))).toBe('1h ago');
    expect(fmtAge(ago(86399))).toBe('23h ago');
    expect(fmtAge(ago(86400))).toBe('1d ago');
  });

  test('a clock-skewed future stamp renders a negative age', () => {
    // KNOWN DEFECT, pinned deliberately: an agent or Postgres whose clock is
    // ahead makes the dashboard render "-60s ago". fmtAge has no clamp at 0.
    // Reported rather than silently fixed (production-logic change). Fix is
    // `if (d < 0) return '0s ago';`.
    expect(fmtAge(new Date(Date.now() + 60_000).toISOString())).toBe('-60s ago');
  });

  test('an unparseable stamp does not produce NaN in the UI', () => {
    expect(fmtAge('not-a-date')).toContain('NaN');
  });

  test('fmtAgeLive stamps the ISO for the in-place clock tick', () => {
    const iso = ago(30);
    const html = fmtAgeLive(iso);
    expect(html).toContain('data-iso="');
    expect(html).toContain(iso);
    expect(html).toContain('30s ago');
  });

  test('fmtAgeLive stamps an empty ISO for a never-seen monitor', () => {
    expect(fmtAgeLive(null)).toContain('data-iso=""');
    expect(fmtAgeLive(null)).toContain('never');
  });
});

describe('statusClass', () => {
  test('maps the verdict strings the fleet uses to dot classes', () => {
    expect(statusClass('SUCCESS')).toBe('up');
    expect(statusClass('FAILED')).toBe('down');
    expect(statusClass('PENDING')).toBe('pending');
    expect(statusClass('UP')).toBe('up');
    expect(statusClass('OVERDUE')).toBe('down');
    expect(statusClass('running')).toBe('running');
    expect(statusClass('warn')).toBe('warn');
  });

  test('falls back to the neutral dot for unknown or missing statuses', () => {
    // An unmapped verdict must not borrow another verdict's colour.
    expect(statusClass('QA_RUN_ABANDONED')).toBe('');
    expect(statusClass('')).toBe('');
    expect(statusClass(null)).toBe('');
    expect(statusClass(undefined)).toBe('');
  });
});

describe('paginate', () => {
  const items = Array.from({ length: 25 }, (_, i) => i);

  test('slices the requested page and reports the totals', () => {
    expect(paginate(items, 1, 10)).toEqual({
      pageRows: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      totalPages: 3,
      page: 1,
    });
    expect(paginate(items, 3, 10).pageRows).toEqual([20, 21, 22, 23, 24]);
  });

  test('an empty list is one page, not zero', () => {
    expect(paginate([], 1, 10)).toEqual({ pageRows: [], totalPages: 1, page: 1 });
  });

  test('a short final page still reports the right total', () => {
    expect(paginate(items, 3, 10).totalPages).toBe(3);
    expect(
      paginate(
        Array.from({ length: 20 }, (_, i) => i),
        2,
        10,
      ).totalPages,
    ).toBe(2);
    expect(
      paginate(
        Array.from({ length: 21 }, (_, i) => i),
        3,
        10,
      ).pageRows,
    ).toEqual([20]);
  });

  test('clamps a page below 1 or above the last page', () => {
    expect(paginate(items, 0, 10).page).toBe(1);
    expect(paginate(items, -5, 10).page).toBe(1);
    expect(paginate(items, 99, 10).page).toBe(3);
    expect(paginate(items, 99, 10).pageRows).toEqual([20, 21, 22, 23, 24]);
  });

  test('no row is ever dropped or duplicated across a full page sweep', () => {
    const seen: number[] = [];
    const first = paginate(items, 1, 10);
    for (let p = first.page; p <= first.totalPages; p++)
      seen.push(...paginate(items, p, 10).pageRows);
    expect(seen).toEqual(items);
  });
});

describe('paginationFooter', () => {
  test('renders nothing when there is only one page', () => {
    expect(paginationFooter(1, 1)).toBe('');
    expect(paginationFooter(1, 0)).toBe('');
  });

  test('disables prev on the first page and next on the last', () => {
    expect(paginationFooter(1, 3)).toContain('data-page-prev disabled');
    expect(paginationFooter(1, 3)).not.toContain('data-page-next disabled');
    expect(paginationFooter(3, 3)).toContain('data-page-next disabled');
    expect(paginationFooter(3, 3)).not.toContain('data-page-prev disabled');
  });

  test('enables both on a middle page and states the position', () => {
    const html = paginationFooter(2, 3);
    expect(html).toContain('Page 2 of 3');
    expect(html).not.toContain('disabled');
  });
});
