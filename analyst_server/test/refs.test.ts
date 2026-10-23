import { describe, expect, it } from "vitest";
import { AnalystError } from "../src/errors.js";
import { formatRef, parseRef } from "../src/gitlab/refs.js";

const STAGING = "henixdevelopment/squash/squash-tm/core/squashtest-tm-staging";
const context = { gitlabUrl: "https://gitlab.com", defaultProject: STAGING };

function error(fn: () => unknown): AnalystError {
  try {
    fn();
  } catch (e) {
    if (e instanceof AnalystError) return e;
    throw e;
  }
  throw new Error("no error thrown");
}

describe("parseRef", () => {
  it("reads work item, issue and merge request URLs of the instance", () => {
    expect(parseRef(`https://gitlab.com/${STAGING}/-/work_items/8131`, "work_item", context)).toEqual({ kind: "work_item", path: STAGING, iid: 8131 });
    expect(parseRef(`https://gitlab.com/${STAGING}/-/issues/8131#note_1?x=1`, "work_item", context)).toEqual({ kind: "work_item", path: STAGING, iid: 8131 });
    expect(parseRef(`https://gitlab.com/${STAGING}/-/merge_requests/7341/diffs`, "merge_request", context)).toEqual({ kind: "merge_request", path: STAGING, iid: 7341 });
  });

  it("reads group work item and epic URLs", () => {
    expect(parseRef("https://gitlab.com/groups/henixdevelopment/squash/-/work_items/1071", "work_item", context))
      .toEqual({ kind: "work_item", path: "henixdevelopment/squash", iid: 1071 });
    expect(parseRef("https://gitlab.com/groups/henixdevelopment/squash/-/epics/12", "work_item", context))
      .toEqual({ kind: "work_item", path: "henixdevelopment/squash", iid: 12 });
  });

  it("reads short references, a bare number being of the expected kind in the default project", () => {
    expect(parseRef("#8131", "work_item", context)).toEqual({ kind: "work_item", path: STAGING, iid: 8131 });
    expect(parseRef(" 8131 ", "work_item", context)).toEqual({ kind: "work_item", path: STAGING, iid: 8131 });
    expect(parseRef("7341", "merge_request", context)).toEqual({ kind: "merge_request", path: STAGING, iid: 7341 });
    expect(parseRef("!7341", "merge_request", context)).toEqual({ kind: "merge_request", path: STAGING, iid: 7341 });
    expect(parseRef("a/b#3", "work_item", context)).toEqual({ kind: "work_item", path: "a/b", iid: 3 });
    expect(parseRef("a/b!3", "merge_request", context)).toEqual({ kind: "merge_request", path: "a/b", iid: 3 });
    expect(parseRef("henixdevelopment/squash&1071", "work_item", context)).toEqual({ kind: "work_item", path: "henixdevelopment/squash", iid: 1071 });
  });

  it("refuses URLs of another host and anything that is not a reference", () => {
    expect(error(() => parseRef("https://evil.example/a/b/-/issues/1", "work_item", context)).message).toContain("only https://gitlab.com is served");
    expect(error(() => parseRef("http://gitlab.com/a/b/-/issues/1", "work_item", context)).code).toBe("INVALID_REFERENCE");
    for (const input of ["", "abc", "#0", "#-1", "a b#1", "../x#1", "a/../b#1", "a/b.git#1", "#99999999999", "&12", "https://gitlab.com/a/b/-/pipelines/1"]) {
      expect(error(() => parseRef(input, "work_item", context)).code, input).toBe("INVALID_REFERENCE");
    }
  });

  it("tells which tool to use when the kind does not match", () => {
    expect(error(() => parseRef("!7341", "work_item", context)).message).toContain("use gitlab_merge_request");
    expect(error(() => parseRef(`https://gitlab.com/${STAGING}/-/issues/1`, "merge_request", context)).message).toContain("use gitlab_work_item");
  });
});

describe("formatRef", () => {
  it("omits the default project", () => {
    expect(formatRef({ kind: "work_item", path: STAGING, iid: 1 }, STAGING)).toBe("#1");
    expect(formatRef({ kind: "merge_request", path: STAGING, iid: 2 }, STAGING)).toBe("!2");
    expect(formatRef({ kind: "work_item", path: "henixdevelopment/squash", iid: 3 }, STAGING)).toBe("henixdevelopment/squash#3");
  });
});
