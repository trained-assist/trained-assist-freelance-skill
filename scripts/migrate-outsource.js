#!/usr/bin/env node
'use strict';

// One-shot migration: legacy outsource-projects/<id>.json (from trained-assist-agent's
// 94-outsource-project.js, per-topic <workDir>/outsource-projects/*.json) → the skill's
// profile-root multi-project store (<USERS_DIR>/<profile>/Фриланс проекты/<slug>/).
//
// Usage:
//   node scripts/migrate-outsource.js --profile <profile> [--users-dir <dir>] [--dry-run]
//
// Finds all <USERS_DIR>/<profile>/projects/*/outsource-projects/*.json, converts each
// into a freelance project (facts/requirements/qna from description + infoChunks + qaLog,
// signals carried over, risk reassessed with the current deterministic engine), writes the
// originals into provenance/raw/ verbatim, and registers the projects in _index.json.
// Idempotent: a project whose name already exists in _index.json is skipped.

const fs = require('fs');
const path = require('path');
const os = require('os');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--profile' || a === '--users-dir') args[a.slice(2)] = process.argv[++i];
  else if (a === '--dry-run') args['dry-run'] = true;
}

const USERS_DIR = args['users-dir'] || process.env.USERS_DIR || path.join(os.homedir(), 'users');
const PROFILE = args.profile;
const DRY_RUN = !!args['dry-run'];

if (!PROFILE) {
  console.error('Usage: node scripts/migrate-outsource.js --profile <profile> [--users-dir <dir>] [--dry-run]');
  process.exit(1);
}

const { freelanceRoot, indexPath, projectDir, projectFile, ensureDir } = require('../src/mcp-skills/lib/paths');
const { slugify } = require('../src/mcp-skills/lib/slug');
const riskEngine = require('../src/mcp-skills/lib/risk-engine');

process.env.USER_ID = PROFILE;

// ── Helpers mirroring 10-freelance-project.js ─────────────────────────────────

function readIndex() {
  const f = indexPath(PROFILE);
  if (!fs.existsSync(f)) return [];
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return []; }
}

function writeIndex(list) {
  const f = indexPath(PROFILE);
  ensureDir(path.dirname(f));
  fs.writeFileSync(f, JSON.stringify(list, null, 2));
}

function uniqueSlug(base) {
  let slug = base, n = 2;
  while (fs.existsSync(projectDir(PROFILE, slug))) { slug = `${base}-${n}`; n += 1; }
  return slug;
}

function scaffoldProject(slug, name, type) {
  const dir = projectDir(PROFILE, slug);
  ensureDir(dir);
  ensureDir(path.join(dir, 'provenance', 'raw'));
  ensureDir(path.join(dir, 'spec', 'exports'));
  const stub = (title, hint) => `# ${title} — ${name}\n\n_${hint}_\n`;
  const writeIfMissing = (file, content) => { if (!fs.existsSync(file)) fs.writeFileSync(file, content); };
  writeIfMissing(path.join(dir, 'facts.md'), stub('Факты проекта', 'Только проверяемые факты, каждый со ссылкой на источник вида [P-001].'));
  writeIfMissing(path.join(dir, 'requirements.md'), stub('Требования клиента', 'Только то, что хочет/требует клиент. Никакой архитектуры здесь.\n\n## Открытые вопросы\n'));
  writeIfMissing(path.join(dir, 'interpretation.md'), stub('Наша интерпретация', 'Наши допущения, явно помеченные как неподтверждённые.'));
  writeIfMissing(path.join(dir, 'solution.md'), stub('Техническое решение', 'Только наша инженерная часть. Ссылки на требования вида [R-04].'));
  writeIfMissing(path.join(dir, 'qna.md'), stub('Вопросы и ответы', 'Вопрос / ответ / дата, со ссылкой на требование, которое он закрывает.'));
  writeIfMissing(path.join(dir, 'provenance', 'log.jsonl'), '');
  writeIfMissing(path.join(dir, 'spec', 'tz.md'), '');
  return dir;
}

function appendProvenance(slug, entry) {
  const file = projectFile(PROFILE, slug, 'provenance', 'log.jsonl');
  const id = `P-${String(Date.now()).slice(-9)}`;
  const rec = { id, at: new Date().toISOString(), ...entry };
  fs.appendFileSync(file, JSON.stringify(rec) + '\n');
  return rec;
}

function appendStage(slug, stage, content, provId, date) {
  const file = projectFile(PROFILE, slug, {
    fact: 'facts.md', requirement: 'requirements.md', interpretation: 'interpretation.md',
    solution: 'solution.md', qna: 'qna.md',
  }[stage]);
  const d = date ? new Date(date).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  const cite = provId ? ` [${provId}]` : '';
  fs.appendFileSync(file, `\n- (${d})${cite} ${content}\n`);
}

// ── Migration ─────────────────────────────────────────────────────────────────

const profileRoot = path.join(USERS_DIR, PROFILE);
const projectsGlob = path.join(profileRoot, 'projects', '*', 'outsource-projects', '*.json');
const legacyFiles = [];
(function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.isFile() && e.name.endsWith('.json') && full.includes(path.sep + 'outsource-projects' + path.sep)) {
      legacyFiles.push(full);
    }
  }
})(profileRoot);

if (legacyFiles.length === 0) {
  console.log(`No legacy outsource-projects found under ${profileRoot}`);
  process.exit(0);
}

console.log(`Profile: ${PROFILE}\nUsers dir: ${USERS_DIR}\nFound ${legacyFiles.length} legacy project file(s)\n`);

const index = readIndex();
const existingNames = new Set(index.map(p => String(p.name || '').trim().toLowerCase()));
let created = 0, skipped = 0;

for (const legacyPath of legacyFiles.sort()) {
  let legacy;
  try { legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf8')); }
  catch (e) { console.error(`✗ ${path.basename(legacyPath)}: unreadable — ${e.message}`); skipped++; continue; }

  const name = legacy.name || path.basename(legacyPath, '.json');
  const nameKey = String(name).trim().toLowerCase();
  if (existingNames.has(nameKey)) {
    console.log(`- skip ${name} (already in index)`);
    skipped++;
    continue;
  }

  const type = ['ai_simple', 'integration', 'ecommerce', 'medtech', 'academic', 'default'].includes(legacy.type)
    ? legacy.type : 'default';
  const slug = uniqueSlug(slugify(name));
  console.log(`\n→ ${name}\n  type=${type} slug=${slug}`);

  if (DRY_RUN) { created++; continue; }

  scaffoldProject(slug, name, type);

  const proj = {
    slug, name, type, status: 'active',
    createdAt: legacy.createdAt || new Date().toISOString(),
    updatedAt: legacy.updatedAt || new Date().toISOString(),
    signals: riskEngine.defaultSignals(type),
    projectInfo: { integrationCount: null, hasMVP: null },
    spreadsheetId: legacy.spreadsheetId || null,
    spreadsheetUrl: legacy.spreadsheetUrl || null,
    lastAssessment: null,
  };

  // Carried-over signals (only keys the risk engine knows for this type).
  for (const k of Object.keys(proj.signals)) {
    if (legacy.signals && legacy.signals[k] !== undefined) proj.signals[k] = legacy.signals[k];
  }
  if (legacy.projectInfo) {
    if (legacy.projectInfo.integrationCount != null) proj.projectInfo.integrationCount = legacy.projectInfo.integrationCount;
    if (legacy.projectInfo.hasMVP != null) proj.projectInfo.hasMVP = legacy.projectInfo.hasMVP;
  }

  // Original JSON preserved verbatim.
  const rawDir = projectFile(PROFILE, slug, 'provenance', 'raw');
  ensureDir(rawDir);
  const rawName = path.basename(legacyPath);
  fs.writeFileSync(path.join(rawDir, rawName), JSON.stringify(legacy, null, 2));

  // description → first fact (+ provenance).
  if (legacy.description) {
    const prov = appendProvenance(slug, { source: 'legacy-outsource', raw_excerpt: legacy.description.slice(0, 2000), reliability: 'medium', note: `migrated from ${rawName}` });
    appendStage(slug, 'fact', legacy.description.trim(), prov.id, legacy.createdAt);
  }

  // infoChunks → stage by type.
  const STAGE_BY_INFO_TYPE = {
    tz: 'requirement', client_answer: 'qna', negotiation: 'fact', team_info: 'fact', other: 'fact',
  };
  for (const c of legacy.infoChunks || []) {
    const stage = STAGE_BY_INFO_TYPE[c.type] || 'fact';
    appendStage(slug, stage, c.content, null, c.addedAt);
  }

  // qaLog → qna.md.
  for (const qa of legacy.qaLog || []) {
    appendStage(slug, 'qna', `Вопрос: ${qa.question}\nОтвет: ${qa.answer}`, null, qa.addedAt);
  }

  // Reassess with the current engine (types differ slightly from legacy).
  const assessment = riskEngine.computeRisk(proj.signals, proj.projectInfo, type);
  const openQuestions = riskEngine.getOpenQuestions(proj.signals, proj.projectInfo, type);
  proj.lastAssessment = { ...assessment, openQuestions, assessedAt: new Date().toISOString() };

  const raFile = projectFile(PROFILE, slug, 'risk-assessment.json');
  fs.writeFileSync(raFile, JSON.stringify({ signals: proj.signals, projectInfo: proj.projectInfo, ...assessment, openQuestions, assessedAt: proj.lastAssessment.assessedAt }, null, 2));

  fs.writeFileSync(projectFile(PROFILE, slug, 'project.json'), JSON.stringify(proj, null, 2));

  index.push({
    id: slug, slug, name, status: 'active', type,
    createdAt: proj.createdAt, updatedAt: proj.updatedAt,
  });
  console.log(`  ✓ created → Фриланс проекты/${slug}/ (verdict: ${assessment.verdict})`);
  created++;
}

if (!DRY_RUN) writeIndex(index);
console.log(`\nDone: ${created} created, ${skipped} skipped${DRY_RUN ? ' (dry-run)' : ''}.`);
