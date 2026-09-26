# Definition of Done — domain-skill test & CI rules

Goal: this domain MCP skill server satisfies `docs/domain-skill-repo-test-rules.md`
— three hermetic CI layers + a deterministic replay gate, mocks limited to the LLM
and external network, `risk-engine` and the registry left real.

- [x] CI green on https://github.com/trained-assist/trained-assist-freelance-skill/pull/22 (unit, contract, behavior, guards, staging-gate all pass)
- [ ] Merged to main
- [ ] Deployed / mounted to staging — verified live (real control plane to a sandbox profile)

Repository is not "ready" until:

- [ ] L1/L2/L3 green, mandatory `scripts/staging/suites.json` non-empty
- [ ] No non-loopback network or prod credentials during CI (isolation guard proves it)
- [ ] A scenario + mock plan exists for every supported happy path (`docs/user-scenarios/freelance/`, `scenarios/`)
- [ ] Tool-name parity between `provider-manifest.json` and the live `tools/list`
- [ ] Quick-action tools do not spawn Claude (`npm run test:guards`)
- [ ] Staging canary verified (source really mounts, not a mock)
