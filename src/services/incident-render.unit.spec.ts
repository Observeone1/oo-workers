/**
 * Tests for the incident-update markdown renderer. The security invariant is the
 * important contract: raw HTML is escaped BEFORE the tiny markdown subset is
 * introduced, so operator input can never inject a live tag onto the public
 * status page.
 */
import { describe, test, expect } from 'bun:test';
import { renderIncidentMarkdown } from './incident-render.ts';

describe('renderIncidentMarkdown - escaping', () => {
  test('escapes every HTML-significant character', () => {
    expect(renderIncidentMarkdown(`&<>"'`)).toBe('<p>&amp;&lt;&gt;&quot;&#39;</p>');
  });

  test('escapes tags before applying markdown, so no live tag survives', () => {
    const out = renderIncidentMarkdown('**<script>**');
    expect(out).toBe('<p><strong>&lt;script&gt;</strong></p>');
    expect(out).not.toContain('<script>');
  });
});

describe('renderIncidentMarkdown - markdown subset', () => {
  test('renders bold', () => {
    expect(renderIncidentMarkdown('**bold**')).toBe('<p><strong>bold</strong></p>');
  });

  test('renders inline code', () => {
    expect(renderIncidentMarkdown('`a+b`')).toBe('<p><code>a+b</code></p>');
  });

  test('turns a single newline into a line break', () => {
    expect(renderIncidentMarkdown('line1\nline2')).toBe('<p>line1<br>line2</p>');
  });

  test('normalises CRLF before splitting', () => {
    expect(renderIncidentMarkdown('a\r\nb')).toBe('<p>a<br>b</p>');
  });

  test('splits blank-line-separated blocks into paragraphs', () => {
    expect(renderIncidentMarkdown('para1\n\npara2')).toBe('<p>para1</p><p>para2</p>');
  });

  test('collapses runs of blank lines and drops empty blocks', () => {
    expect(renderIncidentMarkdown('a\n\n\n\nb')).toBe('<p>a</p><p>b</p>');
  });
});

describe('renderIncidentMarkdown - empty input', () => {
  test.each([
    ['empty string', ''],
    ['whitespace only', '   '],
  ])('returns an empty string for %s', (_label, input) => {
    expect(renderIncidentMarkdown(input)).toBe('');
  });

  test('coerces null/undefined to an empty string', () => {
    expect(renderIncidentMarkdown(null as unknown as string)).toBe('');
    expect(renderIncidentMarkdown(undefined as unknown as string)).toBe('');
  });
});
