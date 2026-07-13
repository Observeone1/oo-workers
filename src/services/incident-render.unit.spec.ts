/**
 * Unit tests for renderIncidentMarkdown — the escape-then-reintroduce
 * markdown renderer for public, unauthenticated status-page incident
 * bodies. Locks the security invariant (escape first, never feed
 * rewritten output back through the escaper) and the supported markdown
 * subset.
 */

import { describe, test, expect } from 'bun:test';
import { renderIncidentMarkdown } from './incident-render.ts';

describe('renderIncidentMarkdown', () => {
  test('wraps plain text in a single paragraph', () => {
    expect(renderIncidentMarkdown('Hello world')).toBe('<p>Hello world</p>');
  });

  test('empty string renders to empty output', () => {
    expect(renderIncidentMarkdown('')).toBe('');
  });

  test('undefined/null-ish input renders to empty output', () => {
    expect(renderIncidentMarkdown(undefined as unknown as string)).toBe('');
  });

  test('bold syntax becomes <strong>', () => {
    expect(renderIncidentMarkdown('Hello **world**')).toBe('<p>Hello <strong>world</strong></p>');
  });

  test('inline code syntax becomes <code>', () => {
    expect(renderIncidentMarkdown('Use `foo()` here')).toBe('<p>Use <code>foo()</code> here</p>');
  });

  test('blank line separates paragraphs', () => {
    expect(renderIncidentMarkdown('para one\n\npara two')).toBe('<p>para one</p><p>para two</p>');
  });

  test('single newline becomes <br> within a paragraph', () => {
    expect(renderIncidentMarkdown('line one\nline two')).toBe('<p>line one<br>line two</p>');
  });

  test('bold and code combine in the same paragraph', () => {
    expect(renderIncidentMarkdown('**bold** and `code` mixed')).toBe(
      '<p><strong>bold</strong> and <code>code</code> mixed</p>',
    );
  });

  test('security invariant: bolded raw HTML never produces a live tag', () => {
    const out = renderIncidentMarkdown('**<script>alert(1)</script>**');
    expect(out).toBe('<p><strong>&lt;script&gt;alert(1)&lt;/script&gt;</strong></p>');
    expect(out).not.toContain('<script>');
  });

  test('escapes ampersand, quotes, and apostrophe', () => {
    expect(renderIncidentMarkdown(`Quote " and amp & and apos '`)).toBe(
      '<p>Quote &quot; and amp &amp; and apos &#39;</p>',
    );
  });

  test('raw angle brackets outside of markdown are escaped, not rendered', () => {
    expect(renderIncidentMarkdown('<b>not real html</b>')).toBe(
      '<p>&lt;b&gt;not real html&lt;/b&gt;</p>',
    );
  });
});
