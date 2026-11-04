// Run with: node --test .claude/skills/gitlab-publish/scripts/
import assert from "node:assert/strict";
import { test } from "node:test";
import { findReferences, formatReferences, parseRelated } from "./gitlab-publish.mjs";

const PROJECT = "henixdevelopment/squash/squash-tm/core/squashtest-tm-staging";
const refs = (text) => findReferences(text).map(({ category, ref, line }) => `${line} ${category} ${ref}`);

test("finds issues, merge requests, epics and snippets", () => {
  assert.deepEqual(refs("See #7011, !7394, &12 and $5."), [
    "1 item #7011", "1 item !7394", "1 item &12", "1 item $5",
  ]);
});

test("finds items of another project, with or without the group", () => {
  assert.deepEqual(refs("group/sub/project#464 and squash-tm-api-rest#464 and group/project!3"), [
    "1 item group/sub/project#464", "1 item squash-tm-api-rest#464", "1 item group/project!3",
  ]);
});

test("finds mentions, but not e-mail addresses", () => {
  assert.deepEqual(refs("Ask @jdoe or @team/sub. Mail jdoe@example.com"), [
    "1 mention @jdoe", "1 mention @team/sub",
  ]);
});

test("finds labels, milestones and iterations", () => {
  assert.deepEqual(refs('~bug ~"Type::Bug" %17.0 %"Release 17" *iteration:42 around ~200 ms'), [
    "1 label ~bug", '1 label ~"Type::Bug"', "1 label %17.0", '1 label %"Release 17"', "1 label *iteration:42", "1 label ~200",
  ]);
});

test("ignores look-alikes", () => {
  assert.deepEqual(refs("50% done, a!=b, &#39; entity, C# code, 3$ price, 100%"), []);
});

test("reports a word glued to #N, which GitLab may read as an issue of a project of the same group", () => {
  assert.deepEqual(refs("x#1"), ["1 item x#1"]);
});

test("ignores fenced code, indented fences, inline code and HTML comments", () => {
  const text = [
    "```java",
    "@PreAuthorize #1",
    "```",
    "1. item",
    "   ```",
    "   @Id !2",
    "   ```",
    "Inline `@CheckBlockingMilestone #3` and ``a ` @b`` code",
    "<!-- @hidden #4 -->",
    "<!-- multi",
    "@hidden #5",
    "-->",
    "~~~",
    "#6",
    "~~~",
    "visible #7",
  ].join("\n");
  assert.deepEqual(refs(text), ["16 item #7"]);
});

test("reports item URLs of gitlab.com, but not the text of their links", () => {
  const text = [
    `[squash-tm-api-rest#464](https://gitlab.com/group/api/squash-tm-api-rest/-/work_items/464)`,
    `https://gitlab.com/${PROJECT}/-/work_items/7011#note_1 and <https://gitlab.com/${PROJECT}/-/merge_requests/7394>`,
    "![shot](shot.png) [doc](https://docs.gitlab.com/user/markdown/#gitlab-specific-references)",
  ].join("\n");
  assert.deepEqual(refs(text), [
    "1 item group/api/squash-tm-api-rest#464 (URL)", "2 item #7011 (URL)", "2 item !7394 (URL)",
  ]);
});

test("finds task boxes, tables of contents and quick actions", () => {
  assert.deepEqual(refs("- [ ] todo\n1. [x] done\n[[_TOC_]]\n/close\n```\n/close\n```"), [
    "1 other task box [ ]", "2 other task box [x]", "3 other [[_TOC_]]", "4 quick /close",
  ]);
});

test("formats the report by category, with the lines of each reference", () => {
  const report = formatReferences(findReferences("#1 @a\n#1 #2"), "f.md");
  assert.match(report, /Mentions: notify[^\n]*\n {2}@a {2}line 1\n/);
  assert.match(report, /#1 {2}lines 1, 2\n {2}#2 {2}line 2\n/);
  assert.equal(formatReferences([], "f.md"), "No GitLab reference, mention or quick action outside code in f.md.\n");
});

test("parses related issues of the project and of other projects", () => {
  assert.deepEqual(parseRelated("#12"), { project: PROJECT, iid: "12" });
  assert.deepEqual(parseRelated("a/b#3"), { project: "a/b", iid: "3" });
  assert.deepEqual(parseRelated("https://gitlab.com/a/b/-/issues/4#note_9"), { project: "a/b", iid: "4" });
  assert.throws(() => parseRelated("a/b"), /invalid issue for --related/);
});
