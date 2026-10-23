import { AnalystError } from "../errors.js";

export type Fetch = typeof fetch;

export interface ClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs: number;
  fetch?: Fetch;
  /** Waits between a 429 and its retry; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface TokenInfo {
  name: string;
  scopes: string[];
  active: boolean;
  revoked: boolean;
  expires_at: string | null;
}

export type Query = Record<string, string | number | boolean | string[] | undefined>;

const MAX_RETRY_WAIT_MS = 10_000;

/** URL-encoded project or group path, as the REST API expects it in `/projects/:id` and `/groups/:id`. */
export function encodePath(path: string): string {
  return encodeURIComponent(path);
}

/**
 * Read-only access to one GitLab instance: GET on the REST API and queries on the GraphQL API.
 * Errors become AnalystErrors whose message can be shown to the model.
 */
export class GitLabClient {
  private readonly fetch: Fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: ClientOptions) {
    this.fetch = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** GET `/api/v4<path>`; `path` is built by the server from parsed references only. */
  async rest<T>(path: string, query: Query = {}): Promise<T> {
    const url = new URL(`/api/v4${path}`, this.options.baseUrl);
    for (const [name, value] of Object.entries(query)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) for (const v of value) url.searchParams.append(name, v);
      else url.searchParams.set(name, String(value));
    }
    const response = await this.send(url, { method: "GET" });
    return (await response.json()) as T;
  }

  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const url = new URL("/api/graphql", this.options.baseUrl);
    const response = await this.send(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const body = (await response.json()) as { data?: T; errors?: { message: string }[] };
    if (body.errors?.length) {
      throw new AnalystError("GITLAB_ERROR", `GitLab GraphQL error: ${body.errors.map((e) => e.message).join("; ")}`);
    }
    if (body.data === undefined) throw new AnalystError("GITLAB_ERROR", "GitLab GraphQL returned no data");
    return body.data;
  }

  /** The token's own description: name, scopes, state. */
  async tokenInfo(): Promise<TokenInfo> {
    return this.rest<TokenInfo>("/personal_access_tokens/self");
  }

  private async send(url: URL, init: RequestInit, retried = false): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetch(url, {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${this.options.token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(this.options.timeoutMs),
        redirect: "error",
      });
    } catch (error) {
      const reason = error instanceof Error && error.name === "TimeoutError" ? `no answer within ${this.options.timeoutMs} ms` : String(error);
      throw new AnalystError("GITLAB_UNAVAILABLE", `GitLab is unreachable (${reason}); try again later.`);
    }
    if (response.ok) return response;
    if (response.status === 429 && !retried) {
      const wait = Math.min(Number(response.headers.get("retry-after") ?? "1") * 1000 || 1000, MAX_RETRY_WAIT_MS);
      await this.sleep(wait);
      return this.send(url, init, true);
    }
    throw await this.error(response);
  }

  private async error(response: Response): Promise<AnalystError> {
    let detail = "";
    try {
      const body = (await response.json()) as { message?: unknown; error?: unknown };
      const message = body.message ?? body.error;
      if (message !== undefined) detail = `: ${typeof message === "string" ? message : JSON.stringify(message)}`;
    } catch {
      // Not JSON: the status says enough.
    }
    switch (response.status) {
      case 401: return new AnalystError("GITLAB_ERROR", `GitLab rejected the analyst's token (401${detail}); the administrator must renew GITLAB_READ_TOKEN.`);
      case 403: return new AnalystError("FORBIDDEN", `The analyst's GitLab token cannot read this (403${detail}).`);
      case 404: return new AnalystError("NOT_FOUND", `Not found on GitLab, or not readable with the analyst's token (404${detail}).`);
      case 429: return new AnalystError("GITLAB_UNAVAILABLE", "GitLab rate limit reached (429); try again in a minute.");
      default:
        if (response.status >= 500) return new AnalystError("GITLAB_UNAVAILABLE", `GitLab failed (${response.status}); try again later.`);
        return new AnalystError("GITLAB_ERROR", `GitLab answered ${response.status}${detail}.`);
    }
  }
}

/**
 * Checks that the token only reads: every scope must be a `read_*` one, and the token must be active.
 * Returns a reason to refuse it, or undefined when it is fine.
 */
export function tokenProblem(info: TokenInfo): string | undefined {
  if (!info.active || info.revoked) return `the GitLab token '${info.name}' is not active (revoked or expired)`;
  const writing = info.scopes.filter((scope) => !scope.startsWith("read_"));
  if (writing.length) {
    return `the GitLab token '${info.name}' must be read-only, but it has the scope(s) ${writing.join(", ")}; use a token with read_api and read_repository only`;
  }
  return undefined;
}

