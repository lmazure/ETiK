import { describe, expect, it } from "vitest";
import { EMBEDDING_MODELS } from "../../src/config.js";
import { TransformersEmbedder } from "../../src/embedding/transformers.js";
import { testCore } from "../helpers.js";

/** Runs the real models; they are downloaded on first run, into MEMORY_MODEL_DIR when set. */
describe.skipIf(process.env.MEMORY_TEST_REAL_MODEL !== "1")("real embedding models", () => {
  async function topHit(model: string, deletionRule: string) {
    const embedder = new TransformersEmbedder({ model, cacheDir: process.env.MEMORY_MODEL_DIR, allowDownload: true });
    const t = testCore(10_000, 20_000, { embedder, refreshDelayMs: 60_000 });
    t.write({ path: "/knowledge/requirement.md", file_text: `# Requirement\n\n## Deletion\n- ${deletionRule}\n` });
    t.write({ path: "/knowledge/login.md", file_text: "# Login\n\n## UI pages\n- The login page has a forgot password link\n" });
    t.write({ path: "/knowledge/campaign.md", file_text: "# Campaign\n\n## Business rules\n- Campaigns are grouped in folders\n" });
    const result = await t.search({ query: "can a requirement with test cases be deleted?", mode: "semantic" });
    t.core.close();
    return { hit: result.hits[0], dimensions: (await embedder.embedQuery("x")).length };
  }

  it("english: finds a passage written in other words", async () => {
    const { hit, dimensions } = await topHit(EMBEDDING_MODELS.english!, "Removing a requirement that is linked to a test case is refused");
    expect(hit).toMatchObject({ path: "/knowledge/requirement.md", section: "## Deletion" });
    expect(dimensions).toBe(384);
  }, 300_000);

  it("multilingual: finds a French passage for an English question", async () => {
    const { hit, dimensions } = await topHit(EMBEDDING_MODELS.multilingual!, "Une exigence liée à un cas de test ne peut pas être supprimée");
    expect(hit).toMatchObject({ path: "/knowledge/requirement.md", section: "## Deletion" });
    expect(dimensions).toBe(384);
  }, 300_000);
});
