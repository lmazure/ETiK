/**
 * Runs one analysis with the Claude Agent SDK: an agent restricted to Read, Grep and Glob inside the job's directory
 * and to the analyst's own tools, with a minimal environment holding only its subscription token.
 */
import { query, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { AnalystError } from "../errors.js";
import { BUILTIN_TOOLS, denyOthers, MCP_SERVER_NAME, pathGuard } from "./permissions.js";

export interface RunRequest {
  systemPrompt: string;
  prompt: string;
  /** The job's directory: the agent's working directory, and the only place it may read. */
  jobDir: string;
  tools: McpSdkServerConfigWithInstance;
  signal: AbortSignal;
  /** Called with a short description of each step of the agent. */
  onStep: (step: string) => void;
}

export interface RunResult {
  text: string;
  turns: number;
}

export interface Runner {
  readonly model: string;
  run(request: RunRequest): Promise<RunResult>;
}

export interface AgentSdkOptions {
  model: string;
  oauthToken: string;
  maxTurns?: number;
}

/** A short description of a tool call: its name and its main argument. */
export function describeStep(name: string, input: Record<string, unknown>): string {
  const tool = name.replace(`mcp__${MCP_SERVER_NAME}__`, "");
  const main = ["ref", "project", "file_path", "pattern", "path", "query", "rev"].map((k) => input[k]).find((v) => typeof v === "string") as string | undefined;
  return main ? `${tool} ${main.length > 80 ? `${main.slice(0, 80)}…` : main}` : tool;
}

export class AgentSdkRunner implements Runner {
  constructor(private readonly options: AgentSdkOptions) {}

  get model(): string {
    return this.options.model;
  }

  async run(request: RunRequest): Promise<RunResult> {
    const abortController = new AbortController();
    const abort = () => abortController.abort(request.signal.reason);
    request.signal.addEventListener("abort", abort, { once: true });
    const stderr: string[] = [];
    try {
      const messages = query({
        prompt: request.prompt,
        options: {
          model: this.options.model,
          cwd: request.jobDir,
          systemPrompt: request.systemPrompt,
          tools: BUILTIN_TOOLS,
          disallowedTools: ["Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch", "Task", "Agent", "Skill"],
          mcpServers: { [MCP_SERVER_NAME]: request.tools },
          hooks: { PreToolUse: [{ hooks: [pathGuard(request.jobDir)] }] },
          canUseTool: denyOthers,
          permissionMode: "default",
          settingSources: [],
          maxTurns: this.options.maxTurns ?? 200,
          abortController,
          env: {
            PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
            HOME: process.env.HOME ?? "/tmp",
            CLAUDE_CODE_OAUTH_TOKEN: this.options.oauthToken,
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
            DISABLE_AUTOUPDATER: "1",
            CLAUDE_AGENT_SDK_CLIENT_APP: "etik-analyst/0.1.0",
          },
          stderr: (data) => stderr.push(data),
        },
      });
      for await (const message of messages) {
        if (message.type === "assistant") {
          for (const block of message.message.content) {
            if (block.type === "tool_use") request.onStep(describeStep(block.name, (block.input ?? {}) as Record<string, unknown>));
          }
          if (message.error) request.onStep(`error: ${message.error}`);
        } else if (message.type === "result") {
          if (message.subtype === "success" && !message.is_error) return { text: message.result, turns: message.num_turns };
          throw new AnalystError("ANALYSIS_FAILED", message.subtype === "success"
            ? `the agent failed: ${message.result.slice(0, 300)}`
            : `the agent stopped (${message.subtype}).`);
        }
      }
      throw new AnalystError("ANALYSIS_FAILED", `the agent ended without a result${stderr.length ? `: ${stderr.join("").trim().split("\n").slice(-3).join(" ")}` : ""}.`);
    } finally {
      request.signal.removeEventListener("abort", abort);
    }
  }
}
