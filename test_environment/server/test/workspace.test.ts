import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigurationStore } from "../src/store.js";
import { builtinSkills, claudeArguments, expandVariables, nextSessionName, prepareWorkspace } from "../src/workspace.js";
import { minimalFiles, sampleFiles, testSettings } from "./helpers.js";

let settings: ReturnType<typeof testSettings>;
let store: ConfigurationStore;

beforeEach(() => {
  settings = testSettings();
  store = new ConfigurationStore(settings.stateDir);
});

afterEach(() => settings.cleanup());

describe("nextSessionName", () => {
  it("follows the highest session number", () => {
    expect(nextSessionName(settings.workspaceDir)).toBe("session_01");
    for (const dir of ["session_01", "session_09", "session_x", "other"]) mkdirSync(join(settings.workspaceDir, dir), { recursive: true });
    writeFileSync(join(settings.workspaceDir, "session_50"), "a file, not a session");
    expect(nextSessionName(settings.workspaceDir)).toBe("session_10");
    mkdirSync(join(settings.workspaceDir, "session_123"));
    expect(nextSessionName(settings.workspaceDir)).toBe("session_124");
  });
});

describe("prepareWorkspace", () => {
  it("creates the session directory, installs the built-in and configuration skills and copies files/", () => {
    const configuration = store.save("sample", sampleFiles());
    const skills = join(settings.workspaceDir, ".claude", "skills");
    mkdirSync(join(skills, "stale"), { recursive: true });
    mkdirSync(join(settings.workspaceDir, ".playwright"), { recursive: true });
    writeFileSync(join(settings.workspaceDir, ".playwright", "cli.config.json"), "{\"edited\": true}");

    prepareWorkspace(settings.workspaceDir, configuration, settings.builtinDir, "session_01", undefined);

    expect(existsSync(join(settings.workspaceDir, "session_01"))).toBe(true);
    expect(existsSync(join(skills, "stale"))).toBe(false);
    expect(existsSync(join(skills, "playwright-cli", "SKILL.md"))).toBe(true);
    expect(existsSync(join(skills, "playwright-cli", ".claude"))).toBe(false);
    expect(existsSync(join(skills, "local-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(skills, "local-skill", "scripts", "run.mjs"))).toBe(true);
    expect(existsSync(join(settings.workspaceDir, "notes", "README.md"))).toBe(true);
    // From the built-in skill playwright-cli, over the file left by a previous session.
    expect(JSON.parse(readFileSync(join(settings.workspaceDir, ".playwright", "cli.config.json"), "utf8")).browser.browserName).toBe("chromium");
    // The system prompt and config.json are not copied into the workspace.
    expect(existsSync(join(settings.workspaceDir, "system-prompt.md"))).toBe(false);
    expect(existsSync(join(settings.workspaceDir, "config.json"))).toBe(false);
  });

  it("lets files/ override the files of a built-in skill", () => {
    const configuration = store.save("c", minimalFiles({}, { "files/.playwright/cli.config.json": "{\"mine\": true}" }));
    prepareWorkspace(settings.workspaceDir, configuration, settings.builtinDir, "session_01", undefined);
    expect(readFileSync(join(settings.workspaceDir, ".playwright", "cli.config.json"), "utf8")).toBe("{\"mine\": true}");
  });

  it("installs the built-in skills when the configuration has none", () => {
    const configuration = store.save("c", minimalFiles());
    prepareWorkspace(settings.workspaceDir, configuration, settings.builtinDir, "session_01", undefined);
    expect(readdirSync(join(settings.workspaceDir, ".claude", "skills"))).toEqual(["playwright-cli"]);
    expect(existsSync(join(settings.workspaceDir, ".playwright", "cli.config.json"))).toBe(true);
  });

  it("prefers an uploaded skill to a built-in one of the same name, without the built-in files", () => {
    const configuration = store.save("c", minimalFiles({}, { "skills/playwright-cli/SKILL.md": "uploaded" }));
    prepareWorkspace(settings.workspaceDir, configuration, settings.builtinDir, "session_01", undefined);
    expect(readFileSync(join(settings.workspaceDir, ".claude", "skills", "playwright-cli", "SKILL.md"), "utf8")).toBe("uploaded");
    expect(existsSync(join(settings.workspaceDir, ".playwright"))).toBe(false);
  });
});

describe("builtinSkills", () => {
  it("lists the installed skills", () => {
    mkdirSync(join(settings.builtinDir, "not-a-skill"));
    expect(builtinSkills(settings.builtinDir)).toEqual(["playwright-cli"]);
    expect(builtinSkills(join(settings.builtinDir, "missing"))).toEqual([]);
  });
});

describe("expandVariables", () => {
  it("expands like Claude Code does in .mcp.json", () => {
    const env = { A: "a", EMPTY: "" };
    expect(expandVariables("${A}/${B:-http://x:1}/${EMPTY:-d}/${C}/$A", env)).toBe("a/http://x:1/d//$A");
  });
});

describe("claudeArguments", () => {
  it("runs in YOLO mode with the configuration's prompt, tools and MCP servers only", () => {
    const configuration = store.save("c", minimalFiles({ tools: { builtin: ["Bash", "Read"] } }));
    expect(claudeArguments(configuration, "Be nice.", "/run/etik/mcp.json")).toEqual([
      "--dangerously-skip-permissions",
      "--append-system-prompt", "Be nice.",
      "--tools", "Bash,Read",
      "--mcp-config", "/run/etik/mcp.json",
      "--strict-mcp-config",
    ]);
    const all = store.save("d", minimalFiles());
    expect(claudeArguments(all, "p", "m")).toContain("default");
  });
});
