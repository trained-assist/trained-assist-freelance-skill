'use strict';

// Freelance project intake & analysis — multi-project store at the PROFILE ROOT
// (never process.cwd(), which is a per-Telegram-topic folder picked by the bot
// before the session starts — see lib/paths.js for why).
//
// Pipeline enforced by file boundaries, not just convention:
//   RAW INPUT -> provenance/log.jsonl -> facts.md -> requirements.md
//             -> interpretation.md -> solution.md -> spec/tz.md
// `freelance_add_info` writes to exactly one of these per call (the `stage`
// argument), so a caller can't casually blend "заказчик сказал" into solution.md.
//
// Tools: freelance_new_project | freelance_add_info | freelance_assess |
//        freelance_questions | freelance_list | freelance_get_project |
//        freelance_generate_spec | freelance_set_folder

const fs = require('fs');
const path = require('path');

const USER_ID = process.env.USER_ID || process.env.AGENT_USER_ID || '';

const { freelanceRoot, indexPath, projectDir, projectFile, ensureDir } = require('../lib/paths');
const { slugify } = require('../lib/slug');
const riskEngine = require('../lib/risk-engine');
const sheets = require('../lib/sheets');
const { withLock } = require('../lib/with-lock');

// Cross-process serialization for the shared profile-wide _index.json. Multiple
// provider children of the same profile can run concurrently under the managed
// Control Plane adapter (#1271 §18) — a plain read-modify-write loses updates.
// The lock lives next to the index file so it is per-profile, not per-process.
function indexLock() {
  return path.join(freelanceRoot(USER_ID), '._index.lock');
}

// ── Index (profile-wide project registry) ──────────────────────────────────

function readIndex() {
  const f = indexPath(USER_ID);
  if (!fs.existsSync(f)) return [];
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return []; }
}

function writeIndex(list) {
  const f = indexPath(USER_ID);
  ensureDir(path.dirname(f));
  // Atomic-ish: write temp then rename so a concurrent reader never sees a torn file.
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, f);
}

function upsertIndexEntry(entry) {
  return withLock(indexLock(), () => {
    const list = readIndex();
    const i = list.findIndex(p => p.id === entry.id);
    if (i >= 0) list[i] = { ...list[i], ...entry };
    else list.push(entry);
    writeIndex(list);
  });
}

// ── Project record ──────────────────────────────────────────────────────────

function readProject(slug) {
  const f = projectFile(USER_ID, slug, 'project.json');
  if (!fs.existsSync(f)) throw new Error(`Проект не найден: ${slug}. Список: freelance_list`);
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

function saveProject(proj) {
  proj.updatedAt = new Date().toISOString();
  fs.writeFileSync(projectFile(USER_ID, proj.slug, 'project.json'), JSON.stringify(proj, null, 2));
  upsertIndexEntry({
    id: proj.slug, slug: proj.slug, name: proj.name, status: proj.status,
    type: proj.type, createdAt: proj.createdAt, updatedAt: proj.updatedAt,
  });
  return proj;
}

function uniqueSlug(base) {
  let slug = base, n = 2;
  while (fs.existsSync(projectDir(USER_ID, slug))) { slug = `${base}-${n}`; n += 1; }
  return slug;
}

const STAGE_FILES = {
  fact: 'facts.md',
  requirement: 'requirements.md',
  interpretation: 'interpretation.md',
  solution: 'solution.md',
  qna: 'qna.md',
};

function scaffoldProject(slug, name, type) {
  const dir = projectDir(USER_ID, slug);
  ensureDir(dir);
  ensureDir(path.join(dir, 'provenance', 'raw'));
  ensureDir(path.join(dir, 'spec', 'exports'));

  const stub = (title, hint) => `# ${title} — ${name}\n\n_${hint}_\n`;
  const writeIfMissing = (file, content) => { if (!fs.existsSync(file)) fs.writeFileSync(file, content); };

  writeIfMissing(path.join(dir, 'facts.md'),
    stub('Факты проекта', 'Только проверяемые факты, каждый со ссылкой на источник вида [P-001]. Не сюда: требования клиента, наше мнение, техническое решение.'));
  writeIfMissing(path.join(dir, 'requirements.md'),
    stub('Требования клиента', 'Только то, что хочет/требует/ограничивает клиент — включая технические детали, если их продиктовал сам клиент. Никакой архитектуры здесь.\n\n## Открытые вопросы\n'));
  writeIfMissing(path.join(dir, 'interpretation.md'),
    stub('Наша интерпретация', 'Наши допущения и то, что мы понимаем "между строк" — явно помечено как неподтверждённое до ответа клиента.'));
  writeIfMissing(path.join(dir, 'solution.md'),
    stub('Техническое решение', 'Только наша инженерная часть — компоненты, data flow, API, БД, деплой. Ссылки на требования вида [R-04], без "клиент сказал".'));
  writeIfMissing(path.join(dir, 'qna.md'),
    stub('Вопросы и ответы', 'Вопрос / ответ / дата, со ссылкой на требование, которое он закрывает.'));
  writeIfMissing(path.join(dir, 'provenance', 'log.jsonl'), '');
  writeIfMissing(path.join(dir, 'spec', 'tz.md'), '');

  return dir;
}

function appendProvenance(slug, entry) {
  const file = projectFile(USER_ID, slug, 'provenance', 'log.jsonl');
  const id = `P-${String(Date.now()).slice(-9)}`;
  const rec = { id, at: new Date().toISOString(), ...entry };
  fs.appendFileSync(file, JSON.stringify(rec) + '\n');
  return rec;
}

function appendStageContent(slug, stage, content, provenanceId) {
  const file = projectFile(USER_ID, slug, STAGE_FILES[stage]);
  const date = new Date().toISOString().slice(0, 10);
  const cite = provenanceId ? ` [${provenanceId}]` : '';
  fs.appendFileSync(file, `\n- (${date})${cite} ${content}\n`);
}

// ── Risk assessment (unchanged deterministic engine, relocated per-project) ──

async function runAndSaveAssessment(proj) {
  const assessment = {
    ...riskEngine.computeRisk(proj.signals, proj.projectInfo, proj.type),
    openQuestions: riskEngine.getOpenQuestions(proj.signals, proj.projectInfo, proj.type),
    assessedAt: new Date().toISOString(),
  };
  proj.lastAssessment = assessment;

  const raFile = projectFile(USER_ID, proj.slug, 'risk-assessment.json');
  fs.writeFileSync(raFile, JSON.stringify({ signals: proj.signals, projectInfo: proj.projectInfo, ...assessment }, null, 2));

  if (proj.spreadsheetId) {
    const sa = sheets.readSa(USER_ID);
    if (sa) {
      try {
        await sheets.writeTab(proj.spreadsheetId, 'Итог', buildSummaryTab(proj, assessment), sa);
        await sheets.writeTab(proj.spreadsheetId, 'Риски', buildRisksTab(assessment), sa);
        await sheets.writeTab(proj.spreadsheetId, 'План проекта', buildPlanTab(proj), sa);
      } catch (e) {
        assessment._sheetWriteError = e.message;
      }
    }
  }

  saveProject(proj);
  return assessment;
}

function sig(v) { return v === true ? '✅ Да' : v === false ? '❌ Нет' : '❓ Неизвестно'; }

function buildSummaryTab(proj, a) {
  const ts = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
  const rows = [
    [`ОЦЕНКА ПРОЕКТА: ${proj.name}`], [],
    ['ВЕРДИКТ', a.verdict], [],
    ['Slug:', proj.slug], ['Тип:', proj.type], ['Обновлено:', ts], [],
    ['УРОВЕНЬ РИСКА', a.level, `Оценка: ${a.score}/10`], [],
  ];
  for (const f of riskEngine.factorsForType(proj.type)) rows.push([f.label.replace('Нет ', '').replace(' не сформулирован', ''), sig(proj.signals[f.key])]);
  rows.push([], ['Открытых вопросов:', a.openQuestions.length]);
  return rows;
}

function buildRisksTab(a) {
  const rows = [[`Уровень риска: ${a.level} | Оценка: ${a.score}/10`], [], ['Фактор риска', 'Вес', 'Вопрос', 'Почему важно'], []];
  for (const r of a.risks) rows.push([r.factor, String(r.weight), r.question || '—', r.why || '']);
  return rows;
}

function buildPlanTab(proj) {
  const plan = riskEngine.PLANS[proj.type] || riskEngine.PLANS.default;
  const rows = [[`ПЛАН: ${proj.name}`], [], ['Фаза', 'Задачи', 'Дней', 'Статус'], []];
  for (const p of plan) rows.push([p.phase, p.tasks, p.days, 'планируется']);
  return rows;
}

// ── Tools ──────────────────────────────────────────────────────────────────

module.exports = {
  isReady: () => true,

  tools: {

    freelance_new_project: {
      description: [
        'Создать новый фриланс-проект в общем хранилище "Фриланс проекты" (уровень профиля, не привязан к текущему Telegram-топику).',
        'Создаёт папку проекта со скелетом pipeline-файлов (facts.md/requirements.md/interpretation.md/solution.md/qna.md/provenance/).',
        'Тип "academic" — для проектов без клиентских отношений (фиксированный объём работы, нет заказчика/цены/дедлайна в обычном смысле, см. Sample B в README).',
        'Для остальных типов сразу запускает GO/NO-GO risk-оценку. Проверяет дубликаты по имени — если проект уже есть, вернёт его id вместо создания второго.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        required: ['name', 'description'],
        properties: {
          name: { type: 'string', description: 'Название проекта (как удобно человеку, не обязательно slug-safe)' },
          description: { type: 'string', description: 'Всё что известно на этом этапе — попадёт в facts.md как первая запись' },
          type: { type: 'string', enum: ['ai_simple', 'integration', 'ecommerce', 'medtech', 'academic', 'default'], description: 'Тип проекта — влияет на риск-модель и шаблон плана' },
          source: { type: 'string', description: 'Провенанс исходного описания: chat/file/voice/screenshot/forwarded' },
          reliability: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Насколько надёжен источник (по умолчанию medium)' },
          force_new: { type: 'boolean', description: 'Создать новый, даже если проект с таким именем уже существует' },
        },
      },
      handler: async ({ name, description, type = 'default', source = 'chat', reliability = 'medium', force_new = false }) => {
        return withLock(indexLock(), async () => {
          if (!force_new) {
            const nameKey = String(name).trim().toLowerCase();
            const dupe = readIndex().find(p => String(p.name || '').trim().toLowerCase() === nameKey);
            if (dupe) {
              return {
                duplicate: true, project_id: dupe.slug, name: dupe.name,
                message: `⚠️ Проект «${dupe.name}» уже существует (${dupe.slug}) — новый не создан. ` +
                  `Используй freelance_add_info(project=${dupe.slug}, ...) чтобы дополнить, либо force_new:true если это осознанно другой проект.`,
              };
            }
          }

          const slug = uniqueSlug(slugify(name));
          scaffoldProject(slug, name, type);

          const proj = {
            slug, name, type, status: 'active',
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
            signals: riskEngine.defaultSignals(type),
            projectInfo: { integrationCount: null, hasMVP: null },
            spreadsheetId: null, spreadsheetUrl: null,
            lastAssessment: null,
          };
          saveProject(proj);

          const prov = appendProvenance(slug, { source, raw_excerpt: description.slice(0, 2000), reliability, note: 'initial intake' });
          appendStageContent(slug, 'fact', description, prov.id);

          const assessment = type === 'academic' ? null : await runAndSaveAssessment(proj);

          return {
            project_id: slug,
            name,
            type,
            path: `Фриланс проекты/${slug}/`,
            verdict: assessment?.verdict || 'Тип academic — риск-модель клиентских отношений не применяется, см. requirements.md/solution.md напрямую.',
            risk_level: assessment?.level || null,
            risk_score: assessment?.score ?? null,
            open_questions: assessment?.openQuestions?.slice(0, 5).map((q, i) => `${i + 1}. ${q.question}`) || [],
            message: `✅ Проект создан: ${slug}. Скелет pipeline создан в "Фриланс проекты/${slug}/". ` +
              (assessment ? `Вердикт: ${assessment.verdict}` : 'Тип academic — заполняй requirements.md/solution.md напрямую.'),
          };
        });
      },
    },

    freelance_add_info: {
      description: [
        'Добавить информацию к проекту в ОДНУ конкретную стадию pipeline — это то, что не даёт фактам/требованиям/решению смешаться.',
        'stage=fact — только проверяемый факт (авто-логируется в provenance с указанным source/reliability).',
        'stage=requirement — то, что хочет/требует клиент (даже если он продиктовал технические детали — это всё ещё требование, не решение).',
        'stage=interpretation — наше предположение, ещё не подтверждённое клиентом.',
        'stage=solution — ТОЛЬКО наша инженерная часть, без "клиент сказал".',
        'stage=qna — вопрос/ответ клиента.',
        'Signals (hasTZ, prepaymentReady и т.д.) можно передать любым вызовом — пересчитает риск-оценку.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        required: ['project_id', 'stage', 'content'],
        properties: {
          project_id: { type: 'string' },
          stage: { type: 'string', enum: ['fact', 'requirement', 'interpretation', 'solution', 'qna'] },
          content: { type: 'string' },
          source: { type: 'string', description: 'Только для stage=fact: chat/file/voice/screenshot/forwarded' },
          reliability: { type: 'string', enum: ['high', 'medium', 'low'] },
          contradicts: { type: 'string', description: 'ID предыдущего provenance-факта, которому это противоречит (не перезаписывать молча — фиксировать конфликт)' },
          hasTZ: { type: 'boolean' }, valueClear: { type: 'boolean' }, clientSeesResult: { type: 'boolean' },
          clientAnsweredQuestions: { type: 'boolean' }, hasValueWording: { type: 'boolean' }, prepaymentReady: { type: 'boolean' },
          hasClearDeadline: { type: 'boolean' }, budgetConfirmed: { type: 'boolean' },
          scopeUnambiguous: { type: 'boolean' }, deliveryAgreed: { type: 'boolean' }, priceAgreed: { type: 'boolean' },
          integrationCount: { type: 'number' }, hasMVP: { type: 'boolean' },
        },
      },
      handler: async ({ project_id, stage, content, source = 'chat', reliability = 'medium', contradicts, ...rest }) => {
        const proj = readProject(project_id);

        let provId = null;
        if (stage === 'fact') {
          const prov = appendProvenance(project_id, { source, raw_excerpt: content.slice(0, 2000), reliability, contradicts: contradicts ? [contradicts] : [] });
          provId = prov.id;
        }
        appendStageContent(project_id, stage, content, provId);

        for (const k of Object.keys(proj.signals)) if (rest[k] !== undefined) proj.signals[k] = rest[k];
        if (rest.integrationCount !== undefined) proj.projectInfo.integrationCount = rest.integrationCount;
        if (rest.hasMVP !== undefined) proj.projectInfo.hasMVP = rest.hasMVP;

        const assessment = await runAndSaveAssessment(proj);

        return {
          added: true, project_id, stage, provenance_id: provId,
          risk_score: assessment.score, risk_level: assessment.level,
          open_questions_count: assessment.openQuestions.length,
          message: `Добавлено в ${STAGE_FILES[stage]}${provId ? ` (provenance ${provId})` : ''}. Риск: ${assessment.level} (${assessment.score}/10).`,
        };
      },
    },

    freelance_assess: {
      description: 'Пересчитать GO/NO-GO риск-оценку и (если настроен Google Sheet) обновить вкладки. Вызывай после серии freelance_add_info, либо когда просто нужен свежий вердикт.',
      inputSchema: { type: 'object', required: ['project_id'], properties: { project_id: { type: 'string' }, folder_id: { type: 'string' }, spreadsheet_id: { type: 'string' } } },
      handler: async ({ project_id, folder_id, spreadsheet_id }) => {
        const proj = readProject(project_id);
        const sa = sheets.readSa(USER_ID);

        if (!proj.spreadsheetId && sa) {
          if (spreadsheet_id) {
            proj.spreadsheetId = spreadsheet_id;
            proj.spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheet_id}`;
          } else if (folder_id) {
            try {
              const s = await sheets.createSpreadsheet(`Оценка: ${proj.name}`, ['Итог', 'Риски', 'План проекта'], sa, folder_id);
              proj.spreadsheetId = s.id; proj.spreadsheetUrl = s.url;
            } catch (e) { proj._sheetError = e.message; }
          }
        }

        const assessment = await runAndSaveAssessment(proj);
        return {
          project_id, name: proj.name, verdict: assessment.verdict,
          risk_score: assessment.score, risk_level: assessment.level,
          top_risks: assessment.risks.slice(0, 3).map(r => r.factor),
          open_questions: assessment.openQuestions.slice(0, 5).map((q, i) => `${i + 1}. ${q.question}`),
          spreadsheet_url: proj.spreadsheetUrl || null,
          message: `Вердикт: ${assessment.verdict}\nРиск: ${assessment.level} (${assessment.score}/10).`,
        };
      },
    },

    freelance_questions: {
      description: 'Открытые вопросы для клиента по проекту (HIGH — сигнал явно false, MEDIUM — неизвестен).',
      inputSchema: { type: 'object', required: ['project_id'], properties: { project_id: { type: 'string' } } },
      handler: async ({ project_id }) => {
        const proj = readProject(project_id);
        const qs = riskEngine.getOpenQuestions(proj.signals, proj.projectInfo, proj.type);
        return { project_id, name: proj.name, questions: qs.map((q, i) => ({ n: i + 1, ...q })), total: qs.length };
      },
    },

    freelance_list: {
      description: 'Список всех фриланс-проектов профиля (из общего "Фриланс проекты" — видно из любого Telegram-топика/сессии этого профиля).',
      inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['active', 'won', 'lost', 'archived'] } } },
      handler: async ({ status } = {}) => {
        let list = readIndex();
        if (status) list = list.filter(p => p.status === status);
        return { projects: list.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)) };
      },
    },

    freelance_get_project: {
      description: [
        'Полный контекст проекта для восстановления работы в новой сессии: facts/requirements/interpretation/solution/qna + текущая риск-оценка.',
        'Вызывай это в начале работы над проектом в любой новой сессии/топике вместо того чтобы полагаться на память чата.',
      ].join(' '),
      inputSchema: { type: 'object', required: ['project_id'], properties: { project_id: { type: 'string' } } },
      handler: async ({ project_id }) => {
        const proj = readProject(project_id);
        const read = (f) => { try { return fs.readFileSync(projectFile(USER_ID, project_id, f), 'utf8'); } catch { return ''; } };
        return {
          project: proj,
          facts: read('facts.md'),
          requirements: read('requirements.md'),
          interpretation: read('interpretation.md'),
          solution: read('solution.md'),
          qna: read('qna.md'),
        };
      },
    },

    freelance_generate_spec: {
      description: [
        'Вернуть requirements.md + solution.md для генерации spec/tz.md — НИКОГДА не читай raw provenance/facts напрямую для текста ТЗ.',
        'После получения ответа сформируй итоговый текст ТЗ и запиши его через Write в путь spec_path из ответа — этот тул сам файл не пишет,',
        'т.к. формулировка ТЗ — генеративная задача, а не механическая склейка.',
      ].join(' '),
      inputSchema: { type: 'object', required: ['project_id'], properties: { project_id: { type: 'string' } } },
      handler: async ({ project_id }) => {
        const proj = readProject(project_id);
        const requirements = fs.readFileSync(projectFile(USER_ID, project_id, 'requirements.md'), 'utf8');
        const solution = fs.readFileSync(projectFile(USER_ID, project_id, 'solution.md'), 'utf8');
        return {
          project_id, name: proj.name,
          requirements, solution,
          spec_path: projectFile(USER_ID, project_id, 'spec', 'tz.md'),
          instruction: 'Сгенерируй итоговый клиентский документ ТЗ ИСКЛЮЧИТЕЛЬНО из requirements + solution выше. ' +
            'Не упоминай происхождение информации ("клиент сказал", "из документа X") — это provenance, в ТЗ ему не место. ' +
            'Запиши результат по пути spec_path.',
        };
      },
    },

    freelance_set_folder: {
      description: 'Установить папку Google Drive для таблиц фриланс-проектов этого профиля (используется всеми новыми проектами).',
      inputSchema: { type: 'object', required: ['folder_id'], properties: { folder_id: { type: 'string' } } },
      handler: async ({ folder_id }) => {
        const f = path.join(freelanceRoot(USER_ID), '_classifier', 'drive-folder.json');
        ensureDir(path.dirname(f));
        fs.writeFileSync(f, JSON.stringify({ folder_id, updated_at: new Date().toISOString() }, null, 2));
        return { saved: true, folder_id };
      },
    },

  },
};
