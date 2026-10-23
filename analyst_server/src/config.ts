export interface Config {
  host: string;
  port: number;
  /** Bearer token of the callers (the tester); every MCP request must present it. */
  analystToken: string | undefined;
  /** Origin of the GitLab instance; the only host the server ever calls. */
  gitlabUrl: string;
  /** Read-only GitLab token (scopes read_api, read_repository); checked at start. */
  gitlabToken: string | undefined;
  /** Project of the short references `#123`, `!123` and `123`. */
  defaultProject: string;
  /** Group searched by gitlab_search when no project is given. */
  searchGroup: string;
  /** Timeout of one GitLab request, in milliseconds. */
  gitlabTimeoutMs: number;
  /** Maximum size of one MCP tool result, in characters; longer results are truncated with a notice. */
  mcpMaxOutputChars: number;
  /** Subscription token of the analyses' Claude agent (`claude setup-token`); without it, only the GitLab tools work. */
  claudeOauthToken: string | undefined;
  /** Model of the analyses (an alias such as `opus`, or a model id). */
  model: string;
  /** Analyses run at the same time; the others wait in a queue. */
  maxJobs: number;
  /** Longest an analysis may run, in milliseconds. */
  jobTimeoutMs: number;
  /** Groups whose projects the agent may check out. */
  repoGroups: string[];
  /** Where the clones and the job worktrees live. */
  reposDir: string;
  /** Memory server where the analyses are stored. */
  memoryUrl: string;
  /** Agent token of the memory store; without it, results are not stored and issue reports cannot be read. */
  memoryToken: string | undefined;
  memoryStore: string;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer, got '${raw}'`);
  return value;
}

/** An https origin (or http, for a local instance), without path, query or trailing slash. */
function origin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`GITLAB_URL must be a URL such as https://gitlab.com, got '${raw}'`);
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new Error(`GITLAB_URL must be an origin such as https://gitlab.com, without path, got '${raw}'`);
  }
  return url.origin;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    host: env.HOST ?? "0.0.0.0",
    port: integer(env, "PORT", 9502),
    analystToken: env.ANALYST_TOKEN || undefined,
    gitlabUrl: origin(env.GITLAB_URL || "https://gitlab.com"),
    gitlabToken: env.GITLAB_READ_TOKEN || undefined,
    defaultProject: env.GITLAB_DEFAULT_PROJECT || "henixdevelopment/squash/squash-tm/core/squashtest-tm-staging",
    searchGroup: env.GITLAB_SEARCH_GROUP || "henixdevelopment/squash",
    gitlabTimeoutMs: integer(env, "GITLAB_TIMEOUT_MS", 30_000),
    mcpMaxOutputChars: integer(env, "ANALYST_MCP_MAX_OUTPUT_CHARS", 40_000),
    claudeOauthToken: env.CLAUDE_CODE_OAUTH_TOKEN || undefined,
    model: env.ANALYST_MODEL || "opus",
    maxJobs: integer(env, "ANALYST_MAX_JOBS", 1),
    jobTimeoutMs: integer(env, "ANALYST_JOB_TIMEOUT_MS", 45 * 60_000),
    repoGroups: (env.ANALYST_REPO_GROUPS || "henixdevelopment/squash/squash-tm/core,henixdevelopment/squash/squash-tm/tm-plugin")
      .split(",").map((g) => g.trim()).filter((g) => g !== ""),
    reposDir: env.ANALYST_REPOS_DIR || "./data/repos",
    memoryUrl: (env.MEMORY_URL || "http://host.docker.internal:9501").replace(/\/+$/, ""),
    memoryToken: env.MEMORY_AGENT_TOKEN || undefined,
    memoryStore: env.ANALYST_MEMORY_STORE || "squashtm",
  };
}
