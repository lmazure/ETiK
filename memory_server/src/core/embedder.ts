/**
 * Turns texts into vectors for semantic search. The core only sees this interface; the model runs in
 * `src/embedding/` (or is faked by the tests).
 */
export interface Embedder {
  /** Identifies the model: vectors are cached per model, so changing it re-embeds everything. */
  readonly model: string;
  /** Vectors of passages (document chunks), normalized to length 1; the embedder adds any prefix its model needs. */
  embedPassages(texts: string[]): Promise<Float32Array[]>;
  /** Vector of a search query, normalized to length 1. */
  embedQuery(text: string): Promise<Float32Array>;
}
