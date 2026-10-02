'use strict';

// Full-text search across the pipeline files of every freelance project of the
// profile — read-only, no LLM, no network. The owner/agent asks "where did we
// agree the budget/prepayment/deadline" and gets {project, file, line, snippet}
// back in one call instead of dumping each project through
// freelance_get_project.
//
// Storage: $USERS_DIR/<profile>/Фриланс проекты/<slug>/ (see lib/paths.js —
// profile root, never process.cwd()). Projects are DISCOVERED from the storage
// directories themselves (underscore-prefixed service entries like _index.json
// / _classifier are skipped) and enriched with project names from _index.json
// when present — a project that exists on disk is always searchable, even if
// the index is missing or stale.
//
// Safety rails:
//   * symlinks are never followed (readdir withFileTypes: a symlink is not a
//     dirent.isDirectory()), so the scan cannot leave the profile storage;
//   * files > 5MB and binary content (NUL byte) are skipped, unreadable files
//     are skipped — one bad file never fails the call;
//   * matches are capped by `limit` (default 100); `total` always counts the
//     full scan and `truncated: true` marks "showing the first N";
//   * deterministic: projects/files sorted by name, case-insensitive substring
//     match (no regex) — the same query over the same storage returns the same
//     JSON.
//
// Errors are in-band objects with isError:true (the MCP server mirrors that
// flag into the tools/call envelope) — the handler itself never throws, so an
// empty/invalid input yields a readable object, not an exception.
//
// Tools: freelance_search

const fs = require('fs');
const path = require('path');

const USER_ID = process.env.USER_ID || process.env.AGENT_USER_ID || '';

const { freelanceRoot, indexPath } = require('../lib/paths');

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const SNIPPET_MAX = 240;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

function errorResult(message) {
  return {
    isError: true,
    error: message,
    matches: [],
    count: 0,
    total: 0,
    truncated: false,
    message,
  };
}

function readIndexNames() {
  const names = new Map();
  try {
    const list = JSON.parse(fs.readFileSync(indexPath(USER_ID), 'utf8'));
    for (const p of Array.isArray(list) ? list : []) {
      if (p && typeof p.id === 'string' && typeof p.name === 'string') names.set(p.id, p.name);
    }
  } catch { /* no index or unreadable — directory names are authoritative */ }
  return names;
}

// Sorted, symlink-free project discovery. Entries starting with "_" are
// service records (_index.json, _index.lock, _classifier), not projects.
function listProjectSlugs() {
  let entries;
  try {
    entries = fs.readdirSync(freelanceRoot(USER_ID), { withFileTypes: true });
  } catch { return []; }
  return entries
    .filter(e => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('_'))
    .map(e => e.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// Deterministic recursive walk: names sorted byte-wise, symlinks skipped.
function walkFiles(root) {
  const out = [];
  const visit = (dir, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) visit(path.join(dir, e.name), relPath);
      else if (e.isFile()) out.push({ full: path.join(dir, e.name), relPath });
    }
  };
  visit(root, '');
  return out;
}

function scanFile(full, relPath, needleLower, limit, matches) {
  let size;
  try {
    size = fs.statSync(full).size;
  } catch { return { found: 0, pushed: 0 }; }
  if (size > MAX_FILE_BYTES) return { found: 0, pushed: 0 };

  let content;
  try {
    content = fs.readFileSync(full, 'utf8');
  } catch { return { found: 0, pushed: 0 }; }
  if (content.includes('\0')) return { found: 0, pushed: 0 };

  let found = 0;
  let pushed = 0;
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].toLowerCase().includes(needleLower)) continue;
    found += 1;
    if (matches.length < limit) {
      let snippet = lines[i].trim();
      if (snippet.length > SNIPPET_MAX) snippet = `${snippet.slice(0, SNIPPET_MAX)}…`;
      matches.push({ line: i + 1, file: relPath, snippet });
      pushed += 1;
    }
  }
  return { found, pushed };
}

// ── Tools ──────────────────────────────────────────────────────────────────

module.exports = {
  isReady: () => true,

  tools: {

    freelance_search: {
      description: [
        'Полнотекстовый read-only поиск по файлам пайплайна всех фриланс-проектов профиля (без LLM и сети).',
        'Используй, когда владелец спрашивает «где мы согласовали бюджет/сроки/требования» — совпадения вида {project, file, line, snippet} по всем проектам сразу, вместо чтения файлов вручную.',
        'Вход: query (подстрока, регистронезависимо), опционально project_id (сужение до одного проекта) и limit (1..1000, по умолчанию 100 — при обрезке в ответе truncated:true и total).',
        'Пустой результат — валидный ответ (matches: []), невалидный ввод — объект ошибки isError, не исключение.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'Подстрока для поиска (регистронезависимо), например «бюджет» или «предоплата 50%»' },
          project_id: { type: 'string', description: 'Опционально: сузить поиск до одного проекта (slug)' },
          // Declared, not just described: the calling layer types arguments by
          // this schema, so an undeclared `limit` arrived as a string and every
          // live call with it failed validation (issue #33, step-14 verification).
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT, description: `Максимум совпадений в ответе (1..${MAX_LIMIT}, по умолчанию ${DEFAULT_LIMIT}); при обрезке truncated:true и total` },
        },
      },
      handler: async (args = {}) => {
        const { query, project_id: projectId, limit: limitRaw } = args || {};
        if (typeof query !== 'string' || !query.trim()) {
          return errorResult('Нужен query — непустая строка для поиска. Пример: freelance_search({query: "бюджет"}).');
        }
        if (projectId !== undefined && projectId !== null && typeof projectId !== 'string') {
          return errorResult('project_id должен быть строкой (slug проекта) — список: freelance_list.');
        }

        const q = query.trim();
        const needle = q.toLowerCase();
        let limit = DEFAULT_LIMIT;
        if (limitRaw !== undefined && limitRaw !== null) {
          if (typeof limitRaw !== 'number' || !Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > MAX_LIMIT) {
            return errorResult(`limit должен быть целым числом 1..${MAX_LIMIT}.`);
          }
          limit = limitRaw;
        }

        const slugs = listProjectSlugs();
        let targets = slugs;
        if (projectId) {
          if (!slugs.includes(projectId)) {
            return errorResult(`Проект не найден: ${projectId}. Список: freelance_list`);
          }
          targets = [projectId];
        }

        const names = readIndexNames();
        const matches = [];
        let total = 0;
        for (const slug of targets) {
          const dir = path.join(freelanceRoot(USER_ID), slug);
          for (const f of walkFiles(dir)) {
            const before = matches.length;
            const { found, pushed } = scanFile(f.full, f.relPath, needle, limit, matches);
            if (!found) continue;
            total += found;
            // Attribute only the matches this file actually pushed (the cap may
            // have stopped pushing while `found` kept counting).
            for (let k = before; k < matches.length; k += 1) {
              matches[k].project = slug;
              matches[k].project_name = names.get(slug) || slug;
            }
            if (pushed === 0 && matches.length >= limit) { /* keep counting total */ }
          }
        }

        const result = {
          query: q,
          project_id: projectId || null,
          matches,
          count: matches.length,
          total,
          truncated: total > matches.length,
        };
        if (total === 0) result.message = `Ничего не найдено по запросу «${q}»${projectId ? ` в проекте ${projectId}` : ''}.`;
        else if (result.truncated) result.message = `Показаны первые ${matches.length} из ${total} совпадений — уточни запрос или передай project_id.`;
        return result;
      },
    },

  },
};
