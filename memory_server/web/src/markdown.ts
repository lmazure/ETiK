import DOMPurify from "dompurify";
import { Marked, type Tokens } from "marked";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * Memory documents may describe the SUT's HTML and may contain text copied from untrusted pages.
 * Raw HTML is therefore never interpreted: it is shown, escaped, exactly as written.
 * External images are not loaded: they become links.
 */
const marked = new Marked({
  gfm: true,
  renderer: {
    html({ text, block }: Tokens.HTML | Tokens.Tag): string {
      const escaped = escapeHtml(block ? text.replace(/\n+$/, "") : text);
      return block ? `<pre class="raw-html"><code>${escaped}</code></pre>\n` : `<code class="raw-html">${escaped}</code>`;
    },
    image({ href, text }: Tokens.Image): string {
      return `<a href="${escapeHtml(href)}">[image: ${escapeHtml(text || href)}]</a>`;
    },
  },
});

let hooked = false;

function purifier(): typeof DOMPurify {
  if (!hooked) {
    // Links open in a new tab, without giving the target page access to this one.
    DOMPurify.addHook("afterSanitizeAttributes", (node) => {
      if (node.tagName === "A") {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
      }
    });
    hooked = true;
  }
  return DOMPurify;
}

/** Markdown → safe HTML. DOMPurify runs as a second line of defence; it should find nothing to remove. */
export function renderMarkdown(source: string): string {
  const html = marked.parse(source, { async: false });
  return purifier().sanitize(html, { USE_PROFILES: { html: true }, ADD_ATTR: ["target"] });
}
