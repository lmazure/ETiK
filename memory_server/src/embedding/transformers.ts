import { env, pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import type { Embedder } from "../core/embedder.js";

export interface TransformersOptions {
  /** Hugging Face model id, with ONNX weights (e.g. `Xenova/multilingual-e5-small`). */
  model: string;
  /** Where models are cached; default: the transformers.js cache. */
  cacheDir?: string | undefined;
  /** False: only use the cache, never download (the Docker image ships its model). */
  allowDownload: boolean;
}

/**
 * Texts embedded per inference call; between calls, other requests (e.g. a search query) get their turn.
 * One: a batch is padded to its longest text, which costs memory (about 500 MB more at peak for 16 texts)
 * and time (one at a time is also faster).
 */
const BATCH = 1;

/**
 * Runs a sentence-embedding model in-process with transformers.js (ONNX Runtime, CPU). E5 models expect
 * `query: ` and `passage: ` prefixes; vectors are mean-pooled and normalized.
 * The model is loaded on first use; inference calls run one at a time, on one text each.
 */
export class TransformersEmbedder implements Embedder {
  readonly model: string;
  private extractor: Promise<FeatureExtractionPipeline> | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: TransformersOptions) {
    this.model = options.model;
  }

  async embedPassages(texts: string[]): Promise<Float32Array[]> {
    const vectors: Float32Array[] = [];
    for (let start = 0; start < texts.length; start += BATCH) {
      vectors.push(...await this.run(texts.slice(start, start + BATCH).map((text) => this.prefix("passage: ") + text)));
    }
    return vectors;
  }

  async embedQuery(text: string): Promise<Float32Array> {
    return (await this.run([this.prefix("query: ") + text]))[0]!;
  }

  private prefix(prefix: string): string {
    return /\be5\b|-e5-/i.test(this.model) ? prefix : "";
  }

  private load(): Promise<FeatureExtractionPipeline> {
    this.extractor ??= (async () => {
      if (this.options.cacheDir !== undefined) env.cacheDir = this.options.cacheDir;
      env.allowRemoteModels = this.options.allowDownload;
      return await pipeline("feature-extraction", this.model, { dtype: "q8" });
    })().catch((error: unknown) => {
      this.extractor = undefined; // a later call tries again
      throw error;
    });
    return this.extractor;
  }

  private run(texts: string[]): Promise<Float32Array[]> {
    const next = this.queue.then(async () => {
      const extractor = await this.load();
      const output = await extractor(texts, { pooling: "mean", normalize: true });
      const [count, dimensions] = output.dims as [number, number];
      const data = output.data as Float32Array;
      return Array.from({ length: count }, (_, i) => data.slice(i * dimensions, (i + 1) * dimensions));
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
}
