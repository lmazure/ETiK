import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Settings } from "./settings.js";
import type { ConfigurationStore } from "./store.js";
import { claudeArguments, expandVariables, nextSessionName, type Owner, prepareWorkspace } from "./workspace.js";

/** The subset of node-pty's IPty the session uses. */
export interface Pty {
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface SessionDeps {
  /** Starts `claude` with these arguments and environment, as the agent user, in a pseudo-terminal. */
  spawnClaude(args: string[], options: { cwd: string; env: Record<string, string>; cols: number; rows: number }): Pty;
  /** Runs init-firewall.sh with these domains and host ports (none: the base allowlist); returns its output. */
  applyFirewall(domains: string[], hostPorts: number[]): Promise<string>;
  /** Kills every process of the agent user (e.g. the browser playwright-cli left running). */
  killAgentProcesses(): Promise<void>;
  /** HTTP GET; returns the status. */
  httpGet(url: string, headers: Record<string, string>): Promise<number>;
  /** Owner of the files written in the workspace; undefined when not running as root. */
  owner: Owner | undefined;
  /** Environment of the container, source of the `env` and `checks` variables. */
  env: NodeJS.ProcessEnv;
}

export type SessionStatus = "idle" | "starting" | "running" | "stopping";

export interface SessionState {
  status: SessionStatus;
  /** Configuration of the current, or else the last, session. */
  configuration?: string;
  /** Name of the current, or else the last, session directory. */
  session?: string;
  startedAt?: string;
  /** Why the last start failed. */
  error?: string;
  /** Exit code of the last Claude Code run. */
  exitCode?: number;
}

export class SessionError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

/** Terminal output kept for the browsers that (re)connect. */
const SCROLLBACK_CHARS = 1024 * 1024;

/** One session at a time: Claude Code in a pseudo-terminal, behind the firewall of its configuration. */
export class SessionManager {
  private state: SessionState = { status: "idle" };
  private pty: Pty | undefined;
  private scrollback: string[] = [];
  private scrollbackChars = 0;
  private readonly outputListeners = new Set<(data: string) => void>();
  private readonly stateListeners = new Set<(state: SessionState) => void>();

  constructor(
    private readonly settings: Settings,
    private readonly store: ConfigurationStore,
    private readonly deps: SessionDeps,
  ) {}

  getState(): SessionState {
    return { ...this.state };
  }

  getScrollback(): string {
    return this.scrollback.join("");
  }

  onOutput(listener: (data: string) => void): () => void {
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  }

  onState(listener: (state: SessionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** Starts a session; the progress is written to the terminal. Rejects with a SessionError if it cannot start. */
  async start(configurationId: string, cols = 120, rows = 40): Promise<SessionState> {
    if (this.state.status !== "idle") throw new SessionError(409, `a session is already ${this.state.status}`);
    const configuration = this.store.get(configurationId);
    const { config } = configuration;
    this.scrollback = [];
    this.scrollbackChars = 0;
    this.setState({ status: "starting", configuration: configuration.id });
    this.print(`\x1b[1m== Configuration ${configuration.id}: ${config.name}\x1b[0m`);
    let firewallOpened = false;
    try {
      await this.deps.killAgentProcesses();

      this.print(`\x1b[1m== Firewall\x1b[0m`);
      firewallOpened = true;
      this.print(await this.deps.applyFirewall(config.domains, config.hostPorts));

      if (config.checks.length > 0) this.print(`\x1b[1m== Checks\x1b[0m`);
      for (const check of config.checks) {
        const url = expandVariables(check.url, this.deps.env);
        const headers = Object.fromEntries(Object.entries(check.headers).map(([k, v]) => [k, expandVariables(v, this.deps.env)]));
        let status: number | string;
        try {
          status = await this.deps.httpGet(url, headers);
        } catch (error) {
          status = (error as Error).message;
        }
        if (typeof status !== "number" || status < 200 || status >= 300) {
          throw new SessionError(412, `check '${check.name}' failed: GET ${url} -> ${status}`);
        }
        this.print(`OK: ${check.name}`);
      }

      const session = nextSessionName(this.settings.workspaceDir);
      prepareWorkspace(this.settings.workspaceDir, configuration, this.settings.builtinSkillsDir, session, this.deps.owner);
      mkdirSync(this.settings.runDir, { recursive: true, mode: 0o755 });
      const mcpConfigFile = join(this.settings.runDir, "mcp.json");
      writeFileSync(mcpConfigFile, JSON.stringify({ mcpServers: config.tools.mcpServers }, null, 2), { mode: 0o644 });
      const systemPrompt = readFileSync(join(configuration.dir, config.systemPrompt), "utf8");

      const env: Record<string, string> = {
        PATH: this.deps.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: this.settings.agentHome,
        USER: this.settings.agentUser,
        LOGNAME: this.settings.agentUser,
        LANG: this.deps.env.LANG ?? "C.UTF-8",
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        CLAUDE_CONFIG_DIR: join(this.settings.agentHome, ".claude"),
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        // The session name; the name comes from the memory server, which records it with each change.
        MEMORY_SESSION: session,
      };
      if (this.deps.env.PLAYWRIGHT_BROWSERS_PATH) env.PLAYWRIGHT_BROWSERS_PATH = this.deps.env.PLAYWRIGHT_BROWSERS_PATH;
      for (const name of config.env) {
        const value = this.deps.env[name];
        if (value !== undefined) env[name] = value;
      }

      this.print(`\x1b[1m== Session ${session}\x1b[0m\r\n`);
      const pty = this.deps.spawnClaude(claudeArguments(configuration, systemPrompt, mcpConfigFile), {
        cwd: this.settings.workspaceDir, env, cols, rows,
      });
      this.pty = pty;
      pty.onData((data) => this.output(data));
      pty.onExit(({ exitCode }) => void this.ended(pty, exitCode));
      this.setState({ status: "running", configuration: configuration.id, session, startedAt: new Date().toISOString() });
      return this.getState();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.print(`\x1b[31mERROR: ${message}\x1b[0m`);
      if (firewallOpened) await this.resetFirewall();
      this.setState({ status: "idle", configuration: configuration.id, error: message });
      throw error instanceof SessionError ? error : new SessionError(500, message);
    }
  }

  /** Stops the running session: Claude Code is killed, the end is handled like a normal exit. */
  stop(): void {
    if (this.state.status !== "running" || !this.pty) throw new SessionError(409, "no session is running");
    this.setState({ ...this.state, status: "stopping" });
    this.pty.kill("SIGHUP");
  }

  write(data: string): void {
    if (this.state.status === "running") this.pty?.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.state.status === "running" || this.state.status === "stopping") {
      try {
        this.pty?.resize(cols, rows);
      } catch {
        // the process has just exited
      }
    }
  }

  /** At shutdown of the console. */
  async close(): Promise<void> {
    if (this.pty && (this.state.status === "running" || this.state.status === "stopping")) this.pty.kill("SIGKILL");
    await this.deps.killAgentProcesses();
  }

  private async ended(pty: Pty, exitCode: number): Promise<void> {
    if (pty !== this.pty) return;
    this.pty = undefined;
    this.setState({ ...this.state, status: "stopping", exitCode });
    this.print(`\r\n\x1b[1m== Claude Code exited (code ${exitCode})\x1b[0m`);
    await this.deps.killAgentProcesses();
    await this.resetFirewall();
    this.setState({ ...this.state, status: "idle" });
  }

  private async resetFirewall(): Promise<void> {
    try {
      await this.deps.applyFirewall([], []);
      this.print("Firewall back to the base allowlist.");
    } catch (error) {
      this.print(`\x1b[31mERROR: could not reset the firewall: ${(error as Error).message}\x1b[0m`);
    }
  }

  private setState(state: SessionState): void {
    this.state = state;
    for (const listener of this.stateListeners) listener(this.getState());
  }

  /** Writes console messages to the terminal (lines end with CRLF for xterm). */
  private print(text: string): void {
    const lines = text.replace(/\r?\n$/, "").split(/\r?\n/);
    this.output(lines.map((line) => `${line}\r\n`).join(""));
  }

  private output(data: string): void {
    this.scrollback.push(data);
    this.scrollbackChars += data.length;
    while (this.scrollbackChars > SCROLLBACK_CHARS && this.scrollback.length > 1) {
      this.scrollbackChars -= this.scrollback.shift()!.length;
    }
    for (const listener of this.outputListeners) listener(data);
  }
}
