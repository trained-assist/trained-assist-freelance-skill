# Executable CI contract for this domain skill

Implements `trained-assist/trained-assist-agent` →
`docs/domain-skill-repo-test-rules.md`. Three hermetic CI layers plus a
deterministic replay gate; the LLM judge is staging-only.

## Layers

| Layer | What it proves | Command (CI job) |
|---|---|---|
| **L1 Contract** | `mcp.manifest.json` conforms to the pinned `contracts/mcp-skill-sources.schema.json`; `artifactDigest` recomputes; the **real** core `ActionProviderRegistry` accepts `provider-manifest.json`; tool names have exact parity with the live `tools/list`; no core server id is shadowed | `npm run test:contract` (`contract`) |
| **L2 Behavior** | The server runs as a **real stdio JSON-RPC subprocess**; every tool has a fixture and returns a `content[]` envelope; unknown tools / bad args are in-band `isError`, never a crash; the only scripted seam is the LLM (loopback) | `npm run test:behavior` (`behavior`) |
| **L3 Guards** | Static grep gates: quick-action tools never spawn Claude/opencode/`runner.js`; every outbound call has `AbortSignal.timeout`; secrets are never logged; tool modules resolve storage via `lib/paths`, never `os.homedir()`/`process.cwd()` | `npm run test:guards` (`guards`) |
| **Replay gate** | Deterministic scenarios over the real server with isolated data roots and loopback-only outbound; `skipped`/`todo`/empty runs cannot approve a release | `npm run test:replay` (`staging-gate`) |
| **Unit** | Existing offline domain tests | `npm run test:unit` |

## What is mocked

Exactly two boundaries, and neither is this service:

- **LLM** — scripted fixtures (`fixtures/llm/*.json`) served on loopback via
  `OPENROUTER_BASE_URL`. Production default stays `https://openrouter.ai`.
- **External network** — `scripts/staging/isolation-guard.cjs` (preloaded via
  `NODE_OPTIONS=--require`) blocks everything but loopback; `tests/helpers/network-guard.cjs`
  does the same for standalone suites.

`lib/risk-engine.js` is deterministic and is **never** mocked — a golden verdict
guards its weights. `registry.js` is never mocked either (mock-registrar is an
explicit anti-pattern, §8).

## Harness

Phase 1 vendors the core replay-gate harness byte-for-byte:

- `scripts/staging/run.mjs` — the gate (source digest manifest, isolation probe,
  mandatory-suite enforcement).
- `scripts/staging/isolation-guard.cjs` — isolated `HOME`/`TMPDIR`/`USERS_DIR`/
  `AGENT_DATA_DIR`/`AGENT_TOKENS_ROOT`, fail-fast on prod creds, loopback-only.
- `scripts/staging/suites.json` — the mandatory scenario set.
- `tests/helpers/mcp-client.cjs` — spawn the real MCP server over stdio.
- `contracts/core/` — pinned core consumer snapshot (see its README).

Phase 2 (extraction into `@trained-assist/mcp-skill-testkit`) is not part of this change.

## Release gate

`ci` requires `unit` + `contract` + `behavior` + `guards`; `staging-gate`
requires the replay gate. Both must be `success` — `failure`, `cancelled` and
`skipped` do not pass. Pin the repo's branch protection to both checks.

## Staging (post-merge, not CI)

The LLM judge (`e2e/spec-generation.e2e.mjs`, workflow `staging-judge`, manual
`workflow_dispatch`) runs a **live** engine + a cheap LLM judge against a real
OpenRouter key. It is deliberately **not** on `pull_request`: a judge in CI is a
non-deterministic, flaky gate (§4). Staging mounts the **real** control plane to
a sandbox profile — a mock registrar is never built.
