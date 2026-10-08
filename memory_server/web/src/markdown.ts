import DOMPurify from "dompurify";
import { Marked, type Tokens } from "marked";

/** Where a link to another memory document leads: the document's path, and its in-app href when it exists. */
export interface MemoryLink {
  path: string;
  href?: string | undefined;
}

/** Resolves a link to another memory document; undefined for a link that leaves the memory. */
export type LinkResolver = (href: string) => MemoryLink | undefined;

/**
 * The memory path a link points to, or undefined when the link is not a memory path
 * (it has a scheme, such as https: or mailto:, or starts with //).
 * Absolute paths start at the store root; relative paths and fragment-only links resolve against `fromPath`.
 * The query and fragment are dropped: a link opens the whole document.
 */
export function memoryLinkPath(href: string, fromPath: string): string | undefined {
  const trimmed = href.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith("//")) return undefined;
  let target = trimmed.replace(/[?#].*$/s, "");
  if (target === "") return fromPath;
  try {
    target = decodeURI(target);
  } catch {
    return undefined;
  }
  const base = target.startsWith("/") ? [] : fromPath.split("/").slice(0, -1);
  const segments = [...base];
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.filter((s) => s !== "").length === 0) return undefined;
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  const path = "/" + segments.filter((s) => s !== "").join("/");
  return path === "/" ? undefined : path;
}

/** Set by renderMarkdown for the duration of one synchronous parse. */
let resolveLink: LinkResolver | undefined;

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
    /** Links to memory documents open them in the app; a link to a missing document is not clickable. */
    link(token: Tokens.Link): string | false {
      const target = resolveLink?.(token.href);
      if (!target) return false; // external link: default rendering, opened in a new tab
      const text = this.parser.parseInline(token.tokens);
      if (target.href === undefined) {
        return `<span class="memory-link missing" title="No document at ${escapeHtml(target.path)}">${text}</span>`;
      }
      return `<a class="memory-link" href="${escapeHtml(target.href)}" title="${escapeHtml(target.path)}">${text}</a>`;
    },
    image({ href, text }: Tokens.Image): string {
      return `<a href="${escapeHtml(href)}">[image: ${escapeHtml(text || href)}]</a>`;
    },
  },
});

let hooked = false;

function purifier(): typeof DOMPurify {
  if (!hooked) {
    // External links open in a new tab, without giving the target page access to this one.
    // Links to memory documents (in-app hash routes) stay in the app.
    DOMPurify.addHook("afterSanitizeAttributes", (node) => {
      if (node.tagName === "A" && !(node.getAttribute("href") ?? "").startsWith("#")) {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
      }
    });
    hooked = true;
  }
  return DOMPurify;
}

/**
 * Markdown → safe HTML. DOMPurify runs as a second line of defence; it should find nothing to remove.
 * Without `links`, every link is treated as external.
 */
export function renderMarkdown(source: string, links?: LinkResolver): string {
  resolveLink = links;
  try {
    const html = marked.parse(source, { async: false });
    return purifier().sanitize(html, { USE_PROFILES: { html: true }, ADD_ATTR: ["target"] });
  } finally {
    resolveLink = undefined;
  }
}
