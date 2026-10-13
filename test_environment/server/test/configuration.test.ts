import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigurationError, relativePath, validateConfiguration } from "../src/configuration.js";
import { CONFIGURATIONS_DIR, minimalFiles, readFolder, sampleFiles } from "./helpers.js";

function problems(run: () => unknown): string[] {
  try {
    run();
  } catch (error) {
    if (error instanceof ConfigurationError) return error.problems;
    throw error;
  }
  throw new Error("no ConfigurationError");
}

describe("validateConfiguration", () => {
  it("accepts the sample configuration", () => {
    const config = validateConfiguration(sampleFiles(), ["playwright-cli"]);
    expect(config.domains).toEqual(["docs.example.com"]);
    expect(config.hostPorts).toEqual([8080, 9501]);
    expect(config.tools.builtin).toBe("default");
    expect(Object.keys(config.tools.mcpServers)).toEqual(["memory"]);
    expect(config.skills).toEqual(["local-skill"]);
  });

  it("accepts every configuration of the repository", () => {
    const folders = readdirSync(CONFIGURATIONS_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    expect(folders.length).toBeGreaterThan(0);
    for (const folder of folders) {
      expect(() => validateConfiguration(readFolder(join(CONFIGURATIONS_DIR, folder.name)), ["playwright-cli"]), folder.name).not.toThrow();
    }
  });

  it("applies the defaults", () => {
    const config = validateConfiguration(minimalFiles(), []);
    expect(config).toMatchObject({ domains: [], hostPorts: [], skills: [], env: [], checks: [], tools: { builtin: "default", mcpServers: {} } });
  });

  it("accepts a list of built-in tools, even empty", () => {
    expect(validateConfiguration(minimalFiles({ tools: { builtin: ["Bash", "Read"] } }), []).tools.builtin).toEqual(["Bash", "Read"]);
    expect(validateConfiguration(minimalFiles({ tools: { builtin: [] } }), []).tools.builtin).toEqual([]);
  });

  it("requires config.json, valid JSON and the system prompt file", () => {
    const noConfig = minimalFiles();
    noConfig.delete("config.json");
    expect(problems(() => validateConfiguration(noConfig, []))).toEqual(["config.json is missing"]);

    const badJson = minimalFiles();
    badJson.set("config.json", Buffer.from("{"));
    expect(problems(() => validateConfiguration(badJson, []))[0]).toMatch(/^config.json is not valid JSON/);

    expect(problems(() => validateConfiguration(minimalFiles({ systemPrompt: "missing.md" }), [])))
      .toEqual(["the system prompt file 'missing.md' is missing"]);
    expect(problems(() => validateConfiguration(minimalFiles({ systemPrompt: "../etc/passwd" }), [])))
      .toEqual(["config.json: systemPrompt: invalid path '../etc/passwd'"]);
  });

  it("rejects bad domains, ports, tools, unknown fields", () => {
    const found = problems(() => validateConfiguration(minimalFiles({
      domains: ["ok.example.com", "http://bad.example.com", "-bad"],
      hostPorts: [0, 70000, 8.5],
      tools: { builtin: ["Bash(git *)"] },
      extra: true,
    }), []));
    expect(found.join("\n")).toContain("domains.1");
    expect(found.join("\n")).toContain("domains.2");
    expect(found.join("\n")).toContain("hostPorts.0");
    expect(found.join("\n")).toContain("hostPorts.1");
    expect(found.join("\n")).toContain("hostPorts.2");
    expect(found.join("\n")).toContain("tools.builtin");
    expect(found.join("\n")).toContain("extra");
  });

  it("requires the skills in the configuration and rejects listing a built-in one", () => {
    const files = minimalFiles({ skills: ["mine", "playwright-cli", "nowhere"] }, { "skills/mine/SKILL.md": "x" });
    expect(problems(() => validateConfiguration(files, ["playwright-cli"]))).toEqual([
      "skill 'playwright-cli': built into the image, always installed, remove it from skills",
      "skill 'nowhere': skills/nowhere/SKILL.md is missing",
    ]);
    const replaced = minimalFiles({ skills: ["playwright-cli"] }, { "skills/playwright-cli/SKILL.md": "x" });
    expect(validateConfiguration(replaced, ["playwright-cli"]).skills).toEqual(["playwright-cli"]);
  });
});

describe("relativePath", () => {
  it("normalizes", () => {
    expect(relativePath("files/./knowledge/INSTRUCTIONS.md")).toBe("files/knowledge/INSTRUCTIONS.md");
    expect(relativePath("skills\\get-logs\\SKILL.md")).toBe("skills/get-logs/SKILL.md");
    expect(relativePath("files/.playwright/cli.config.json")).toBe("files/.playwright/cli.config.json");
    expect(relativePath("a//b")).toBe("a/b");
  });

  it("rejects paths escaping the folder", () => {
    for (const path of ["", "/etc/passwd", "../x", "a/../../x", ".", "a/\0"]) {
      expect(() => relativePath(path), path).toThrow(ConfigurationError);
    }
  });
});
