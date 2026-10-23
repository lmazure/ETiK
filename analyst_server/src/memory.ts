/** The memory server, through its REST API: reading the tester's issue reports, writing the analyses. */
import { AnalystError } from "./errors.js";
import type { Fetch } from "./gitlab/client.js";

export interface MemoryOptions {
  url: string;
  token: string;
  store: string;
  fetch?: Fetch;
  timeoutMs?: number;
}

export interface WriteRequest {
  text: string;
  description: string;
  tags: string[];
  metadata: Record<string, string>;
  changeNote: string;
}

export interface WriteResult {
  path: string;
  version: number;
  created: boolean;
}

function docUrl(base: string, store: string, path: string): string {
  return `${base}/api/stores/${encodeURIComponent(store)}/docs${path.split("/").map(encodeURIComponent).join("/")}`;
}

export class MemoryClient {
  private readonly fetch: Fetch;

  constructor(private readonly options: MemoryOptions) {
    this.fetch = options.fetch ?? fetch;
  }

  private async send(path: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetch(docUrl(this.options.url, this.options.store, path), {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${this.options.token}` },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
      });
    } catch (error) {
      throw new AnalystError("MEMORY_ERROR", `The memory server is unreachable at ${this.options.url} (${String(error)}).`);
    }
  }

  private async failure(response: Response, what: string): Promise<AnalystError> {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: { message?: string } | string; message?: string };
      detail = typeof body.error === "string" ? body.error : body.error?.message ?? body.message ?? "";
    } catch {
      // Not JSON.
    }
    return new AnalystError(response.status === 404 ? "NOT_FOUND" : "MEMORY_ERROR", `${what}: memory server answered ${response.status}${detail ? ` (${detail})` : ""}.`);
  }

  /** The content of a text document. */
  async read(path: string): Promise<string> {
    const response = await this.send(path, { method: "GET" });
    if (!response.ok) throw await this.failure(response, `Cannot read ${path}`);
    return ((await response.json()) as { content: string }).content;
  }

  /** Overwrites the document, or creates it when it does not exist yet. */
  async write(path: string, request: WriteRequest): Promise<WriteResult> {
    const body = JSON.stringify({
      file_text: request.text, description: request.description, tags: request.tags, metadata: request.metadata, change_note: request.changeNote,
    });
    const headers = { "Content-Type": "application/json" };
    let response = await this.send(path, { method: "PUT", headers, body });
    if (response.status === 404) response = await this.send(path, { method: "PUT", headers: { ...headers, "If-None-Match": "*" }, body });
    if (!response.ok) throw await this.failure(response, `Cannot write ${path}`);
    const result = (await response.json()) as { version: number; created?: boolean };
    return { path, version: result.version, created: result.created === true };
  }
}
