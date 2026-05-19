/**
 * Safe markdown → HTML for operator-written incident update bodies.
 *
 * SECURITY INVARIANT (do not reorder): escape EVERYTHING first, then
 * introduce a tiny set of *literal* tags into the already-escaped
 * string. We never run markdown rewriting on raw input and never feed
 * rewritten output back through the escaper. After step 1 the string
 * contains zero live HTML; steps 2+ only INSERT `<strong>`, `<code>`,
 * `<p>`, `<br>` around already-escaped text. Consequence: `**<script>**`
 * → `<strong>&lt;script&gt;</strong>` — never a live <script>.
 *
 * Supported subset (deliberately tiny — reduces attack surface, zero
 * deps): blank line = paragraph break, single newline = <br>,
 * `**bold**`, `` `inline code` ``. No links, images, or raw HTML — the
 * status page is public and unauthenticated. Bodies are stored RAW and
 * rendered here at request time (a sanitiser fix needs no migration).
 */

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

export function renderIncidentMarkdown(raw: string): string {
  // 1. Escape first — after this line nothing can be a live tag.
  const escaped = escapeHtml(String(raw ?? ''));

  // 2. Re-introduce only literal, known-safe tags into escaped text.
  //    Code first so `**` inside a code span is not bolded.
  const blocks = escaped
    .replace(/\r\n/g, '\n')
    .split(/\n[ \t]*\n+/) // blank line → paragraph break
    .map((block) => {
      const inline = block
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\n/g, '<br>'); // single newline → <br>
      return inline.trim() ? `<p>${inline.trim()}</p>` : '';
    })
    .filter(Boolean);

  return blocks.join('');
}
