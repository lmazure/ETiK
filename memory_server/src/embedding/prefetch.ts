/**
 * Downloads the embedding model into MEMORY_MODEL_DIR and checks that it runs; used when building the Docker
 * image, so that the container never downloads at runtime.
 */
import { loadConfig } from "../config.js";
import { TransformersEmbedder } from "./transformers.js";

const config = loadConfig();
if (config.embeddingModel === undefined) {
  console.log("MEMORY_EMBEDDING_MODEL=none: no model to fetch");
} else {
  const embedder = new TransformersEmbedder({ model: config.embeddingModel, cacheDir: config.modelDir, allowDownload: true });
  const vector = await embedder.embedQuery("warm-up");
  console.log(`Model ${config.embeddingModel} ready in ${config.modelDir ?? "the default cache"} (${vector.length} dimensions)`);
}
