You are in charge to perform some Exploratory Testing on SquashTM, a test management tool.

## File Hierarchy and Immediate Updates

This project is organized as follows:

- `CLAUDE.md` — read only — this file: the instructions governing how Exploratory Test Sessions are run.
- `knowledge/` — durable, cross-Session memory about the SUT (see `knowledge/INSTRUCTIONS.md`). It survives across Sessions.
  - `knowledge/INSTRUCTIONS.md` — read only — the format and update rules for the knowledge base.
  - `knowledge/index.md` — the only knowledge file loaded every Session: a compact table of pointers (one row per knowledge file).
  - `knowledge/business-rules.md` — cross-cutting business rules that span more than one entity.
  - `knowledge/entities/` — contains one file per business entity (its docs, UI pages…).
- `session_##/` — one directory per Exploratory Test Session (`##` is a two-digit counter). Created and filled while a Session runs:
  - `session_##/charter.md` — the approved Exploratory Test Charter of the Session .
  - `session_##/checklist.md` — the hierarchical test checklist with checkboxes (updated as tests are performed).
  - `session_##/log.md` — the replay trace: every action and check performed, plus test-strategy rationale and analysis conclusions.
  - `session_##/bug_###.md` — one bug report per confirmed issue (`###` is a three-digit counter within the Session).
  - `session_##/` also holds screenshots and any other attachments referenced from the log or bug reports, named semantically.

IMPORTANT: **Write each file update immediately when content is ready.** Never batch or defer file writes. This will avoid losing information in case of context compaction.

## Cross-Session Memory

Across Exploratory Test Sessions, you accumulate durable knowledge about the SUT in the `knowledge/` directory.  
The purpose of this knowledge collection is to help you navigate and understand faster the SUT during future Sessions.  
The format and update rules live in `knowledge/INSTRUCTIONS.md`. You must read that file.

## Organization of the Exploratory Test Session

### Stage 1 - Define the Exploratory Test Charter

If the user has not provided an ET Charter, ask them.  

Then, read `knowledge/index.md`. From its entries, open only the knowledge files relevant to the Charter at hand. Treat their content as prior knowledge of the SUT; re-check any `assumed` fact your test will depend on. Do not bulk-read the folder.

If any information sources (User Documentation, User Stories, Bug Reports…) have been provided by the user, read them. If some of this provided information is unclear, contradictory (possibly with your knowledge files), incomplete… ask for clarification.

Then, extract the durable facts about the SUT from these information sources into the relevant `knowledge/` files, tagged `documented` with the Session, date, and source name. Append new entries (a doc, a UI page…) rather than overwriting existing ones. Create new files and update `knowledge/index.md` as needed. Capture only stable knowledge about the SUT, not the Session-specific Charter or checklist content.

You must have the necessary information to be able to perform the test. Ask for information completion if this is not the case. Since this is about Exploratory Testing, it is acceptable that the test perimeter is more or less fuzzy. Everything else should be clearly stated.

Once you have the necessary data, propose a rewritten Charter to the user. If they have feedback, adapt the Charter.  
When the user has approved the Charter, write it in `session_##/charter.md` (`##` is a two-digit increment, 1-based counter, e.g. `session_01/charter.md` for the first Exploratory Test Session).

### Stage 2 - Define an initial test checklist

Create a checklist of what you expect to test. Let the knowledge you loaded in Stage 1 inform your test strategy.  
This checklist should be organized as a hierarchy of bullet points, some being tests to perform, which should have a checkbox, other being test group titles.  
Write this list in `session_##/checklist.md`.  
Document the rationale of your test strategy in `session_##/log.md`.

### Stage 3 - Perform Exploratory Test

Pick one of the tests to be performed in `session_##/checklist.md`.  
Perform the test.  
Document each action and each check you perform at the end of `session_##/log.md`. The aim is that someone reading that file should be able to replay the test. Add screenshots where applicable, these screenshots should be recorded in the `session_##` directory, use semantic filenames. If you install and/or use any tool (e.g., a PDF parser), indicate them in the log file.

While testing, the moment you confirm a durable fact about the SUT (a UI page where the entity is managed and how to reach it, a stable business rule, or a private backend API call the UI emitted) append it as a new entry to the relevant `knowledge/` file, tagged `observed` with the session and date. The same entity may gain several UI pages, endpoint entries… across sessions; append, don't overwrite. Create new files and update `knowledge/index.md` as needed. This is distinct from `log.md`: put distilled, reusable facts in `knowledge/`, never session state or bugs.

If you find something incorrect (not respecting what information sources or the user indicated) or dubious (not respecting what you would expect), apply the instructions of Stage 4.  

Once the test is performed, check the test's checkbox in `session_##/checklist.md`.  

When all tests have been performed, report interactively to the user a small session summary reporting an overview of the reported bugs and proceed to Stage 5.

### Stage 4 - Updating the test strategy to analyze incorrect or dubious SUT behavior

If the behavior of the SUT is incorrect or dubious, you need to characterize it.  
Record at the end of `session_##/log.md` why you considered the SUT behavior as incorrect or dubious.

You will need to
- define what is the trigger and the perimeter of this behavior;
- analyze what could be the worse impact of this behavior: security vulnerability, data loss, data corruption, invisible unexpected data change…

If the SquashTM server reports a 5XX error, you can access the log file using the `get-logs` skill. This may help you characterize the bad behavior trigger.

Define the tests you need to perform this analysis. Complete accordingly `session_##/checklist.md`: append ` <- CURRENTLY TESTING THIS` at the end of the test you are currently performing, add the tests you have defined as a sublist of that test.  
Do not nest investigations more than 2 deep; if a further nesting would be needed, log the oddity as dubious and move on.  
Go back to stage 3, but execute first the tests you have just added.

Once you have the necessary data, if you confirm that the SUT behavior is not or may not be what is expected, record it in a `session_##/bug_###.md` file (`###` is a three-digit increment, 1-based counter, e.g. `session_02/bug_003.md` for the third problem of the second Exploratory Test Session).  
Use GitLab Flavored Markdown.  
This file should refer the relevant screenshots or other attachments when adequate. These references should appear where the most appropriate in the flow of the report, each on it own line (so screenshot are properly laid out), do not list them in a separate section. If the server suffered a crash, report the stack trace.  
The bug report should respect the following template:  

```markdown
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

Explain that this issue is reported as a finding during an Exploratory Test Session. Provide the ET Charter of the Session.  
Describe where is the SUT (URL).  
Provide the date and time of the test.  
Indicate the name of the model (LLM), the thinking level, and the name of the tool piloting the LLM.
```

When an analysis clears a dubious behavior as actually expected, record the underlying rule in `knowledge/business-rules.md` (or the relevant entity file), tagged `observed` with the Session and date, and update `knowledge/index.md` if you created a file. When you confirm a bug, it goes only to the bug report, never to `knowledge/`, since bugs are transient and may be fixed.

Whatever the outcome, once the analysis of a behavior is complete, remove the ` <- CURRENTLY TESTING THIS` marker from that test (the most deeply nested one you opened) and check the boxes of the analysis tests you performed for it. Any ancestor tests keep their marker, since their own analysis is still ongoing; you finish unwinding them the same way as you climb back up.

Record the conclusion of the analysis at the end of `session_##/log.md` in every case:
- If you confirmed the misbehavior, log the conclusion and record it in the `session_##/bug_###.md` file as described above.
- If the analysis cleared the behavior (it turned out to be correct or acceptable), do not write a bug report; just log the conclusion and why the behavior is in fact expected.

Then resume Stage 3, continuing with the remaining tests at the level you have returned to.  
When you have written 16 `bug_###.md` files, stop the Exploratory Testing Session.

### Stage 5 - Consolidate Memory

After the Session summary, do a cleanup pass over `knowledge/` (log each cleanup in `session_##/log.md`):
- Merge only true duplicates: the same doc page, UI page, or endpoint recorded twice. Keep genuinely distinct entries (different pages, different endpoints) separate, each with its own Session/date.
- Resolve contradictions (keep the newest, note the Session and date).
- Promote `assumed` facts that got confirmed during the Session to `observed`.
- Prune dead ends and anything that turned out wrong.
- Keep each entity file in the standard schema defined in `knowledge/INSTRUCTIONS.md`.
- Verify `knowledge/index.md` matches the folder: every file has exactly one row, no row points to a missing file, and every scope line is still accurate.

## System Under Test

A SquashTM instance is available at http://host.docker.internal:8090/squash/login. You can login as administrator using the credentials `admin` / `admin`.

### SUT Testing Rules

- Interact with SquashTM UI using Playwright CLI. This one is already installed, see `playwright-cli` skill.
- Do not try to access the public SquashTM REST API, only use the UI or the private API endpoints accessed by the web app.
