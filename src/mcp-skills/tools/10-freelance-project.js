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

const {
  freelanceRoot, indexPath, projectDir, projectFile, ensureDir,
  specDir, specFile, specSourcePath, legacySpecFile,
  profileGenerationNotePath, projectGenerationNotePath, SPEC_VARIANTS,
} = require('../lib/paths');
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

// ── Spec generation helpers ──────────────────────────────────────────────────

// These rules turn the output into a specification about the SYSTEM, not a recap
// of the client conversation. The old single-prompt version only forbade "клиент
// сказал" — yet the generated ТЗ still carried chronology, provenance references
// and meta-sections ("допущения и почему они здесь"), because the stage files it
// was fed were themselves written as a chronological log. The fix is two-fold:
// normalize the source first, and state the ban explicitly on every axis.
const SPEC_VOICE_RULES = [
  'Голос документа — техническое задание о СИСТЕМЕ, а не конспект общения с заказчиком.',
  'ЗАПРЕЩЕНО: «клиент сказал/подтвердил/уточнил», «заказчик хочет/прислал», «из разговора следует», хронология обсуждения, пересказ истории переписки, ссылки на провенанс/ID источников (P-001, R-04 и т.п.), мета-разделы вида «почему это здесь», «наши допущения и их основания», «что нужно подтвердить у клиента».',
  'Требования формулируй в утвердительной форме о системе: «Система должна …», «Реализовать …» — без атрибуции источника.',
  'Неподтверждённое требование выноси коротким пунктом в раздел «Открытые вопросы»; НЕ пиши «нужно подтвердить у клиента» внутри требований.',
  'Не выдумывай факты, числа, сроки, интеграции — только то, что есть в предоставленном контексте.',
].join('\n');

function readGenerationNotes(slug) {
  const read = (p) => { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return ''; } };
  return {
    profile: read(profileGenerationNotePath(USER_ID)),
    project: slug ? read(projectGenerationNotePath(USER_ID, slug)) : '',
  };
}

function writeGenerationNote(file, text, mode) {
  ensureDir(path.dirname(file));
  if (mode === 'replace') {
    fs.writeFileSync(file, String(text).trim() + '\n');
  } else {
    const prev = (() => { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; } })();
    fs.writeFileSync(file, (prev ? prev + '\n' : '') + `- ${String(text).trim()}\n`);
  }
  return fs.readFileSync(file, 'utf8').trim();
}

// `since` accepts '30m' | '2h' | '6h' | '2d' | 'today'/'сегодня' |
// 'YYYY-MM-DD..YYYY-MM-DD'. Empty/missing → last 6 hours (batch default).
function parseSince(since) {
  const now = Date.now();
  const s = String(since || '').trim().toLowerCase();
  let m;
  if (!s) return { from: now - 6 * 3600e3, to: null, label: 'последние 6 часов' };
  if ((m = s.match(/^(\d+)\s*m/))) return { from: now - (+m[1]) * 60e3, to: null, label: `последние ${m[1]} мин` };
  if ((m = s.match(/^(\d+)\s*h/))) return { from: now - (+m[1]) * 3600e3, to: null, label: `последние ${m[1]} ч` };
  if ((m = s.match(/^(\d+)\s*d/))) return { from: now - (+m[1]) * 86400e3, to: null, label: `последние ${m[1]} сут` };
  if (s === 'today' || s === 'сегодня') { const d = new Date(); d.setHours(0, 0, 0, 0); return { from: d.getTime(), to: null, label: 'за сегодня' }; }
  if ((m = s.match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/))) {
    return { from: Date.parse(`${m[1]}T00:00:00`), to: Date.parse(`${m[2]}T23:59:59`), label: `${m[1]}..${m[2]}` };
  }
  return { from: now - 6 * 3600e3, to: null, label: 'последние 6 часов', invalid: true };
}

function buildSpecInstruction(proj, variants, paths, notes) {
  const lines = [];
  lines.push(`Сгенерируй ТЗ для проекта «${proj.name}» (${variants.join(' + ')}).`);
  lines.push('');
  lines.push(`ШАГ 1 — нормализация (обязательно). По источникам ниже запиши в ${specSourcePath(USER_ID, proj.slug)} нормализованный рабочий контекст: атомарные требования (пронумеруй R-01, R-02…, в утвердительной форме о системе), факты о системе и ограничения, техническое решение. В нормализацию НЕ переноси хронологию общения, «клиент сказал», пересказ переписки и обоснования-провенанс — они остаются только в provenance/ как traceability.`);
  lines.push('');
  lines.push('ШАГ 2 — генерация. Каждый запрошенный документ генерируй НЕЗАВИСИМО из нормализованного контекста (spec/_source.md). Long и Short — самостоятельные версии из одного контекста, а НЕ «short = сжатие long»: подача и акценты могут отличаться.');
  lines.push('');
  lines.push('Правила документа (обязательно):');
  lines.push(SPEC_VOICE_RULES);
  lines.push('');
  lines.push('Варианты:');
  lines.push('- long — подробное ТЗ для исполнителя: цель, объём, функциональные и нефункциональные требования, интеграции, этапы, сроки, критерии приёмки.');
  lines.push('- short — самостоятельное краткое ТЗ для заказчика: проблема, объём, сроки, цена, ключевые риски, результат; без архитектурных деталей и без «конспекта» long.');
  lines.push('');
  lines.push('Куда писать (markdown, только эти пути, без преамбул от себя):');
  for (const v of variants) lines.push(`- ${v}: ${paths[v]}`);
  if (notes.profile || notes.project) {
    lines.push('');
    lines.push('Постоянные инструкции пользователя (приоритет над шаблоном):');
    if (notes.profile) lines.push(`[профиль] ${notes.profile}`);
    if (notes.project) lines.push(`[проект] ${notes.project}`);
  }
  return lines.join('\n');
}

// Last change to this skill's generation rules for the DEPLOYED revision. The
// rules ship with the code (built/deployed from the repo), so the current git
// commit is exactly what the generator was built from — surfacing it lets a user
// see "the prompt changed" without trusting the conversation. Best-effort: null
// when there is no git checkout (e.g. a tarball deploy).
function lastGenerationChange() {
  try {
    const { execFileSync } = require('child_process');
    const repoRoot = path.join(__dirname, '..', '..', '..');
    const out = execFileSync('git', [
      '-C', repoRoot, 'log', '-1', '--format=%h|%cs|%s', '--',
      'src/mcp-skills/tools/10-freelance-project.js',
    ], { encoding: 'utf8', timeout: 3000 }).trim();
    const [sha, date, subject] = out.split('|');
    return sha ? { sha, date, subject } : null;
  } catch {
    return null;
  }
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
        'stage=requirement — требование к системе в утвердительной форме («Система должна …»), без «клиент сказал»; даже если клиент продиктовал технические детали — это требование, не решение. Атрибуция источника остаётся в provenance.',
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
      description: [
        'Список фриланс-проектов профиля (из общего "Фриланс проекты" — видно из любого Telegram-топика/сессии этого профиля).',
        'Опционально `since` — окно по времени последнего обновления: "30m", "2h", "6h", "2d", "today"/"сегодня", либо "YYYY-MM-DD..YYYY-MM-DD".',
        'Используй for batch-запросов вида «сделай все проекты за 2 часа».',
      ].join(' '),
      inputSchema: { type: 'object', properties: {
        status: { type: 'string', enum: ['active', 'won', 'lost', 'archived'] },
        since: { type: 'string', description: 'Окно по updatedAt: 6h | 2h | today | YYYY-MM-DD..YYYY-MM-DD' },
      } },
      handler: async ({ status, since } = {}) => {
        let list = readIndex();
        if (status) list = list.filter(p => p.status === status);
        let window = null;
        if (since) {
          const w = parseSince(since);
          const to = w.to || Date.now() + 86400e3;
          list = list.filter(p => { const t = new Date(p.updatedAt || 0).getTime(); return t >= w.from && t <= to; });
          window = {
            since, label: w.label, invalid: w.invalid || undefined,
            from: new Date(w.from).toISOString(), to: w.to ? new Date(w.to).toISOString() : null,
            count: list.length,
          };
        }
        return {
          projects: list.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)),
          ...(window ? { window, message: `Проектов за ${window.label}: ${window.count}.` } : {}),
        };
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
        'Подготовить генерацию ТЗ: возвращает нормализуемый контекст проекта (facts/requirements/interpretation/solution), persistent-инструкции и пути.',
        'По умолчанию генерируются ДВА независимых документа — long.md и short.md (short НЕ является сжатием long: это самостоятельная версия из того же контекста).',
        'Сам файлы не пишет — формулировка ТЗ генеративна; модель сначала нормализует контекст в spec/_source.md, затем пишет каждый вариант по своему пути.',
        'Провенанс и qna в генерацию НЕ подаются: источники общения остаются traceability и в текст ТЗ не попадают.',
        'variants: "both" (по умолчанию) | "long" | "short" — если пользователь явно попросил только одну версию.',
      ].join(' '),
      inputSchema: { type: 'object', required: ['project_id'], properties: {
        project_id: { type: 'string' },
        variants: { type: 'string', enum: ['both', 'long', 'short'], description: 'Какие версии генерировать (по умолчанию both)' },
      } },
      handler: async ({ project_id, variants = 'both' }) => {
        const proj = readProject(project_id);
        const want = variants === 'long' ? ['long'] : variants === 'short' ? ['short'] : ['long', 'short'];
        const read = (f) => { try { return fs.readFileSync(projectFile(USER_ID, project_id, f), 'utf8'); } catch { return ''; } };
        const sources = {
          facts: read('facts.md'),
          requirements: read('requirements.md'),
          interpretation: read('interpretation.md'),
          solution: read('solution.md'),
        };
        const notes = readGenerationNotes(project_id);
        const paths = Object.fromEntries(want.map(v => [v, specFile(USER_ID, project_id, v)]));
        return {
          project_id, name: proj.name, variants: want,
          spec_source_path: specSourcePath(USER_ID, project_id),
          spec_paths: paths,
          generation_notes: notes,
          sources,
          instruction: buildSpecInstruction(proj, want, paths, notes),
        };
      },
    },

    freelance_get_spec: {
      description: [
        'Вернуть текущий текст готового ТЗ (long/short) из spec/ для ТОЧЕЧНОГО РЕДАКТИРОВАНИЯ.',
        'Используй, когда пользователь просит изменить существующий документ (убери раздел, добавь Y, перепиши блок, поменяй структуру, сделай менее формально, сократи, измени только Short, обнови обе версии).',
        'Полученный текст правь и перезаписывай по тому же пути, НЕ перегенерируя проект с нуля и НЕ восстанавливая удалённое по шаблону.',
      ].join(' '),
      inputSchema: { type: 'object', required: ['project_id'], properties: {
        project_id: { type: 'string' },
        variant: { type: 'string', enum: ['both', 'long', 'short'], description: 'Что вернуть (по умолчанию both)' },
      } },
      handler: async ({ project_id, variant = 'both' }) => {
        readProject(project_id);
        const want = variant === 'long' ? ['long'] : variant === 'short' ? ['short'] : ['long', 'short'];
        const docs = {}; const paths = {};
        for (const v of want) {
          const p = specFile(USER_ID, project_id, v);
          let text = '';
          try { text = fs.readFileSync(p, 'utf8'); } catch { /* not generated yet */ }
          if (!text && v === 'long') {
            // read-compat: the old single-document pipeline wrote spec/tz.md
            try { text = fs.readFileSync(legacySpecFile(USER_ID, project_id), 'utf8'); } catch { /* none */ }
          }
          docs[v] = text; paths[v] = p;
        }
        return {
          project_id, docs, spec_paths: paths,
          instruction: 'Правь существующий текст по указанию пользователя и перезапиши его по ТОМУ ЖЕ пути через Write. ' +
            'Пользовательская правка имеет приоритет над шаблоном: если просят убрать раздел — не восстанавливай его. ' +
            'Не перегенерируй документ целиком без явной просьбы; не добавляй того, о чём не просили.',
        };
      },
    },

    freelance_generation_note: {
      description: [
        'Сохранить ПОСТОЯННУЮ инструкцию генерации ТЗ — она действует на все СЛЕДУЮЩИЕ генерации.',
        'Без project_id — для всего профиля; с project_id — только для проекта (приоритет выше профиля).',
        'Примеры: «всегда делай ТЗ техничнее», «никогда не писать „клиент сказал"», «не добавлять раздел X», «Short — максимально компактный».',
        'Это НЕ разовая правка конкретного документа — для разовой используй freelance_get_spec.',
      ].join(' '),
      inputSchema: { type: 'object', required: ['text'], properties: {
        text: { type: 'string', description: 'Инструкция пользователя' },
        project_id: { type: 'string', description: 'Если задан — инструкция только для проекта' },
        mode: { type: 'string', enum: ['append', 'replace'], description: 'append (по умолчанию) добавляет пункт; replace перезаписывает' },
      } },
      handler: async ({ text, project_id, mode = 'append' }) => {
        if (project_id) readProject(project_id);
        const file = project_id ? projectGenerationNotePath(USER_ID, project_id) : profileGenerationNotePath(USER_ID);
        const note = writeGenerationNote(file, text, mode);
        return { saved: true, scope: project_id || 'profile', path: file, note };
      },
    },

    freelance_generate_all: {
      description: [
        'Batch: собрать проекты за период (по умолчанию — за последние 6 часов) и подготовить генерацию ТЗ для каждого.',
        'Порядок ответа пользователю: сначала ОДНОЙ таблицей показать проекты с краткой оценкой/рисками, затем по каждому проекту сгенерировать запрошенные версии.',
        'variants применяется ко всем; для исключений («Long только для проекта X») вызови freelance_generate_spec отдельно по нужному проекту.',
        'Другой период — повторить вызов с другим since.',
      ].join(' '),
      inputSchema: { type: 'object', properties: {
        since: { type: 'string', description: '6h (по умолчанию) | 2h | today | YYYY-MM-DD..YYYY-MM-DD' },
        variants: { type: 'string', enum: ['both', 'long', 'short'] },
      } },
      handler: async ({ since, variants = 'both' } = {}) => {
        const w = parseSince(since);
        const to = w.to || Date.now() + 86400e3;
        const list = readIndex().filter(p => { const t = new Date(p.updatedAt || 0).getTime(); return t >= w.from && t <= to; });
        const want = variants === 'long' ? ['long'] : variants === 'short' ? ['short'] : ['long', 'short'];
        const projects = list
          .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
          .map(p => ({
            project_id: p.slug, name: p.name, status: p.status, type: p.type, updatedAt: p.updatedAt,
            spec_paths: Object.fromEntries(want.map(v => [v, specFile(USER_ID, p.slug, v)])),
          }));
        const label = w.invalid ? `${w.label} (период не распознан — по умолчанию)` : w.label;
        return {
          window: { since: since || null, label, from: new Date(w.from).toISOString(), to: w.to ? new Date(w.to).toISOString() : null, count: projects.length },
          variants: want,
          projects,
          message: `Взял проекты за ${label}. Если нужен другой период — скажи.`,
          instruction:
            `Сначала покажи ОДНОЙ таблицей ${projects.length} проект(ов) за ${label} с краткой оценкой/рисками. ` +
            `Затем по каждому проекту сгенерируй ${want.join(' + ')} по правилам freelance_generate_spec (сначала нормализация, затем каждая версия независимо).`,
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

    freelance_spec_generation_defaults: {
      description: [
        'Показать текущие настройки/дефолты генерации ТЗ: формат вывода, какие версии генерируются, что по запросу,',
        'persistent-инструкции профиля и проекта, и последнее изменение правил генерации.',
        'Это команда только для чтения — ничего не меняет.',
      ].join(' '),
      inputSchema: { type: 'object', properties: { project_id: { type: 'string' } } },
      handler: async ({ project_id } = {}) => {
        if (project_id) readProject(project_id);
        const notes = readGenerationNotes(project_id);
        const lc = lastGenerationChange();
        const defaults = {
          output_format: 'только markdown (.md)',
          variants: 'длинная (long) + короткая (short) по каждому проекту',
          independence: 'long и short генерируются независимо (short — не сжатие long)',
          on_request: 'риски и input-требования (source-requirements) — по запросу',
          normalization: 'source → spec/_source.md (нормализация требований)',
          batch_window: 'по умолчанию 6 часов',
          forbidden_in_spec: '«клиент сказал», хронология, провенанс, мета-разделы',
        };
        const lines = [
          '⚙️ Настройки генерации ТЗ (текущее)',
          '',
          `• Формат: ${defaults.output_format}`,
          `• Версии: ${defaults.variants}`,
          `• ${defaults.independence}`,
          `• По запросу: ${defaults.on_request}`,
          `• Нормализация: ${defaults.normalization}`,
          `• Batch: ${defaults.batch_window}`,
          `• В ТЗ запрещено: ${defaults.forbidden_in_spec}`,
          '',
          'Постоянные инструкции пользователя:',
          `• профиль: ${notes.profile || '(нет)'}`,
          `• проект: ${notes.project || '(нет)'}`,
          '',
          lc ? `Последнее изменение правил генерации: ${lc.sha} (${lc.date}) — ${lc.subject}` : 'Последнее изменение правил: нет данных (не git-чек).',
        ].join('\n');
        return { defaults, notes, last_change: lc, paths: {
          profile: profileGenerationNotePath(USER_ID),
          project: project_id ? projectGenerationNotePath(USER_ID, project_id) : null,
        }, text: lines };
      },
    },

    freelance_spec_generation_explained: {
      description: 'Объяснить, как работает генерация ТЗ: пайплайн, нормализация, независимые long/short, persistent-инструкции, правки, batch, и последнее изменение правил.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const lc = lastGenerationChange();
        const text = [
          '📄 Как работает генерация ТЗ',
          '',
          '1. Источники (диалог, файлы, скриншоты) → provenance/log.jsonl: это traceability, в текст ТЗ не попадает.',
          '2. Факты/требования/интерпретация/решение → requirements — атомарные требования «Система должна …».',
          '3. Нормализация → spec/_source.md: единый вход для обеих версий.',
          '4. Генерация: long.md (для исполнителя) и short.md (для заказчика) — НЕЗАВИСИМО из одного контекста; short — не сжатие long.',
          '5. В ТЗ нет «клиент сказал», хронологии, провенанса и мета-разделов; неподтверждённое — в «Открытые вопросы».',
          '',
          'Постоянные инструкции (действуют на все следующие генерации):',
          '• профиль → Фриланс проекты/_generation.md',
          '• проект → <project>/generation.md (приоритет выше)',
          'Добавить: скажи боту словами («запомни: всегда делай ТЗ техничнее») или командой.',
          '',
          'Точечные правки (убери раздел, сократи, измени только Short) — правят существующий long.md/short.md, без перегенерации.',
          'Batch («сделай все проекты») — за окно по умолчанию 6 часов + таблица проектов/рисков.',
          '',
          'Правила генерации версионируются в репозитории и собираются при деплое (CI/CD), поэтому изменения видны как diff.',
          lc ? `Последнее изменение правил: ${lc.sha} (${lc.date}) — ${lc.subject}` : 'Последнее изменение правил: нет данных (не git-чек).',
          '',
          'Детали: https://github.com/trained-assist/trained-assist-freelance-skill',
        ].join('\n');
        return { explanation: text, last_change: lc, text };
      },
    },

  },
};
