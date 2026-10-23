/**
 * The code repositories of the analyses: one bare partial clone per project, fetched before each checkout, and one
 * detached worktree per job and project, at the head of the project's default branch. Only projects of the
 * configured groups can be checked out. The GitLab token is only given to the server's own git commands.
 */
import { access, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { AnalystError } from "../errors.js";
import { encodePath, type GitLabClient } from "../gitlab/client.js";
import { isNamespacePath } from "../gitlab/refs.js";
import { runGit } from "./git.js";

export interface Checkout {
  project: string;
  branch: string;
  sha: string;
  /** Absolute path of the worktree. */
  path: string;
}

export interface ProjectInfo {
  path: string;
  defaultBranch: string | undefined;
  description: string;
  lastActivity: string;
}

export interface ReposOptions {
  /** Root of the clones (`git/`) and of the job worktrees (`work/`). */
  dir: string;
  groups: string[];
  /** URL to clone a project from. */
  cloneUrl: (project: string) => string;
  /** Environment of the git commands that reach GitLab (credentials). */
  gitEnv: Record<string, string>;
  /** Partial clone (blobs fetched on demand); off for local test repositories. */
  partial: boolean;
  gitlab: GitLabClient | undefined;
}

interface RawProject { path_with_namespace: string; default_branch: string | null; description: string | null; last_activity_at: string; archived: boolean }

const PROJECTS_TTL_MS = 60 * 60_000;
const PER_PAGE = 100;
const MAX_PAGES = 10;

/** Environment giving the token to git through a credential helper, without writing it anywhere. */
export function credentialEnv(token: string): Record<string, string> {
  return {
    ANALYST_GIT_TOKEN: token,
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: '!f() { test "$1" = get && echo username=oauth2 && echo "password=$ANALYST_GIT_TOKEN"; }; f',
  };
}

export class Repos {
  private projects: { at: number; list: ProjectInfo[] } | undefined;
  /** One chain of operations per clone: clone, fetch and worktree changes never overlap. */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly options: ReposOptions) {}

  get workDir(): string {
    return join(this.options.dir, "work");
  }

  jobDir(jobId: string): string {
    return join(this.workDir, jobId);
  }

  isAllowed(project: string): boolean {
    return isNamespacePath(project) && this.options.groups.some((g) => project.startsWith(`${g}/`));
  }

  /** The projects of the configured groups (not archived), cached for an hour. */
  async listProjects(): Promise<ProjectInfo[]> {
    if (this.projects && Date.now() - this.projects.at < PROJECTS_TTL_MS) return this.projects.list;
    const gitlab = this.options.gitlab;
    if (!gitlab) return [];
    const list: ProjectInfo[] = [];
    for (const group of this.options.groups) {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const batch = await gitlab.rest<RawProject[]>(`/groups/${encodePath(group)}/projects`, {
          include_subgroups: true, archived: false, simple: false, per_page: PER_PAGE, page, order_by: "path", sort: "asc",
        });
        for (const p of batch) {
          if (!p.archived) list.push({ path: p.path_with_namespace, defaultBranch: p.default_branch ?? undefined, description: p.description ?? "", lastActivity: p.last_activity_at });
        }
        if (batch.length < PER_PAGE) break;
      }
    }
    this.projects = { at: Date.now(), list };
    return list;
  }

  private bareDir(project: string): string {
    return join(this.options.dir, "git", `${project}.git`);
  }

  private locked<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.locks.set(key, next);
    return next;
  }

  /** Clones or fetches the project, then adds a worktree for the job at the head of its default branch. */
  async checkout(jobId: string, project: string): Promise<Checkout> {
    if (!this.isAllowed(project)) {
      throw new AnalystError("INVALID_ARGUMENT", `'${project}' cannot be checked out: only projects of ${this.options.groups.join(", ")} can (see repo_list).`);
    }
    const bare = this.bareDir(project);
    const worktree = join(this.jobDir(jobId), project);
    const env = this.options.gitEnv;
    return this.locked(bare, async () => {
      if (!(await this.exists(bare))) {
        await mkdir(join(bare, ".."), { recursive: true });
        await runGit(["clone", "--bare", "--quiet", ...(this.options.partial ? ["--filter=blob:none"] : []), this.options.cloneUrl(project), bare], { env });
      } else {
        await runGit(["--git-dir", bare, "fetch", "--quiet", "--prune", "origin", "+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"], { env });
      }
      const head = (await runGit(["--git-dir", bare, "symbolic-ref", "--short", "HEAD"], { env })).trim();
      if (!(await this.exists(worktree))) {
        await mkdir(join(worktree, ".."), { recursive: true });
        await runGit(["--git-dir", bare, "worktree", "add", "--detach", "--quiet", worktree, head], { env });
      }
      const sha = (await runGit(["rev-parse", "HEAD"], { cwd: worktree, env })).trim();
      return { project, branch: head, sha, path: worktree };
    });
  }

  /** Removes the job's worktrees and directory. */
  async removeJob(jobId: string, checkouts: Checkout[]): Promise<void> {
    for (const c of checkouts) {
      const bare = this.bareDir(c.project);
      await this.locked(bare, () => runGit(["--git-dir", bare, "worktree", "remove", "--force", c.path]).catch(() => undefined));
    }
    await rm(this.jobDir(jobId), { recursive: true, force: true });
    for (const c of checkouts) {
      const bare = this.bareDir(c.project);
      await this.locked(bare, () => runGit(["--git-dir", bare, "worktree", "prune"]).catch(() => undefined));
    }
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }
}
