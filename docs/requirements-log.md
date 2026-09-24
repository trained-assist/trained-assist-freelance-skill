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

## 2026-09-24 — генерация ТЗ (скилл подключён к агенту)

- [x] `реализовано` freelance-скилл подключён к trained-assist-agent как MCP `freelance-skills` (agent #1330); проекты в `~/users/<profile>/Фриланс проекты/`
- [x] `реализовано` независимые long/short: `freelance_generate_spec(variants)`, нормализация в `spec/_source.md`, short ≠ сжатие long (PR #15)
- [x] `реализовано` ТЗ = ТЗ, не конспект: запрет «клиент сказал»/хронологии/провенанса/мета-разделов; отдельный запрет раздела «Input Info»/транскриптов (PR #16)
- [x] `реализовано` правки существующего ТЗ без перегенерации: `freelance_get_spec` (правка > шаблон; read-compat с legacy `tz.md`)
- [x] `реализовано` persistent-правила генерации: `freelance_generation_note` (профиль/проект) + команда `/remember`
- [x] `реализовано` batch: `freelance_list({since})`, `freelance_generate_all` (по умолчанию 6ч + таблица проектов/рисков)
- [x] `реализовано` доменный command surface: `commands.json` — единый источник; команды `/spec_generation_defaults`, `/spec_generation_explained`, `/remember`
- [x] `реализовано` E2E-тест (issue #12): `npm run test:e2e` — фикстура «врачи» → реальный flow (opencode+MCP) → структурные проверки → LLM-судья; прогон PASS
- [x] `реализовано` инцидент голосовых: на freelance-Worker'е не было `DEEPGRAM_API_KEY` → выставлен (см. tg-bot #246)
- [ ] `планируется` тихий набор входного (всегда копим; ACK по all_on; TTL 6ч) — tg-bot #251
- [ ] `планируется` E2E: main bot regression + restart через freelance bot; вынос общего runner'а (сейчас харнесс дублирует workspace/opencode из `bin/bot.js`)

## Отложено

- [ ] `планируется` batch-leads smoke (projects_daily_2026-09-21_no_links.xlsx, ~600 строк)