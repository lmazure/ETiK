// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../../web/src/markdown.js";

function render(source: string): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = renderMarkdown(source);
  return container;
}

describe("markdown rendering", () => {
  it("renders Markdown", () => {
    const html = render("# Title\n\n- **item** with `code`\n");
    expect(html.querySelector("h1")?.textContent).toBe("Title");
    expect(html.querySelector("li strong")?.textContent).toBe("item");
  });

  it("shows inline HTML as escaped text, never as elements", () => {
    const html = render('The save button is <button id="save" onclick="alert(1)">Save</button> and <img src=x onerror=alert(1)>.\n');
    expect(html.querySelector("button, img, [onclick], [onerror]")).toBeNull();
    expect(html.textContent).toContain('<button id="save" onclick="alert(1)">');
    expect(html.textContent).toContain("</button>");
    expect(html.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("shows HTML blocks verbatim as escaped text", () => {
    const block = '<div class="grid">\n  <span data-id="7">Requirement</span>\n</div>';
    const html = render(`Markup of the grid:\n\n${block}\n\n<script>alert(1)</script>\n`);
    expect(html.querySelector("div.grid, span, script")).toBeNull();
    const pres = [...html.querySelectorAll("pre.raw-html")].map((p) => p.textContent);
    expect(pres).toEqual([block, "<script>alert(1)</script>"]);
  });

  it("keeps HTML in code blocks verbatim", () => {
    const html = render("```html\n<input name=\"q\">\n```\n");
    expect(html.querySelector("input")).toBeNull();
    expect(html.querySelector("pre code")?.textContent).toBe('<input name="q">\n');
  });

  it("turns images into links and makes links safe", () => {
    const html = render("![shot](https://evil.example/x.png) [doc](https://tm-en.doc.squashtest.com/) [bad](javascript:alert(1))\n");
    expect(html.querySelector("img")).toBeNull();
    const links = [...html.querySelectorAll("a")];
    expect(links[0]?.textContent).toBe("[image: shot]");
    expect(links[1]?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(links[1]?.getAttribute("target")).toBe("_blank");
    expect(links.some((a) => (a.getAttribute("href") ?? "").startsWith("javascript:"))).toBe(false);
  });
});
