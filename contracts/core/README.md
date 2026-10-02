# Core consumer snapshot (pinned)

Vendored byte-for-byte from `trained-assist/trained-assist-agent` so this
domain-skill repo can test against the **real** core contracts in CI, with no
network and no core checkout:

- `contract.schema.json` — `contracts/action-v1/contract.schema.json`
  (Action/provider/cron v1 + provider v2 descriptor schema).
- `action-provider-registry.cjs` — `src/action-provider-registry.js`, only the
  schema `require` path adjusted from `../contracts/...` to `./contract.schema.json`.
- `../mcp-skill-sources.schema.json` — `contracts/mcp-skill-sources.schema.json`
  (validates `mcp.manifest.json` / the source registry config).
- `reserved-servers.json` — snapshot of core-owned MCP server ids that a domain
  skill must never shadow (`writeMcpConfig` / `mergeAdapterServers`,
  `src/browser.js`).

The contract suite executes the **actual** core consumer
(`ActionProviderRegistry`), not a hand-written lookalike validator: it registers
`provider-manifest.json` and asserts atomic registration, schema compilation,
argument validation and trigger policy. A green contract proves compatibility
with this pinned revision — **not** with any future core `main`. When core's
contract changes, refresh these files together with this provenance and re-run
`npm run test:contract`; provider and core coordinate the update.

`provider-manifest.json` remains this repo's rich v2 MCP catalog (descriptions
included); it is embedded verbatim as `approvedManifest` in the generated
`mcp.manifest.json`. No core runtime deployment is part of this change.
