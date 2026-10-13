import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { SessionManager } from "../src/session.js";
import { ConfigurationStore } from "../src/store.js";
import { fakeDeps, minimalFiles, settle, SQUASHTM_DIR, squashtmFiles, testSettings } from "./helpers.js";

let settings: ReturnType<typeof testSettings>;
let fake: ReturnType<typeof fakeDeps>;
let sessions: SessionManager;
let app: FastifyInstance;

const ENV = { MEMORY_AGENT_TOKEN: "agent-secret", MEMORY_URL: "http://memory:9501", SECRET: "not passed on" };

beforeEach(() => {
  settings = testSettings();
  const store = new ConfigurationStore(settings.stateDir, () => ["playwright-cli"]);
  fake = fakeDeps(ENV);
  sessions = new SessionManager(settings, store, fake.deps);
  app = buildApp(store, sessions, () => ["playwright-cli"], undefined);
});

afterEach(async () => {
  await app.close();
  settings.cleanup();
});

const local = { host: "localhost:7681" };

async function call(method: "GET" | "PUT" | "POST" | "DELETE", url: string, payload?: unknown, headers: Record<string, string> = local) {
  const response = await app.inject({ method, url, headers, ...(payload !== undefined && { payload: payload as object }) });
  return { status: response.statusCode, body: response.body ? response.json() : undefined };
}

const asUpload = (files: Map<string, Buffer>) => ({
  files: [...files].map(([path, content]) => ({ path, content: content.toString("base64") })),
});

describe("configurations", () => {
  it("uploads, lists, replaces and deletes", async () => {
    const uploaded = await call("PUT", "/api/configurations/squashtm", asUpload(squashtmFiles()));
    expect(uploaded.status).toBe(200);
    expect(uploaded.body).toMatchObject({
      id: "squashtm",
      name: "SquashTM exploratory testing",
      hostPorts: [8090, 9501],
      tools: { builtin: "default", mcpServers: [{ name: "memory", type: "http", target: "${MEMORY_URL:-http://host.docker.internal:9501}/mcp" }] },
      checks: ["memory server", "memory agent token"],
    });
    expect(uploaded.body.files).toContain("files/knowledge/INSTRUCTIONS.md");
    expect(uploaded.body.files).not.toContain("files/.playwright/cli.config.json");

    await call("PUT", "/api/configurations/other", asUpload(minimalFiles()));
    let list = await call("GET", "/api/configurations");
    expect(list.body.builtinSkills).toEqual(["playwright-cli"]);
    expect(list.body.configurations.map((c: { id: string }) => c.id)).toEqual(["other", "squashtm"]);

    await call("PUT", "/api/configurations/other", asUpload(minimalFiles({ name: "Replaced" })));
    list = await call("GET", "/api/configurations");
    expect(list.body.configurations[0].name).toBe("Replaced");

    expect((await call("DELETE", "/api/configurations/other")).status).toBe(204);
    expect((await call("DELETE", "/api/configurations/other")).status).toBe(404);
    expect((await call("GET", "/api/configurations")).body.configurations).toHaveLength(1);
  });

  it("serves the content of a configuration file", async () => {
    await call("PUT", "/api/configurations/squashtm", asUpload(squashtmFiles()));
    const expected = readFileSync(join(SQUASHTM_DIR, "files/knowledge/INSTRUCTIONS.md"));
    const file = await call("GET", "/api/configurations/squashtm/files/files/knowledge/INSTRUCTIONS.md");
    expect(file.status).toBe(200);
    expect(file.body).toEqual({ path: "files/knowledge/INSTRUCTIONS.md", size: expected.length, content: expected.toString("utf8") });
    expect((await call("GET", "/api/configurations/squashtm/files/config.json")).body.content).toContain("SquashTM");

    expect((await call("GET", "/api/configurations/squashtm/files/nowhere.md")).status).toBe(404);
    expect((await call("GET", "/api/configurations/nowhere/files/config.json")).status).toBe(404);
    expect((await call("GET", "/api/configurations/squashtm/files/files/..%2F..%2Fsquashtm%2Fconfig.json")).status).toBe(400);

    await call("PUT", "/api/configurations/binary", asUpload(minimalFiles({}, { "data.bin": "a\0b" })));
    expect((await call("GET", "/api/configurations/binary/files/data.bin")).body).toEqual({ path: "data.bin", size: 3, content: null });
  });

  it("rejects invalid uploads with the list of problems", async () => {
    const bad = await call("PUT", "/api/configurations/bad", asUpload(minimalFiles({ skills: ["nowhere"], hostPorts: [0] })));
    expect(bad.status).toBe(400);
    expect(bad.body.problems.length).toBeGreaterThan(0);
    expect((await call("PUT", "/api/configurations/a%20b", asUpload(minimalFiles()))).status).toBe(400);
    const escaping = { files: [{ path: "../x", content: "" }, ...asUpload(minimalFiles()).files] };
    expect((await call("PUT", "/api/configurations/c", escaping)).status).toBe(400);
    expect((await call("GET", "/api/configurations")).body.configurations).toEqual([]);
  });
});

describe("requests", () => {
  it("are accepted only from a local host name and same-origin pages", async () => {
    expect((await call("GET", "/api/session", undefined, { host: "127.0.0.1:7681" })).status).toBe(200);
    expect((await call("GET", "/api/session", undefined, { host: "evil.example.com:7681" })).status).toBe(403);
    expect((await call("GET", "/api/session", undefined, { host: "localhost:7681", origin: "http://evil.example.com" })).status).toBe(403);
    expect((await call("GET", "/api/session", undefined, { host: "localhost:7681", origin: "http://localhost:7681" })).status).toBe(200);
  });
});

describe("session", () => {
  beforeEach(async () => {
    await call("PUT", "/api/configurations/squashtm", asUpload(squashtmFiles()));
  });

  it("opens the firewall, runs the checks, prepares the workspace and starts Claude Code", async () => {
    const started = await call("POST", "/api/session", { configuration: "squashtm", cols: 100, rows: 30 });
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ status: "running", configuration: "squashtm", session: "session_01" });

    expect(fake.calls.firewall).toEqual([{ domains: ["tm-en.doc.squashtest.com", "tm-fr.doc.squashtest.com"], hostPorts: [8090, 9501] }]);
    expect(fake.calls.gets).toEqual([
      { url: "http://memory:9501/health", headers: {} },
      { url: "http://memory:9501/api/stores", headers: { Authorization: "Bearer agent-secret" } },
    ]);
    expect(existsSync(join(settings.workspaceDir, "session_01"))).toBe(true);
    expect(existsSync(join(settings.workspaceDir, ".claude", "skills", "get-logs", "SKILL.md"))).toBe(true);
    expect(existsSync(join(settings.workspaceDir, ".playwright", "cli.config.json"))).toBe(true);

    const [spawned] = fake.calls.spawned;
    expect(spawned).toMatchObject({ cwd: settings.workspaceDir, cols: 100, rows: 30 });
    expect(spawned!.args[spawned!.args.indexOf("--append-system-prompt") + 1]).toMatch(/^You are in charge to perform some Exploratory Testing/);
    expect(spawned!.env).toMatchObject({
      MEMORY_SESSION: "session_01",
      MEMORY_AGENT_TOKEN: "agent-secret",
      MEMORY_URL: "http://memory:9501",
      HOME: "/home/node",
      CLAUDE_CONFIG_DIR: "/home/node/.claude",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
    expect(spawned!.env.SECRET).toBeUndefined();
    const mcp = JSON.parse(readFileSync(join(settings.runDir, "mcp.json"), "utf8"));
    expect(mcp.mcpServers.memory.headers["X-Memory-Session"]).toBe("${MEMORY_SESSION:-}");

    // Only one session at a time; its configuration cannot be deleted.
    expect((await call("POST", "/api/session", { configuration: "squashtm" })).status).toBe(409);
    expect((await call("DELETE", "/api/configurations/squashtm")).status).toBe(409);

    // Claude Code exits: the firewall goes back to the base allowlist, the next session gets the next number.
    fake.ptys[0]!.exit(0);
    await settle();
    expect((await call("GET", "/api/session")).body).toMatchObject({ status: "idle", session: "session_01", exitCode: 0 });
    expect(fake.calls.firewall.at(-1)).toEqual({ domains: [], hostPorts: [] });
    expect((await call("POST", "/api/session", { configuration: "squashtm" })).body.session).toBe("session_02");
  });

  it("does not start when a check fails, and closes the firewall again", async () => {
    fake.setStatus(401);
    const started = await call("POST", "/api/session", { configuration: "squashtm" });
    expect(started.status).toBe(412);
    expect(started.body.error).toContain("check 'memory server' failed");
    expect(fake.calls.spawned).toEqual([]);
    expect(fake.calls.firewall.at(-1)).toEqual({ domains: [], hostPorts: [] });
    expect(existsSync(join(settings.workspaceDir, "session_01"))).toBe(false);
    expect((await call("GET", "/api/session")).body).toMatchObject({ status: "idle", error: expect.stringContaining("memory server") });
  });

  it("stops", async () => {
    expect((await call("DELETE", "/api/session")).status).toBe(409);
    await call("POST", "/api/session", { configuration: "squashtm" });
    expect((await call("DELETE", "/api/session")).status).toBe(200);
    expect(fake.ptys[0]!.killed).toBe("SIGHUP");
    await settle();
    expect(sessions.getState().status).toBe("idle");
  });

  it("rejects an unknown configuration", async () => {
    expect((await call("POST", "/api/session", { configuration: "nope" })).status).toBe(404);
  });
});

describe("terminal", () => {
  it("replays the scrollback, streams the output and forwards input and resizes", async () => {
    await call("PUT", "/api/configurations/squashtm", asUpload(squashtmFiles()));
    await call("POST", "/api/session", { configuration: "squashtm" });
    fake.ptys[0]!.emit("hello ");

    await app.ready();
    const messages: Array<{ type: string; data?: string; state?: { status: string } }> = [];
    const ws = await app.injectWS("/api/terminal", { headers: local }, {
      onInit: (socket) => socket.on("message", (raw: Buffer) => messages.push(JSON.parse(raw.toString()))),
    });
    await settle();
    expect(messages[0]).toMatchObject({ type: "state", state: { status: "running" } });
    expect(messages[1]!.type).toBe("output");
    expect(messages[1]!.data).toContain("== Session session_01");
    expect(messages[1]!.data!.endsWith("hello ")).toBe(true);

    fake.ptys[0]!.emit("world");
    ws.send(JSON.stringify({ type: "input", data: "/login\r" }));
    ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
    ws.send("not json");
    await settle();
    expect(messages.at(-1)).toEqual({ type: "output", data: "world" });
    expect(fake.ptys[0]!.written).toEqual(["/login\r"]);
    expect(fake.ptys[0]!.sizes).toEqual([[80, 24]]);
    ws.terminate();
  });
});
