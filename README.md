# trained-assist-freelance-skill

Freelance project intake & analysis skill — provenance/facts/requirements/solution
pipeline, multi-project store, GO/NO-GO risk scoring, incoming-document classifier.

Domain skill server, same pattern as `trained-assist-hh-skill`: a standalone MCP
tool server (`src/mcp-skills/`) meant to be plugged into a Claude Code session's
`.mcp.json` as a sibling process. For now it also ships its own small standalone
bot/runner (`bin/`) so it can be developed and tested end-to-end without touching
`trained-assist-agent`'s code at all — integration into the shared multi-tenant
agent is a deliberate later step, once this is proven out.

## Why profile root, not `process.cwd()`

`trained-assist-agent`'s Telegram bot maps each topic to its own project workDir
*before* a session starts — a topic is not a client project. The same real
project gets discussed across different topics, and unrelated projects can land
in the same topic. So every tool here resolves storage against the **profile
root** (`$USERS_DIR/<profile>/Фриланс проекты/`, see `src/mcp-skills/lib/paths.js`),
never `process.cwd()`. Every project is visible from any topic/session of the
same profile.

## Pipeline

```
RAW INPUT ──▶ provenance/log.jsonl (+ raw/ copy)
           ──▶ facts.md          (extracted, deduped, cites a provenance id)
           ──▶ requirements.md   (client asks/constraints/open questions — no engineering)
           ──▶ interpretation.md (our assumptions, flagged, pending confirmation)
           ──▶ solution.md       (our engineering answer, cites requirement ids)
           ──▶ spec/tz.md        (generated from requirements.md + solution.md only)
```

`freelance_add_info`'s `stage` argument is what enforces this — each call writes
to exactly one file, so "client said X" can't casually leak into the solution,
and our own architecture ideas can't leak into what's supposed to be a clean
requirements record. Even when a client dictates technical details themselves
(e.g. "use CatBoost, 127 separate models, Jupyter notebooks") that's still a
**requirement** (a constraint the client is imposing), not our solution — our
`solution.md` is free to agree with it or push back (e.g. propose one
multi-output model instead).

## Project types

`ai_simple | integration | ecommerce | medtech | academic | default` — each has
its own risk-scoring signals and plan template (`lib/risk-engine.js`). `academic`
exists for fixed-scope task-for-hire work with no ongoing client relationship to
score (a bare problem-set PDF with no client name, no price, no deadline) — the
usual 8 business-relationship signals (prepayment, budget, deadline...) simply
don't apply there.

## Folder layout on disk

```
$USERS_DIR/<profile>/Фриланс проекты/
  _index.json                 # all projects: id, name, status, type, timestamps
  _classifier/
    recent-context.json       # sequence signal for freelance_classify_document
    drive-folder.json         # optional shared Google Drive folder for Sheets exports
  <project-slug>/
    project.json
    provenance/
      log.jsonl               # every intake event: source, reliability, contradicts
      raw/                    # small raw files kept verbatim
    facts.md
    requirements.md
    interpretation.md
    solution.md
    qna.md
    risk-assessment.json      # GO/NO-GO signals/score/verdict
    spec/
      tz.md
      exports/
```

## MCP tools (`src/mcp-skills/tools/`)

- `10-freelance-project.js` — `freelance_new_project`, `freelance_add_info`,
  `freelance_assess`, `freelance_questions`, `freelance_list`,
  `freelance_get_project` (full-context dump for resuming in a new session),
  `freelance_generate_spec`, `freelance_set_folder`.
- `20-freelance-classifier.js` — `freelance_classify_document`: cheap-LLM-only
  (OpenRouter, never spawns a Claude Code session) routing of a new incoming
  document to an existing project or "new project". Content dominates over
  filename; recency is a prior, never sufficient on its own to auto-file.

## Standalone bot (`bin/`)

A minimal, self-contained Telegram long-poll bot + Claude Code runner —
deliberately decoupled from `trained-assist-agent`'s server/runner/session code.
Runs on the same shared VM infra under the same `vova` user (no separate Linux
user), in its own directory. See `bin/README.md` for the deploy/run details.

## Tests

```
npm test   # node --test tests/*.test.js — offline, no network calls
```
