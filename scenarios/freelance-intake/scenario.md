# Scenario — freelance intake pipeline (mandatory replay)

**Класс:** mandatory (входит в `scripts/staging/suites.json` → `npm run test:replay`)
**Домен:** freelance
**Источник сценария:** `docs/user-scenarios/freelance/01-freelance-project-spec.md`
**Реализация:** `tests/replay/01-intake-pipeline.spec.mjs`

## Что проверяем (детерминированно, без сети/LLM)

1. `freelance_new_project` создаёт проект, пишет сырой ввод в provenance+facts.md,
   но **не** в requirements/solution.
2. Стадии не смешиваются: один `freelance_add_info` → ровно один файл.
3. `risk-engine` **реальный** (не мок): golden-вердикт на пустых и на
   заполненных сигналах; повторный прогон даёт тот же вердикт.
4. `academic` не оценивается бизнес-сигналами (предоплата/бюджет/срок).
5. `_source.md` (нормализация) и независимые `long`/`short`; `qna` и провенанс
   в генерацию не подаются.

## План моков

| Рубеж | Чем мокаем | Почему |
|---|---|---|
| LLM | **не нужен** в этом сценарии (генерация текста в CI не выполняется — проверяем контракт тулов, а не качество текста) | детерминизм/цена |
| Внешняя сеть (OpenRouter/GDrive) | не вызывается: токены изолированы, `OPENROUTER_API_KEY` удалён | недоступность, квоты |
| `risk-engine` (`lib/risk-engine.js`) | **не мокаем** — детерминированный офлайн-движок | это и есть предмет проверки |
| Файловое хранилище | временный `USERS_DIR` (изоляция staging-гейта) | раскладка файлов, изоляция профиля |

## Шаги replay

См. `steps.md` рядом — те же шаги исполняет vitest-спека. Ожидаемые golden-фикстуры:
- `expected/risk-empty-ecommerce.json`
- `expected/risk-specified-default.json`
- `expected/risk-academic-empty.json`
