// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { memoryLinkPath, renderMarkdown, type LinkResolver } from "../../web/src/markdown.js";

function render(source: string, links?: LinkResolver): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = renderMarkdown(source, links);
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

  it("opens links to existing memory documents in the app, and does not make missing ones clickable", () => {
    const existing = new Map([["/entities/requirement.md", "#/s/squashtm/doc/7"]]);
    const links: LinkResolver = (href) => {
      const path = memoryLinkPath(href, "/entities/high-level-requirement.md");
      return path === undefined ? undefined : { path, href: existing.get(path) };
    };
    const html = render(
      "Special nature of [requirement](/entities/requirement.md), [same](requirement.md#ui-pages), " +
        "[missing](/entities/campaign.md), [external](https://tm-en.doc.squashtest.com/).\n",
      links,
    );
    const anchors = [...html.querySelectorAll("a")];
    expect(anchors.map((a) => a.getAttribute("href"))).toEqual(["#/s/squashtm/doc/7", "#/s/squashtm/doc/7", "https://tm-en.doc.squashtest.com/"]);
    expect(anchors[0]?.getAttribute("target")).toBeNull();
    expect(anchors[0]?.textContent).toBe("requirement");
    expect(anchors[2]?.getAttribute("target")).toBe("_blank");
    const missing = html.querySelector("span.memory-link.missing");
    expect(missing?.textContent).toBe("missing");
    expect(missing?.getAttribute("title")).toBe("No document at /entities/campaign.md");
  });

  it("treats every link as external without a resolver", () => {
    const html = render("[requirement](/entities/requirement.md)\n");
    expect(html.querySelector("a")?.getAttribute("target")).toBe("_blank");
  });
});

describe("memory link paths", () => {
  const from = "/entities/requirement.md";
  it.each([
    ["/entities/campaign.md", "/entities/campaign.md"],
    ["campaign.md", "/entities/campaign.md"],
    ["./campaign.md", "/entities/campaign.md"],
    ["../business-rules.md", "/business-rules.md"],
    ["/business-rules.md#rules", "/business-rules.md"],
    ["#ui-pages", "/entities/requirement.md"],
    ["test%20case.md", "/entities/test case.md"],
  ])("%s → %s", (href, expected) => {
    expect(memoryLinkPath(href, from)).toBe(expected);
  });

  it.each(["https://example.com/x.md", "mailto:a@b.c", "//example.com/x", "../../x.md", "/", "%E0%A4%A"])("%s is not a memory path", (href) => {
    expect(memoryLinkPath(href, from)).toBeUndefined();
  });
});
