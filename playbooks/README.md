# Playbooks (draft)

Черновик Playbook v1 для домена фриланса. Схема контракта живёт в
`trained-assist-agent/contracts/playbook.schema.json`; рантайм-резолвер читает sibling-репо
(`trained-assist-agent/src/playbook-store.js`: profile → **sibling** → system), поэтому
`playbooks/<id>.json` здесь виден агенту без копирования в основной репозиторий.

## `freelance-project.json`

Полный конвейер: intake → extract (факты/требования/допущения/решение) → clarify →
assess (GO/NO-GO) → spec (long/short). Агентные шаги несут
`executor_role` / `minimum_model_level` / `context_budget`; объективные шаги —
`execution_kind: "programmatic"`.

**Это черновик `scope: system`** — как и любой репо-плейбук, он меняется через PR, а не
через `playbook_save` (тот работает только с profile-scope).

### Чего в schema v1 ещё нет

Programmatic-шаги этого домена исполняются **MCP-тулами скилла** (`freelance_assess`,
`freelance_generate_spec`, …), а не shell-командами. В v1 у шага нет поля, называющего
исполнителя, поэтому сейчас контракт programmatic-шага — это `execution_kind` + текст
`instructions` (в `instructions` явно назван тул).

Предложение (schema v2) — опциональное поле `runner`, которое ссылается на
зарегистрированное действие/тул (или shell-команду):

```json
{
  "title": "Run deterministic risk assessment",
  "execution_kind": "programmatic",
  "runner": "action: freelance.assess",
  "validation": { "risk_assessment_written": true }
}
```

Тогда `checklist.md` рендерил бы `[programmatic: action: freelance.assess] Run deterministic
risk assessment`. Аналогично для инженерного плейбука — `shell: npm test`,
`action: git.open_pr`. До появления поля эквивалент — тул, названный в `instructions`.

## Проверка локально

```bash
# из trained-assist-agent (sibling-чекаут должен быть рядом с репозиторием)
node -e "
const { PlaybookStore } = require('./src/playbook-store');
const pb = new PlaybookStore({ profileId: 'demo' }).get('freelance-project');
console.log(pb && pb.id, pb && pb.version, pb && pb.source);
"
```

Плейбук не проходит `validatePlaybook`, если нарушена схема; sibling-чекаут без
`playbooks/` просто пропускается, поэтому отсутствие директории в старой версии скилла
ничего не ломает.
