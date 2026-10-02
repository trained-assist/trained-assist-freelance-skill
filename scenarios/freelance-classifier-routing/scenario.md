# Scenario — document classifier routing (mandatory replay)

**Класс:** mandatory (`scripts/staging/suites.json` → `npm run test:replay`)
**Домен:** freelance
**Источник:** `docs/user-scenarios/freelance/01-freelance-project-spec.md` (Edge cases → «Два похожих проекта»)
**Реализация:** `tests/replay/02-classifier-routing.spec.mjs`

## Что проверяем

`freelance_classify_document` маршрутизирует новый документ по **содержанию**, а не
по имени файла, и никогда не угадывает при недостаточной уверенности.

## План моков

| Рубеж | Чем мокаем | Фикстура |
|---|---|---|
| LLM (cheap-классификатор OpenRouter) | скриптованные ответы на loopback (`OPENROUTER_BASE_URL=http://127.0.0.1:<port>`) | `fixtures/llm/classifier-route-existing.json`, `classifier-ambiguous.json`, `classifier-new-project.json` |
| Внешняя сеть | loopback-only (staging guard); реальный openrouter.ai недостижим | — |
| `risk-engine` | не участвует | — |

## Шаги

| # | LLM-ответ | Наблюдаемый ассерт |
|---|---|---|
| 1 | `route-existing` (0.95) | `auto_filed=true`, `project_id` = созданный проект |
| 2 | `ambiguous` (0.61) | `auto_filed=false`, `new_project=false`, есть `candidates` |
| 3 | `new-project` (`ranked:[]`, `likely_new:true`) | `new_project=true`, `auto_filed=false` |
