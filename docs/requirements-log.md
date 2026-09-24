# Requirements Log — trained-assist-freelance-skill

## Статусы
- `реализовано` — сделано и задеплоено
- `планируется` — зафиксировано, не начато
- `в работе` — частично сделано

---

## 2026-09-24 — подключение к основному сервису (эпик #1271)

- [x] `реализовано` Telegram-команды как быстрые ответы — setMyCommands + прямой вызов MCP-тулов без opencode (PR #2)
- [x] `реализовано` provider-manifest.json v2 — 9 actions + contextFields + connections, валидирован в ActionProviderRegistry (PR #3)
- [x] `реализовано` миграция legacy outsource-projects → «Фриланс проекты/» (scripts/migrate-outsource.js, PR #3)
- [x] `реализовано` миграция данных aleksandrl-iquarus на прод — 3 проекта видны в freelance_list (Renovatio МИС, ЖБИ-заводы, ИИ-агент Битрикс24+МойСклад)
- [x] `реализовано` cross-process lock для _index.json + package-lock.json для artifact-сборки (PR #5)
- [x] `реализовано` документация manifest/migration в README (PR #4)

## Остаток эпика #1271 (делает основной репо, агент maryam)

- [ ] `в работе` PR2 — managed MCP adapter + approved transport (ветка feat/mcp-sources-1271-runtime)
- [ ] `планируется` PR3 — боевое переключение HH-роутинга на registry, убрать hardcode sibling paths
- [ ] `планируется` multi-bot: generic botId/audience в tg-bot gateway
- [ ] `планируется` scoped /tasks/stop + /quick audience
- [ ] `планируется` E2E: main bot regression, freelance bot, restart через freelance bot

## Отложено

- [ ] `планируется` batch-leads smoke (projects_daily_2026-09-21_no_links.xlsx, ~600 строк)
- [ ] `планируется` интеграция freelance-скилла как sibling MCP в trained-assist-agent (после закрытия #1271)