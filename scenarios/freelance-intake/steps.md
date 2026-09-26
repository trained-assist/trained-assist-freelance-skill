# Replay steps — freelance-intake (executed by tests/replay/01-intake-pipeline.spec.mjs)

| # | Шаг (MCP tools/call) | Наблюдаемый ассерт |
|---|---|---|
| 1 | `freelance_new_project {name, type:ecommerce, description}` | `project_id`, `risk_score=4.3`, `risk_level=СРЕДНИЙ 🟡` |
| 2 | fs: `provenance/log.jsonl` | содержит `raw_excerpt` исходного описания, source/reliability |
| 3 | fs: `facts.md` | содержит исходное описание; `requirements.md` его НЕ содержит |
| 4 | `freelance_add_info stage=requirement content=REQ_MARKER…` | `risk-assessment.json` пересчитан |
| 5 | `freelance_add_info stage=solution content=SOL_MARKER…` | — |
| 6 | `freelance_add_info stage=interpretation content=INTERP_MARKER…` | — |
| 7 | `freelance_get_project` | requirements∋REQ, ∌SOL/INTERP; solution∋SOL, ∌REQ; interpretation∋INTERP |
| 8 | `freelance_assess` (дважды) | одинаковый verdict (детерминизм) |
| 9 | `freelance_add_info` все 8 сигналов=true + integrationCount=1 + hasMVP=true | `score=0`, `verdict` содержит «БРАТЬ» (golden) |
| 10 | `freelance_new_project type=academic` | нет бизнес-сигналов в open_questions; risks только scope/delivery/price |
| 11 | `freelance_add_info stage=qna content=QNA_MARKER` | — |
| 12 | `freelance_generate_spec` | variants=[long,short]; `sources` ∌ QNA_MARKER; instruction ∋ «НЕЗАВИСИМО» |
