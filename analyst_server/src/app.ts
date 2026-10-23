import { resolve } from "node:path";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { AuthError, Authenticator } from "./auth.js";
import type { Config } from "./config.js";
import { Analyses } from "./engine/analyses.js";
import { JobQueue } from "./engine/jobs.js";
import { AgentSdkRunner, type Runner } from "./engine/runner.js";
import { GitLabClient, type Fetch } from "./gitlab/client.js";
import { MergeRequests } from "./gitlab/merge-requests.js";
import { Search } from "./gitlab/search.js";
import { WorkItems } from "./gitlab/work-items.js";
import { Formatter } from "./mcp/format.js";
import { registerMcp, type Engine, type Services } from "./mcp/server.js";
import { MemoryClient } from "./memory.js";
import { credentialEnv, Repos } from "./repos/repos.js";

export interface AppDependencies {
  /** The fetch used to call GitLab and the memory server; replaced in tests. */
  fetch?: Fetch;
  /** The agent of the analyses; by default the Agent SDK, when CLAUDE_CODE_OAUTH_TOKEN is set. */
  runner?: Runner;
  /** Where projects are cloned from; by default `<GITLAB_URL>/<project>.git`, as a partial clone. */
  cloneUrl?: (project: string) => string;
  partialClone?: boolean;
  progressIntervalMs?: number;
}

/** The GitLab client of a configuration (the token is required). */
export function gitLabClient(config: Config, deps: AppDependencies = {}): GitLabClient {
  if (!config.gitlabToken) throw new Error("GITLAB_READ_TOKEN is not set");
  return new GitLabClient({ baseUrl: config.gitlabUrl, token: config.gitlabToken, timeoutMs: config.gitlabTimeoutMs, fetch: deps.fetch });
}

/** Builds the HTTP application: `/health`, `/auth-check` (for the tester's checks) and `/mcp` (MCP Streamable HTTP). */
export function buildApp(config: Config, options: FastifyServerOptions = {}, deps: AppDependencies = {}): FastifyInstance {
  if (!config.analystToken) throw new Error("ANALYST_TOKEN is not set");
  const app = Fastify(options);
  const auth = new Authenticator(config.analystToken);
  const gitlab = gitLabClient(config, deps);
  const refs = { gitlabUrl: config.gitlabUrl, defaultProject: config.defaultProject };
  const services: Services = {
    workItems: new WorkItems(gitlab, refs),
    mergeRequests: new MergeRequests(gitlab, refs),
    search: new Search(gitlab, refs, config.searchGroup),
    formatter: new Formatter(config.defaultProject),
    refs,
    maxOutputChars: config.mcpMaxOutputChars,
  };

  const gitEnv = credentialEnv(config.gitlabToken!);
  const repos = new Repos({
    dir: resolve(config.reposDir),
    groups: config.repoGroups,
    cloneUrl: deps.cloneUrl ?? ((project) => `${config.gitlabUrl}/${project}.git`),
    gitEnv,
    partial: deps.partialClone ?? true,
    gitlab,
  });
  const queue = new JobQueue({ maxJobs: config.maxJobs, timeoutMs: config.jobTimeoutMs });
  const runner = deps.runner ?? (config.claudeOauthToken ? new AgentSdkRunner({ model: config.model, oauthToken: config.claudeOauthToken }) : undefined);
  const memory = config.memoryToken
    ? new MemoryClient({ url: config.memoryUrl, token: config.memoryToken, store: config.memoryStore, fetch: deps.fetch })
    : undefined;
  const engine: Engine = {
    analyses: new Analyses({
      queue, runner, repos, memory, services, gitlabUrl: config.gitlabUrl, gitEnv,
      secrets: [config.gitlabToken, config.claudeOauthToken, config.memoryToken, config.analystToken],
    }),
    queue,
    progressIntervalMs: deps.progressIntervalMs ?? 30_000,
  };

  app.get("/health", { logLevel: "warn" }, async () => ({ status: "ok" }));
  app.get("/auth-check", { logLevel: "warn" }, async (request, reply) => {
    try {
      auth.authenticate(request.headers.authorization);
    } catch (error) {
      if (error instanceof AuthError) return reply.status(error.status).header("WWW-Authenticate", "Bearer").send({ error: error.message });
      throw error;
    }
    return reply.status(204).send();
  });
  registerMcp(app, services, engine, auth);
  return app;
}

