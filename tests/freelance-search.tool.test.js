'use strict';
// RED test for freelance_search (issue #33 / playbooks #53): full-text search over
// pipeline files of all freelance projects of the profile.
//
// Sandbox contract (step 6 of the skill-tool playbook): this file must FAIL while
// the feature is absent and turn GREEN when src/mcp-skills/tools/30-freelance-search.js
// (handler + inputSchema) is implemented. The failure reason now is "feature not
// implemented yet" (MODULE_NOT_FOUND - that is the correct red reason).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TOOL_FILE = path.join(__dirname, '..', 'src', 'mcp-skills', 'tools', '30-freelance-search.js');

// Seed a fresh profile root: two projects with pipeline files containing distinct
// searchable markers. Mirrors the real layout (Фриланс проекты/<slug>/facts.md...).
function seedProfile(dir) {
  const usersDir = path.join(dir, 'users');
  const root = path.join(usersDir, 'tuser', 'Фриланс проекты');
  fs.mkdirSync(path.join(root, 'alpha'), { recursive: true });
  fs.mkdirSync(path.join(root, 'beta'), { recursive: true });
  fs.writeFileSync(path.join(root, 'alpha', 'facts.md'), [
    '## Факты — alpha',
    '- Бюджет согласован: 300000 руб.',
    '- Срок: 2026-12-01',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'alpha', 'requirements.md'),
    '# Требования\n\nСистема должна автоматически считать налоги.\n');
  fs.writeFileSync(path.join(root, 'beta', 'facts.md'), [
    '## Факты — beta',
    '- Проект по интеграции оплат.',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'beta', 'solution.md'),
    '# Решение\n\nИспользуем OpenRouter для классификации. Бюджет не согласован.\n');
  return usersDir;
}

function freshEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freelance-skill-search-'));
  const usersDir = seedProfile(dir);
  process.env.USER_ID = 'tuser';
  process.env.USERS_DIR = usersDir;
  process.env.AGENT_TOKENS_DIR = path.join(dir, 'agent-tokens');
  delete process.env.OPENROUTER_API_KEY;
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}src${path.sep}mcp-skills${path.sep}`)) delete require.cache[key];
  }
}

function loadHandler() {
  let mod;
  try {
    mod = require(TOOL_FILE);
  } catch (e) {
    assert.fail(`freelance_search не реализован: модуль ${path.basename(TOOL_FILE)} отсутствует (${e.code}). Песочница красная по правильной причине — ждём фичу.`);
  }
  const tool = mod.tools && mod.tools.freelance_search;
  assert.ok(tool, 'модуль тула не экспортирует tools.freelance_search');
  assert.equal(typeof tool.handler, 'function', 'handler должен быть функцией');
  return tool.handler;
}

test('freelance_search возвращает объект (не бросает) на пустом вводе', async () => {
  freshEnv();
  const handler = loadHandler();
  const res = await handler({}, { userId: 'tuser' });
  assert.ok(res && typeof res === 'object', 'пустой ввод → объект, не exception');
});

test('freelance_search возвращает объект (не бросает) на невалидных аргументах', async () => {
  freshEnv();
  const handler = loadHandler();
  const res = await handler({ project_id: 42, query: ['x'] }, { userId: 'tuser' });
  assert.ok(res && typeof res === 'object', 'невалидные типы → объект, не exception');
});

test('freelance_search находит маркер по тексту по всем проектам', async () => {
  freshEnv();
  const handler = loadHandler();
  const res = await handler({ query: 'Бюджет' }, { userId: 'tuser' });
  assert.ok(res && typeof res === 'object');
  assert.ok(Array.isArray(res.matches), 'ответ несёт массив matches');
  const projects = res.matches.map(m => m.project);
  assert.ok(projects.includes('alpha'), 'должен найти в проекте alpha');
  assert.ok(projects.includes('beta'), 'должен найти в проекте beta (матч по "Бюджет не согласован")');
  for (const m of res.matches) {
    assert.ok(m.file, 'каждое совпадение несёт file');
    assert.equal(typeof m.line, 'number', 'каждое совпадение несёт номер строки');
    assert.ok(typeof m.snippet === 'string' && m.snippet.includes('Бюджет'), 'snippet содержит искомый текст');
  }
});

test('freelance_search сужает поиск по project_id', async () => {
  freshEnv();
  const handler = loadHandler();
  const res = await handler({ query: 'Бюджет', project_id: 'beta' }, { userId: 'tuser' });
  assert.ok(res && typeof res === 'object');
  assert.ok(Array.isArray(res.matches));
  assert.ok(res.matches.length > 0, 'в beta есть совпадение');
  for (const m of res.matches) assert.equal(m.project, 'beta', 'все совпадения из отфильтрованного проекта');
});

test('freelance_search на отсутствие совпадений отвечает пустым списком без ошибки', async () => {
  freshEnv();
  const handler = loadHandler();
  const res = await handler({ query: 'НЕТ_ТАКОГО_МАРКЕРА_XYZ' }, { userId: 'tuser' });
  assert.ok(res && typeof res === 'object');
  assert.ok(Array.isArray(res.matches));
  assert.equal(res.matches.length, 0, 'нет совпадений → пустой массив, без throw');
});