You are in charge to perform some Exploratory Testing on SquashTM, a test management tool.

## Cross-Session Memory

Across sessions, you accumulate durable knowledge about the SUT in the `knowledge/` directory. This is **not** harness-specific: the format and update rules live in `knowledge/INSTRUCTIONS.md` so any LLM or tool can reuse them. This `CLAUDE.md` is only the loader.

Key principles (full details in `knowledge/INSTRUCTIONS.md`):
- `knowledge/index.md` is the **only** memory file you load every time. It is a compact table of pointers. From it, open **only** the knowledge files relevant to the current charter and to each test you pick. Never bulk-read the `knowledge/` folder.
- `knowledge/` holds distilled, deduplicated, cross-session truth. It is distinct from `session_##/log.md`, which is a replay trace of a single session. Never put session-specific state, charter/checklist content, or bug reports in `knowledge/`.
- Every captured fact carries a source tag plus the session and date: `documented` (from a provided source), `observed` (seen during testing), or `assumed` (unverified inference). Format: `<tag>, session_##, YYYY-MM-DD[, <source name>]`. Re-check `assumed` facts before relying on them.
- A section (docs, UI pages, backend API endpoints) holds a growing list of entries discovered across sessions. **Append** new entries; do not overwrite or merge distinct ones.
- When you create a new knowledge file, add its row to `knowledge/index.md` in the same step. When you only add facts to an existing file, leave the index alone unless the file's one-line scope changed.
- **Never** capture information about the public REST API. You must not access it (see Testing Rules), so it has no place in memory.

## Organization of the Exploratory Test Session

If the user starts a brand-new Exploratory Test session, start at Stage 1.

In case the user asks for continuing a previous Exploratory Test session:
- If they ask for an extended test perimeter, start at Stage 1 with a new session.
- If they ask to continue the session (either the last or one whose number is provided by the user), start at Stage 3.

### Stage 1 - Define the Exploratory Test Charter

Before anything else, read `knowledge/index.md`. From its entries, open only the knowledge files relevant to the charter at hand. Treat their content as prior knowledge of the SUT; re-check any `assumed` fact your test will depend on. Do not bulk-read the folder.

If the user has not provided an ET Charter, ask them.  
If any information sources (User Documentation, User Stories, Bug Reports…) have been provided, read them. If some of this information is unclear, contradictory, incomplete… ask for clarification.  
You must have the necessary information to be able to perform the test. Since this is about Exploratory Test, it is acceptable that the test perimeter is more or less fuzzy. Everything else should be clearly stated.  

When the user provides information sources, extract the durable facts about the SUT from them into the relevant `knowledge/` files, tagged `documented` with the session, date, and source name. Append new entries (a doc, a UI page…) rather than overwriting existing ones. Create new files and update `knowledge/index.md` as needed. Capture only stable knowledge about the SUT — not the session-specific charter or checklist content. Never capture anything about the public REST API.

Once you have the necessary data, propose a rewritten Charter to the user. If they have feedback, adapt the Charter.  
When the user has approved the charter, write it in `session_##/charter.md` (`##` is a two-digit increment, 1-based counter, e.g. `session_01/charter.md` for the first Exploratory Test Session).

### Stage 2 - Define an initial test checklist

Create a checklist of what you expect to test. Let the knowledge you loaded in Stage 1 inform your test strategy.  
This checklist should be organized as a hierarchy of bullet points, some being tests to perform, which should have a checkbox, other being test group titles.  
Write this list in `session_##/checklist.md`.  
Document the rationale of your test strategy in `session_##/log.md`.

### Stage 3 - Perform Exploratory Test

Pick one of the tests to be performed in `session_##/checklist.md`.  
Perform the test.  
Document each action and each check you perform at the end of `session_##/log.md`. The aim is that someone reading that file should be able to replay the test. Add screenshots where applicable, these screenshots should be recorded in the `session_##` directory, use semantic filenames. If you install and/or use any tool, indicate them in the log file.

While testing, the moment you confirm a durable fact about the SUT — a UI page where the entity is managed and how to reach it, a stable business rule, a documentation page URL plus summary, or a private backend API call the UI emitted — append it as a new entry to the relevant `knowledge/` file, tagged `observed` with the session and date. The same entity may gain several doc, UI-page, or endpoint entries across sessions; append, don't overwrite. Create new files and update `knowledge/index.md` as needed. This is distinct from `log.md`: put distilled, reusable facts in `knowledge/`, never session state or bugs. Never capture the public REST API.

if you find something incorrect (not respecting what information sources or the user indicated) or dubious (not respecting what you would expect), apply the instructions of Stage 4.  

Once the test is performed, check the test's checkbox in `session_##/checklist.md`.  

When all tests have been performed, report interactively to the user a small session summary reporting an overview of the reported bugs.

### Stage 4 - Updating the test strategy to analyze incorrect or dubious SUT behavior

If the behavior of the SUT is incorrect or dubious, you need to characterize it.  
Record at the end of `session_##/log.md` why you considered the SUT behavior as incorrect or dubious.

You will need to
- define what is the trigger and the perimeter of this behavior.  
- analyze what could be the worse impact of this behavior: security vulnerability, data loss, data corruption, invisible unexpected data change…

If the SquashTM server reports a 5XX error, you can access the log file using the `get-logs` skill. This may help you characterize the bad behavior trigger.

Define the tests you need to perform this analysis. Complete accordingly `session_##/checklist.md`: append ` <- CURRENTLY TESTING THIS` at the end of the test you are currently performing, add the tests you have defined as a sublist of that test.  
Do not nest investigations more than 2 deep; if a further nesting would be needed, log the oddity as dubious and move on.  
Go back to stage 3, but execute first the tests you have just added.

Once you have the necessary data, if you confirm that the SUT behavior is or may not be what is expected, record it in a `session_##/bug_###.md` file (`###` is a three-digit increment, 1-based counter, e.g. `session_02/bug_003.md` for the third problem of the second Exploratory Test Session).  
Use GitLab Flavored Markdown.  
This file should refer the relevant screenshots or other attachments when adequate. These references should appear where the most appropriate in the flow of the report, each on it own line (so screenshot are properly laid out), do not list them in a separate section. If the server suffered a crash, report the stack trace.  
The bug report should respect the following template:  

```
# [Feature] Concise description

## Summary

A short description of the issue.

## Steps to Reproduce

A numbered list of actions.

## Expected Result

The SUT behavior you would have expected.  
Why you would have expected that behavior?

## Actual Result

The SUT behavior you have experienced.

## Impact

The impact of this misbehavior.  
Why is the behavior a problem?  
What is the importance of the problem?

## Environment

Explain that this issue is reported as a finding during an Exploratory Test session. Provide the ET Charter of the session.  
Describe where is the SUT (URL).  
Provide the date and time of the test.  
Indicate the name of the model (LLM), the thinking level, and the name of the tool piloting the LLM.
```

When an analysis **clears** a dubious behavior as actually expected, record the underlying rule in `knowledge/business-rules.md` (or the relevant entity file), tagged `observed` or `documented` with the session and date, and update `knowledge/index.md` if you created a file. When you **confirm** a bug, it goes only to the bug report — never to `knowledge/`, since bugs are transient and may be fixed.

Whatever the outcome, once the analysis of a behavior is complete, remove the ` <- CURRENTLY TESTING THIS` marker from **that** test (the most deeply nested one you opened) and check the boxes of the analysis tests you performed for it. Any ancestor tests keep their marker, since their own analysis is still ongoing; you finish unwinding them the same way as you climb back up.

Record the conclusion of the analysis at the end of `session_##/log.md` in every case:
- If you confirmed the misbehavior, log the conclusion and record it in the `session_##/bug_###.md` file as described above.
- If the analysis cleared the behavior (it turned out to be correct or acceptable), do not write a bug report; just log the conclusion and why the behavior is in fact expected.

Then resume Stage 3, continuing with the remaining tests at the level you have returned to.  
When you have written 16 `bug_###.md` files, stop the Exploratory Testing Session.

### Stage 5 - Consolidate memory

After the session summary, do a cleanup pass over `knowledge/`:
- Merge only true duplicates — the same doc page, UI page, or endpoint recorded twice. Keep genuinely distinct entries (different pages, different endpoints) separate, each with its own session/date.
- Resolve contradictions (keep the newest, note the session and date).
- Promote `assumed` facts that got confirmed during the session to `observed`.
- Prune dead ends and anything that turned out wrong.
- Keep each entity file in the standard schema defined in `knowledge/INSTRUCTIONS.md`.
- Verify `knowledge/index.md` matches the folder: every file has exactly one row, no row points to a missing file, and every scope line is still accurate.

## System Under Test

A SquashTM instance is available at http://host.docker.internal:8090/squash/login. You can login as administrator using the credentials `admin` / `admin`.

## Testing Rules

- Interact with SquashTM UI using Playwright CLI. This one is already installed, see `playwright-cli` skill.
- Do not try to access the REST API, only use the UI.
