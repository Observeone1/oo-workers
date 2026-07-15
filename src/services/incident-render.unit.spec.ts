/**
 * Tests for the incident-update markdown renderer. The security invariant is the
 * important contract: raw HTML is escaped BEFORE the tiny markdown subset is
 * introduced, so operator input can never inject a live tag onto the public
 * status page. Cases are table-driven to keep each to a single row.
 */
import { describe, test, expect } from 'bun:test';
import { renderIncidentMarkdown } from './incident-render.ts';

describe('renderIncidentMarkdown', () => {
  test.each([
    ['escapes every HTML-significant character', `&<>"'`, '<p>&amp;&lt;&gt;&quot;&#39;</p>'],
    ['escapes tags before markdown', '**<script>**', '<p><strong>&lt;script&gt;</strong></p>'],
    ['renders bold', '**bold**', '<p><strong>bold</strong></p>'],
    ['renders inline code', '`a+b`', '<p><code>a+b</code></p>'],
    ['single newline becomes a break', 'line1\nline2', '<p>line1<br>line2</p>'],
    ['normalises CRLF', 'a\r\nb', '<p>a<br>b</p>'],
    ['blank line splits paragraphs', 'para1\n\npara2', '<p>para1</p><p>para2</p>'],
    ['collapses blank-line runs and drops empties', 'a\n\n\n\nb', '<p>a</p><p>b</p>'],
    ['empty string', '', ''],
    ['whitespace only', '   ', ''],
  ])('%s', (_label, input, expected) => {
    expect(renderIncidentMarkdown(input)).toBe(expected);
  });

  test('never emits a live tag from hostile input', () => {
    expect(renderIncidentMarkdown('**<script>**')).not.toContain('<script>');
  });

  test('coerces null/undefined to an empty string', () => {
    expect(renderIncidentMarkdown(null as unknown as string)).toBe('');
    expect(renderIncidentMarkdown(undefined as unknown as string)).toBe('');
  });
});
