import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pty, SessionDeps } from "../src/session.js";
import type { Settings } from "../src/settings.js";
import { listFiles } from "../src/store.js";

/** The configuration shipped in the repository. */
export const SQUASHTM_DIR = fileURLToPath(new URL("../../configurations/squashtm", import.meta.url));

export function readFolder(dir: string): Map<string, Buffer> {
  return new Map(listFiles(dir).map((path) => [path, readFileSync(join(dir, path))]));
}

export function squashtmFiles(): Map<string, Buffer> {
  return readFolder(SQUASHTM_DIR);
}

/** A minimal valid configuration, with `config.json` fields overridden. */
export function minimalFiles(config: Record<string, unknown> = {}, extra: Record<string, string> = {}): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  files.set("config.json", Buffer.from(JSON.stringify({ name: "Minimal", systemPrompt: "prompt.md", tools: { builtin: "default" }, ...config })));
  files.set("prompt.md", Buffer.from("Be nice.\n"));
  for (const [path, content] of Object.entries(extra)) files.set(path, Buffer.from(content));
  return files;
}

/** Temporary directories laid out like the container; the built-in skill playwright-cli is installed. */
export function testSettings(): Settings & { cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "etik-"));
  // What `playwright-cli install --skills` produces in the image.
  const builtinDir = join(root, "builtin");
  const playwright = join(builtinDir, "playwright-cli");
  mkdirSync(join(playwright, ".claude", "skills", "playwright-cli"), { recursive: true });
  writeFileSync(join(playwright, ".claude", "skills", "playwright-cli", "SKILL.md"), "---\nname: playwright-cli\n---\n");
  mkdirSync(join(playwright, ".playwright"));
  writeFileSync(join(playwright, ".playwright", "cli.config.json"), JSON.stringify({ browser: { browserName: "chromium" } }));
  return {
    host: "127.0.0.1",
    port: 0,
    stateDir: join(root, "state"),
    workspaceDir: join(root, "workspace"),
    runDir: join(root, "run"),
    builtinDir,
    firewallScript: "/bin/false",
    agentUser: "node",
    agentHome: "/home/node",
    claudeCommand: "claude",
    webRoot: undefined,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export class FakePty implements Pty {
  readonly written: string[] = [];
  readonly sizes: Array<[number, number]> = [];
  killed: string | undefined;
  private dataListener: (data: string) => void = () => {};
  private exitListener: (event: { exitCode: number }) => void = () => {};

  onData(listener: (data: string) => void) { this.dataListener = listener; }
  onExit(listener: (event: { exitCode: number }) => void) { this.exitListener = listener; }
  write(data: string) { this.written.push(data); }
  resize(cols: number, rows: number) { this.sizes.push([cols, rows]); }
  kill(signal?: string) {
    this.killed = signal;
    this.exit(129);
  }

  emit(data: string) { this.dataListener(data); }
  exit(exitCode: number) { this.exitListener({ exitCode }); }
}

/** Dependencies that record what the session does instead of doing it. */
export function fakeDeps(env: NodeJS.ProcessEnv = {}) {
  const calls = {
    firewall: [] as Array<{ domains: string[]; hostPorts: number[] }>,
    spawned: [] as Array<{ args: string[]; cwd: string; env: Record<string, string>; cols: number; rows: number }>,
    gets: [] as Array<{ url: string; headers: Record<string, string> }>,
    kills: 0,
  };
  const ptys: FakePty[] = [];
  let status = 200;
  const deps: SessionDeps = {
    spawnClaude: (args, options) => {
      calls.spawned.push({ args, ...options });
      const pty = new FakePty();
      ptys.push(pty);
      return pty;
    },
    applyFirewall: async (domains, hostPorts) => {
      calls.firewall.push({ domains, hostPorts });
      return "== Egress allowlist applied ==\n";
    },
    killAgentProcesses: async () => { calls.kills++; },
    httpGet: async (url, headers) => {
      calls.gets.push({ url, headers });
      return status;
    },
    owner: undefined,
    env: { PATH: "/usr/bin:/bin", ...env },
  };
  return { deps, calls, ptys, setStatus: (s: number) => { status = s; } };
}

/** Lets the promise callbacks run (the end of a session is asynchronous). */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
