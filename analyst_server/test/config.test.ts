import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { tokenProblem } from "../src/gitlab/client.js";

describe("loadConfig", () => {
  it("has defaults for everything but the tokens", () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      port: 9502,
      analystToken: undefined,
      gitlabToken: undefined,
      gitlabUrl: "https://gitlab.com",
      defaultProject: "henixdevelopment/squash/squash-tm/core/squashtest-tm-staging",
      searchGroup: "henixdevelopment/squash",
      mcpMaxOutputChars: 40_000,
    });
  });

  it("reads the environment", () => {
    const config = loadConfig({
      PORT: "9600", ANALYST_TOKEN: "a", GITLAB_READ_TOKEN: "g", GITLAB_URL: "https://gitlab.example.org/",
      GITLAB_DEFAULT_PROJECT: "x/y", GITLAB_SEARCH_GROUP: "x", ANALYST_MCP_MAX_OUTPUT_CHARS: "1000",
    });
    expect(config).toMatchObject({
      port: 9600, analystToken: "a", gitlabToken: "g", gitlabUrl: "https://gitlab.example.org", defaultProject: "x/y", searchGroup: "x", mcpMaxOutputChars: 1000,
    });
  });

  it("refuses a GitLab URL with a path and a bad number", () => {
    expect(() => loadConfig({ GITLAB_URL: "https://gitlab.com/api" })).toThrow(/origin/);
    expect(() => loadConfig({ GITLAB_URL: "gitlab.com" })).toThrow(/GITLAB_URL/);
    expect(() => loadConfig({ PORT: "x" })).toThrow(/PORT/);
  });
});

describe("tokenProblem", () => {
  const token = { name: "etik", active: true, revoked: false, expires_at: null };

  it("accepts read-only scopes", () => {
    expect(tokenProblem({ ...token, scopes: ["read_api", "read_repository"] })).toBeUndefined();
  });

  it("refuses a token that can write, or is not active", () => {
    expect(tokenProblem({ ...token, scopes: ["read_api", "api"] })).toContain("has the scope(s) api");
    expect(tokenProblem({ ...token, scopes: ["write_repository"] })).toContain("write_repository");
    expect(tokenProblem({ ...token, active: false, scopes: ["read_api"] })).toContain("not active");
  });
});
