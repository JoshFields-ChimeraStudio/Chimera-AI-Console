/**
 * ADO stores comments, history and descriptions as HTML. Agent text goes in
 * escaped (so it can never inject markup), with line breaks kept; HTML coming
 * back from ADO is flattened to text for the agent.
 */

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPES[ch]!);
}

/** Plain text to safe HTML: escaped, with line breaks as <br>. */
export function textToHtml(text: string): string {
  return escapeHtml(text.replace(/\r\n?/g, "\n")).replace(/\n/g, "<br>");
}

/** "[Tiamat] " followed by the agent's text, as safe HTML. */
export function attributedHtml(agentName: string, text: string): string {
  return `${escapeHtml(`[${agentName}]`)} ${textToHtml(text)}`;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };

/** Rough HTML to text for showing ADO fields and comments to an agent. */
export function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|li|h[1-6]|tr)\s*>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "- ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, name: string) => {
      const lower = name.toLowerCase();
      if (lower in ENTITIES) return ENTITIES[lower]!;
      if (lower.startsWith("#x")) return String.fromCodePoint(parseInt(lower.slice(2), 16));
      if (lower.startsWith("#")) return String.fromCodePoint(Number(lower.slice(1)));
      return m;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
