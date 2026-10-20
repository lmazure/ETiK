import { createHash } from "node:crypto";
import { chunkDocument, type Chunk } from "./chunks.js";
import type { Embedder } from "./embedder.js";
import { ROOT } from "./paths.js";
import type { Doc, Repository } from "./repository.js";

export interface Logger {
  info(message: string): void;
  error(error: unknown): void;
}

export interface SemanticOptions {
  /** Delay between a write and the embedding of the chunks it created, so that a burst of writes is indexed once. */
  refreshDelayMs: number;
  logger?: Logger | undefined;
}

/** One chunk ranked by a semantic or hybrid search, with the line chosen as its snippet. */
export interface RankedChunk {
  path: string;
  chunk: Chunk;
  score: number;
  line: string;
  /** Position in `line` of the first query term, 0 when none. */
  index: number;
}

/** Reciprocal Rank Fusion constant: the usual value, which damps the weight of the very first ranks. */
const RRF_K = 60;
const BM25_K1 = 1.2;
const BM25_B = 0.75;
/** Chunks embedded and stored together; a long indexing keeps what it has done if it stops. */
const EMBED_GROUP = 64;

const hashOf = (text: string) => createHash("sha256").update(text).digest("hex");

/** Lower case, accents removed: "Supprimée" and "supprimee" are the same term. */
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

export function tokenize(text: string): string[] {
  return fold(text).match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Okapi BM25 score of each document (token list) for the query terms; 0 when no term occurs. */
export function bm25(documents: string[][], queryTerms: string[]): number[] {
  const terms = [...new Set(queryTerms)];
  const counts = documents.map((tokens) => {
    const tf = new Map<string, number>();
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
    return tf;
  });
  const n = documents.length;
  const averageLength = documents.reduce((sum, tokens) => sum + tokens.length, 0) / Math.max(n, 1) || 1;
  const idf = terms.map((term) => {
    const df = counts.filter((tf) => tf.has(term)).length;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  });
  return counts.map((tf, d) => terms.reduce((score, term, t) => {
    const f = tf.get(term) ?? 0;
    if (f === 0) return score;
    const norm = 1 - BM25_B + BM25_B * documents[d]!.length / averageLength;
    return score + idf[t]! * f * (BM25_K1 + 1) / (f + BM25_K1 * norm);
  }, 0));
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

/** 1-based rank of each item when sorted by descending score; stable, so ties keep the input order (path, then line). */
function ranks(scores: number[]): number[] {
  const order = scores.map((score, i) => ({ score, i })).sort((a, b) => b.score - a.score);
  const result = new Array<number>(scores.length);
  order.forEach((item, rank) => (result[item.i] = rank + 1));
  return result;
}

/** The snippet line: the body line with most query terms, else the first one with a letter or digit. */
function snippetLine(chunk: Chunk, terms: Set<string>): { line: string; index: number } {
  const textual = chunk.body.filter((line) => /[\p{L}\p{N}]/u.test(line));
  const candidates = textual.length > 0 ? textual : chunk.body;
  let best = { line: candidates[0] ?? "", index: 0, count: 0 };
  for (const line of candidates) {
    const count = tokenize(line).filter((token) => terms.has(token)).length;
    if (count > best.count) {
      const lower = line.toLowerCase();
      const positions = [...terms].map((term) => lower.indexOf(term)).filter((p) => p >= 0);
      best = { line, index: positions.length > 0 ? Math.min(...positions) : 0, count };
    }
  }
  return { line: best.line, index: best.index };
}

/**
 * Semantic and hybrid ranking of document chunks. Vectors are cached in the database by model and chunk text,
 * and computed on demand: at search time for the chunks not cached yet, and in the background after writes.
 */
export class SemanticSearch {
  /** Embeddings being computed, by chunk hash, so that a search and a refresh never embed the same chunk twice. */
  private readonly pending = new Map<string, Promise<Float32Array>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly repo: Repository, private readonly embedder: Embedder, private readonly options: SemanticOptions) {}

  /** Chunks of the documents, most relevant first. Semantic: cosine similarity; hybrid: RRF of similarity and BM25. */
  async rank(docs: Doc[], query: string, mode: "semantic" | "hybrid"): Promise<RankedChunk[]> {
    const items = docs.flatMap((doc) => chunkDocument(doc.content, doc.description).map((chunk) => ({ path: doc.path, chunk })));
    if (items.length === 0) return [];
    const [{ vectors }, queryVector] = await Promise.all([
      this.ensure(items.map((item) => item.chunk.embedText)),
      this.embedder.embedQuery(query),
    ]);
    const similarity = vectors.map((vector) => dot(vector, queryVector));
    const queryTerms = tokenize(query);
    let scores = similarity;
    if (mode === "hybrid") {
      const lexical = bm25(items.map((item) => tokenize(item.chunk.searchText)), queryTerms);
      const semanticRank = ranks(similarity);
      const lexicalRank = ranks(lexical);
      scores = items.map((_, i) => 1 / (RRF_K + semanticRank[i]!) + (lexical[i]! > 0 ? 1 / (RRF_K + lexicalRank[i]!) : 0));
    }
    const precision = mode === "semantic" ? 1000 : 10_000;
    const terms = new Set(queryTerms);
    return items
      .map((item, i) => ({ ...item, exact: scores[i]! }))
      .sort((a, b) => b.exact - a.exact)
      .map(({ path, chunk, exact }) => ({ path, chunk, score: Math.round(exact * precision) / precision, ...snippetLine(chunk, terms) }));
  }

  /** Embeds, in the background and after a short delay, the chunks of a store that have no vector yet. */
  scheduleRefresh(store: string): void {
    if (this.timers.has(store)) return;
    const timer = setTimeout(() => {
      this.timers.delete(store);
      this.enqueue(() => this.refresh(store));
    }, this.options.refreshDelayMs);
    timer.unref();
    this.timers.set(store, timer);
  }

  /** At startup: loads the model, then indexes every store, in the background. */
  refreshAll(stores: string[]): void {
    this.enqueue(async () => {
      const start = Date.now();
      await this.embedder.embedQuery("warm-up");
      this.options.logger?.info(`Embedding model ${this.embedder.model} ready in ${Date.now() - start} ms`);
    });
    for (const store of stores) this.enqueue(() => this.refresh(store));
  }

  close(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch((error: unknown) => this.options.logger?.error(error));
  }

  private async refresh(store: string): Promise<void> {
    const start = Date.now();
    const docs = this.repo.listLiveDocsWithContent(store, ROOT).filter((doc) => doc.content_type === undefined);
    const { embedded } = await this.ensure(docs.flatMap((doc) => chunkDocument(doc.content, doc.description).map((c) => c.embedText)));
    if (embedded > 0) {
      this.options.logger?.info(`Semantic index of store ${store}: ${embedded} chunks embedded in ${Date.now() - start} ms`);
    }
  }

  /** The vector of each text, from the cache or computed and then cached. */
  private async ensure(texts: string[]): Promise<{ vectors: Float32Array[]; embedded: number }> {
    const model = this.embedder.model;
    const hashes = texts.map(hashOf);
    const cached = this.repo.getEmbeddings(model, [...new Set(hashes)]);
    const missing = new Map<string, string>();
    hashes.forEach((hash, i) => {
      if (!cached.has(hash) && !this.pending.has(hash)) missing.set(hash, texts[i]!);
    });
    const entries = [...missing];
    for (let start = 0; start < entries.length; start += EMBED_GROUP) {
      const group = entries.slice(start, start + EMBED_GROUP);
      const done = this.embedder.embedPassages(group.map(([, text]) => text)).then((vectors) => {
        this.repo.putEmbeddings(model, group.map(([hash], i) => ({ hash, vector: vectors[i]! })));
        return vectors;
      });
      group.forEach(([hash], i) => {
        const one = done.then((vectors) => vectors[i]!);
        this.pending.set(hash, one);
        one.then(() => this.pending.delete(hash), () => this.pending.delete(hash));
      });
    }
    const vectors = await Promise.all(hashes.map((hash) => cached.get(hash) ?? this.pending.get(hash)!));
    return { vectors, embedded: missing.size };
  }
}
