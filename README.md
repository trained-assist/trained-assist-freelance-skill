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

Sources (dialogue/files/screenshots) are **traceability, not spec text** — they
never leak into the final document automatically:

```
RAW INPUT ──▶ provenance/log.jsonl (+ raw/ copy)        [sources / traceability only]
           ──▶ facts.md          (extracted, deduped, cites a provenance id)
           ──▶ requirements.md   (atomic requirements about the system: «Система должна …», no «клиент сказал»)
           ──▶ interpretation.md (our assumptions, flagged)
           ──▶ solution.md       (our engineering answer)
           ──▶ spec/_source.md   (normalized context — the single input to both variants)
                ├──▶ spec/long.md   (detailed spec for the implementer)
                └──▶ spec/short.md  (independent executive spec for the client)
```

`long.md` and `short.md` are generated **independently** from the same normalized
context — `short` is *not* a summary of `long` (versions may differ in framing and
emphasis, so the freelancer can pick the better one to send). Both describe the
**system**, never the conversation: no «клиент сказал», no chronology, no
provenance references, no meta-sections («допущения и почему они здесь»).
Open/unconfirmed items go to a short «Открытые вопросы» section, not into the
requirements prose.

- **Persistent generation rules** — `_generation.md` (profile) and
  `<project>/generation.md` (project, wins), written via `freelance_generation_note`.
  Applied to every subsequent generation.
- **Ad-hoc edits** — a one-off request («убери раздел X», «сократи», «измени только
  Short») edits the existing `long.md`/`short.md` in place via `freelance_get_spec`;
  the user's instruction outranks the template (a removed section is not restored).
- **Batch** — `freelance_generate_all` collects projects over a window (default 6h),
  returns a projects/risks table to show first, then generates per project.

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
  _generation.md              # profile-level persistent generation rules
  _classifier/
    recent-context.json       # sequence signal for freelance_classify_document
    drive-folder.json         # optional shared Google Drive folder for Sheets exports
  <project-slug>/
    project.json
    generation.md             # project-level persistent generation rules (wins over profile)
    provenance/
      log.jsonl               # every intake event: source, reliability, contradicts
      raw/                    # small raw files kept verbatim
    facts.md
    requirements.md
    interpretation.md
    solution.md
    qna.md                    # conversation log — traceability, NOT fed into spec generation
    risk-assessment.json      # GO/NO-GO signals/score/verdict
    spec/
      _source.md              # normalized context both variants are generated from
      long.md                 # detailed spec (implementer)
      short.md                # independent executive spec (client)
      tz.md                   # legacy single-document pipeline — read-compat only
      exports/
```

## MCP tools (`src/mcp-skills/tools/`)

- `10-freelance-project.js` — `freelance_new_project`, `freelance_add_info`,
  `freelance_assess`, `freelance_questions`, `freelance_list` (with `since` window),
  `freelance_get_project` (full-context dump for resuming in a new session),
  `freelance_generate_spec` (normalized context + `variants: long|short|both`),
  `freelance_get_spec` (read current long/short for in-place editing),
  `freelance_generation_note` (persistent profile/project generation rules),
  `freelance_generate_all` (batch over a time window), `freelance_set_folder`.
- `20-freelance-classifier.js` — `freelance_classify_document`: cheap-LLM-only
  (OpenRouter, never spawns a Claude Code session) routing of a new incoming
  document to an existing project or "new project". Content dominates over
  filename; recency is a prior, never sufficient on its own to auto-file.

## Provider manifest (`provider-manifest.json`)

Manifest v2 for onboarding into the Agent Control Plane's approved MCP source
registry (trained-assist-agent#1271): all 9 actions with `inputSchema` /
`effect` / `requiresApproval` / `retrySafety`, plus `contextFields` and
`connections` (gdrive, openrouter). The manifest is metadata for the managed
MCP adapter; it does not change how the skill stores data (see §15/§16 of the
epic — the legacy profile-root filesystem store remains the source of truth).

## Migrating legacy projects (`scripts/migrate-outsource.js`)

One-shot conversion of `outsource-projects/<id>.json` (the old per-topic format
from trained-assist-agent's `94-outsource-project.js`) into the profile-root
multi-project store:

```bash
USERS_DIR=/home/vova/users node scripts/migrate-outsource.js --profile <username> [--dry-run]
```

Carries signals/projectInfo, maps `infoChunks`/`qaLog` to pipeline stages,
preserves originals in `provenance/raw/`, and reassesses risk with the current
deterministic engine. Idempotent by project name.

## Standalone bot (`bin/`)

A minimal, self-contained Telegram long-poll bot + opencode runner —
deliberately decoupled from `trained-assist-agent`'s server/runner/session code.
Runs on the same shared VM infra under the same `vova` user (no separate Linux
user), in its own directory. See `bin/README.md` for the deploy/run details.

## Tests & CI

Executable contract per `trained-assist-agent/docs/domain-skill-repo-test-rules.md`
(see `docs/skill-ci.md` for the full rationale):

```
npm run test:unit       # existing offline domain tests (node --test)
npm run test:contract   # L1: mcp.manifest.json, digest, name parity, real core consumer
npm run test:behavior   # L2: real MCP subprocess over stdio + per-tool fixtures
npm run test:guards     # L3: static gates (no agent spawn, timeouts, secrets, paths)
npm run test:replay     # deterministic replay gate (isolated roots, loopback-only)
npm run test:e2e        # staging-only: live engine + LLM judge (needs opencode + key)
```

Only two things are mocked — the LLM (scripted `fixtures/llm/*.json` on loopback)
and external network (isolation guard). `lib/risk-engine.js` is deterministic and
is never mocked; `registry.js` is never mocked (mock-registrar is an anti-pattern).
The replay gate vendors the core harness (`scripts/staging/run.mjs` +
`isolation-guard.cjs` + `suites.json`) and executes the mandatory scenarios in
`tests/replay/`; `staging-results/manifest.json` records exactly what ran.
