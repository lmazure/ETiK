import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { E2E } from "../playwright.config.js";

const agent = { Authorization: `Bearer ${E2E.agentToken}` };
const docs = "/api/stores/squashtm/docs";

async function create(request: APIRequestContext, path: string, text: string, description = "") {
  const response = await request.put(`${docs}${path}`, { headers: { ...agent, "If-None-Match": "*" }, data: { file_text: text, description } });
  expect(response.status()).toBe(201);
}

async function append(request: APIRequestContext, path: string, text: string, note: string) {
  const response = await request.patch(`${docs}${path}`, { headers: agent, data: { operations: [{ op: "append", text }], change_note: note } });
  expect(response.status()).toBe(200);
}

async function logIn(page: Page) {
  await page.goto("/");
  await page.getByLabel("Token").fill(E2E.viewerToken);
  await page.getByRole("button", { name: "Open" }).click();
  await expect(page.getByRole("button", { name: /^live/ })).toBeVisible();
}

test("a change made while a document is open is announced, not applied", async ({ page, request }) => {
  await create(request, "/entities/requirement.md", "# Requirement\n\n## UI pages\n- Page URL: /req\n", "Requirement entity");
  await create(request, "/index.md", "# Index\n");
  await logIn(page);

  await page.getByRole("link", { name: /requirement\.md/ }).click();
  const content = page.locator(".markdown");
  await expect(content).toContainText("Page URL: /req");
  await expect(page.locator(".history .versions li")).toHaveCount(1);

  await append(request, "/entities/requirement.md", "- Page URL: /req/new", "found the creation page");

  const banner = page.getByRole("status");
  await expect(banner).toContainText("Changed since you opened it", { timeout: 10_000 });
  await expect(banner).toContainText("v2 is the current version");
  await expect(content).not.toContainText("/req/new");
  await expect(page.locator(".doc-header .chip-past")).toContainText("v1 of 2");
  await expect(page.locator(".history .versions li")).toHaveCount(2);
  await expect(page.locator(".history .versions li").first()).toContainText("found the creation page");
  await expect(page.locator(".history .chip-new")).toHaveCount(1);
  await expect(page.locator(".tree .doc", { hasText: "requirement.md" }).locator(".chip-changed")).toBeVisible();
  await expect(page.getByRole("button", { name: /1 change since load/ })).toBeVisible();
  await page.screenshot({ path: "test-results/banner.png" });

  await page.getByRole("link", { name: "View v2" }).click();
  await expect(content).toContainText("/req/new");
  await expect(banner).toHaveCount(0);

  await page.getByRole("link", { name: "diff with v1" }).click();
  await expect(page.locator(".line-diff tr.add")).toContainText("- Page URL: /req/new");
  await page.screenshot({ path: "test-results/diff.png" });

  await page.getByRole("tab", { name: /Activity/ }).click();
  await expect(page.locator(".activity .live-change")).toHaveCount(1);
  await expect(page.locator(".activity .live-change")).toContainText("agent:squashtm");
  await expect(page.getByRole("button", { name: "Load older changes" })).toHaveCount(0);
  await page.screenshot({ path: "test-results/activity.png" });
});

test("new, moved and deleted documents are marked in the tree", async ({ page, request }) => {
  await create(request, "/tree/a.md", "a\n");
  await create(request, "/tree/b.md", "b\n");
  await logIn(page);
  await expect(page.locator(".tree")).toContainText("a.md");

  await create(request, "/tree/c.md", "c\n");
  await request.post("/api/stores/squashtm/move", { headers: agent, data: { old_path: "/tree/a.md", new_path: "/moved/a.md" } });
  await request.delete(`${docs}/tree/b.md`, { headers: agent });

  const doc = (name: string) => page.locator(".tree .doc", { hasText: name });
  await expect(doc("c.md").locator(".chip-new")).toBeVisible({ timeout: 10_000 });
  await expect(doc("b.md")).toHaveClass(/gone/);
  await expect(doc("b.md")).toContainText("deleted");
  await expect(page.locator(".tree .doc.gone", { hasText: "a.md" })).toContainText("moved → /moved/a.md");
  await expect(page.locator(".tree .doc:not(.gone)", { hasText: "a.md" })).toContainText("moved here");
  await page.screenshot({ path: "test-results/tree.png" });
  await expect(page.locator(".home")).toContainText("1 deleted");

  await doc("b.md").getByRole("link").click();
  await expect(page.locator(".doc-header .chip-deleted")).toBeVisible();
  await expect(page.locator(".history")).toContainText("deleted");
});

test("HTML written in a memory is shown as text, never rendered", async ({ page, request }) => {
  let dialogs = 0;
  page.on("dialog", (dialog) => {
    dialogs++;
    void dialog.dismiss();
  });
  await create(request, "/html.md",
    "# Grid\n\nThe save button is <button id=\"save\" onclick=\"alert(1)\">Save</button>.\n\n" +
    "<div class=\"grid\">\n  <img src=x onerror=\"alert(2)\">\n</div>\n\n<script>alert(3)</script>\n");
  await logIn(page);
  await page.getByRole("link", { name: /html\.md/ }).click();
  const content = page.locator(".markdown");
  await expect(content).toContainText('<button id="save" onclick="alert(1)">');
  await expect(content).toContainText('<div class="grid">');
  await expect(content).toContainText("<script>alert(3)</script>");
  await expect(content.locator("button, img, script, div.grid")).toHaveCount(0);
  await page.screenshot({ path: "test-results/html.png" });
  expect(dialogs).toBe(0);
});

test("search leads to the matching line", async ({ page, request }) => {
  await create(request, "/search/s.md", "one\ntwo\n- assumed, session_01: needle here\n");
  await logIn(page);
  await page.getByRole("searchbox", { name: "Search" }).fill("needle");
  await page.getByRole("searchbox", { name: "Search" }).press("Enter");
  await page.getByRole("link", { name: /needle here/ }).click();
  await expect(page.locator(".raw tr.highlight")).toContainText("needle here");
});

test("a link to another memory document opens it in the app", async ({ page, request }) => {
  await create(request, "/links/requirement.md", "# Requirement\n\nThe target.\n");
  await create(request, "/links/high-level.md",
    "Special nature of [requirement](/links/requirement.md); see also [campaign](campaign.md).\n");
  await logIn(page);
  const pages = page.context().pages().length;

  await page.locator(".tree .doc", { hasText: "high-level.md" }).getByRole("link").click();
  const content = page.locator(".markdown");
  await expect(content.locator(".memory-link.missing")).toHaveAttribute("title", "No document at /links/campaign.md");
  await content.getByRole("link", { name: "requirement" }).click();

  await expect(content).toContainText("The target.");
  await expect(page.locator(".doc-header h2")).toContainText("/links/requirement.md");
  expect(page.context().pages()).toHaveLength(pages);
});

test("a page opened while the memory is empty opens the store once the first memory is written", async ({ page, request }) => {
  // The e2e server is shared by the tests and already has a store: make the page see none at first.
  await page.route("**/api/stores", (route) => route.fulfill({ json: { stores: [] } }));
  await page.goto("/");
  await page.getByLabel("Token").fill(E2E.viewerToken);
  await page.getByRole("button", { name: "Open" }).click();
  await expect(page.getByRole("heading", { name: "The memory is empty" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^connecting/ })).toHaveCount(0);
  await page.screenshot({ path: "test-results/empty.png" });

  await create(request, "/empty/first.md", "# First\n", "First memory");
  await page.unroute("**/api/stores");

  await expect(page.getByRole("button", { name: /^live/ })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("heading", { name: "The memory is empty" })).toHaveCount(0);
  await expect(page.locator(".tree .doc", { hasText: "first.md" }).locator(".chip-new")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".tree .doc", { hasText: "first.md" })).toContainText("First memory");
});

test("line numbers do not wrap next to long lines", async ({ page, request }) => {
  const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
  lines[2] = "long ".repeat(400);
  await create(request, "/wrap/long.md", lines.join("\n") + "\n");
  await logIn(page);
  await page.locator(".tree .doc", { hasText: "long.md" }).getByRole("link").click();
  await page.getByRole("button", { name: "Raw" }).click();

  const height = async (n: number) => (await page.locator(".raw td.ln").nth(n - 1).boundingBox())!.height;
  expect(await height(10)).toBeCloseTo(await height(9), 0);
  expect(await height(12)).toBeCloseTo(await height(9), 0);
});
