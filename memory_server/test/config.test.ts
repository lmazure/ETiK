import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("resolves the embedding model: english by default, a name, none, or a Hugging Face id", () => {
    expect(loadConfig({}).embeddingModel).toBe("Xenova/e5-small-v2");
    expect(loadConfig({ MEMORY_EMBEDDING_MODEL: "" }).embeddingModel).toBe("Xenova/e5-small-v2");
    expect(loadConfig({ MEMORY_EMBEDDING_MODEL: "english" }).embeddingModel).toBe("Xenova/e5-small-v2");
    expect(loadConfig({ MEMORY_EMBEDDING_MODEL: "multilingual" }).embeddingModel).toBe("Xenova/multilingual-e5-small");
    expect(loadConfig({ MEMORY_EMBEDDING_MODEL: "none" }).embeddingModel).toBeUndefined();
    expect(loadConfig({ MEMORY_EMBEDDING_MODEL: "Xenova/multilingual-e5-base" }).embeddingModel).toBe("Xenova/multilingual-e5-base");
    expect(loadConfig({ MEMORY_EMBEDDING_MODEL: "toString" }).embeddingModel).toBe("toString");
  });

  it("allows downloading the model unless told otherwise", () => {
    expect(loadConfig({}).modelDownload).toBe(true);
    expect(loadConfig({ MEMORY_MODEL_DOWNLOAD: "false" }).modelDownload).toBe(false);
    expect(() => loadConfig({ MEMORY_MODEL_DOWNLOAD: "no" })).toThrow("MEMORY_MODEL_DOWNLOAD must be 'true' or 'false', got 'no'");
    expect(loadConfig({ MEMORY_MODEL_DIR: "/app/models" }).modelDir).toBe("/app/models");
  });
});
