'use strict';
// Semantic unit tests for freelance_search (issue #33, slice S4) — the red
// sandbox (tests/freelance-search.*) pins the basic contract; this file pins
// the invariants from docs/user-scenarios/freelance/02-freelance-search.md:
// limit/truncated, in-band errors for unknown project & invalid input,
// empty profile, read-only storage, symlink isolation, determinism.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TOOL_FILE = path.join(__dirname, '..', 'src', 'mcp-skills', 'tools', '30-freelance-search.js');

function freshEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freelance-s-search2-'));
  process.env.USER_ID = 'tuser';
  process.env.USERS_DIR = path.join(dir, 'users');
  process.env.AGENT_TOKENS_DIR = path.join(dir, 'agent-tokens');
  delete process.env.OPENROUTER_API_KEY;
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}src${path.sep}mcp-skills${path.sep}`)) delete require.cache[key];
  }
  return dir;
}

function seed(dir) {
  const root = path.join(dir, 'users', 'tuser', 'Фриланс проекты');
  fs.mkdirSync(path.join(root, 'alpha'), { recursive: true });
  fs.mkdirSync(path.join(root, 'beta'), { recursive: true });
  fs.writeFileSync(path.join(root, 'alpha', 'facts.md'), [
    'MARKER один', 'MARKER два', 'MARKER три', 'другое',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'beta', 'facts.md'), 'MARKER четыре\n');
  // Service entries must never be scanned as projects.
  fs.writeFileSync(path.join(root, '_index.json'), JSON.stringify([
    { id: 'alpha', name: 'Alpha Имя' },
  ]));
  fs.mkdirSync(path.join(root, '_classifier'), { recursive: true });
  fs.writeFileSync(path.join(root, '_classifier', 'recent-context.json'), 'MARKER служебный');
  return root;
}

function load() {
  return require(TOOL_FILE).tools.freelance_search.handler;
}

test('limit caps matches, total counts the full scan, truncated flags the cut', async () => {
  const dir = freshEnv();
  seed(dir);
  const handler = load();
  const res = await handler({ query: 'MARKER', limit: 2 });
  assert.equal(res.matches.length, 2);
  assert.equal(res.count, 2);
  assert.equal(res.total, 4);
  assert.equal(res.truncated, true);
  assert.match(res.message, /Показаны первые 2 из 4/);
});

test('default limit is applied: over-limit result stays capped', async () => {
  const dir = freshEnv();
  const root = seed(dir);
  fs.writeFileSync(path.join(root, 'alpha', 'big.md'), Array.from({ length: 300 }, (_, i) => `строка MARKER ${i}`).join('\n'));
  const handler = load();
  const res = await handler({ query: 'MARKER' });
  assert.equal(res.matches.length, 100, 'default cap 100');
  assert.ok(res.total > 100);
  assert.equal(res.truncated, true);
});

test('unknown project_id is an in-band error, not an exception', async () => {
  const dir = freshEnv();
  seed(dir);
  const handler = load();
  const res = await handler({ query: 'MARKER', project_id: 'nope' });
  assert.equal(typeof res, 'object');
  assert.equal(res.isError, true);
  assert.match(res.error, /Проект не найден/);
  assert.deepEqual(res.matches, []);
});

test('empty profile (no projects) → empty matches without error', async () => {
  freshEnv();
  const handler = load();
  const res = await handler({ query: 'MARKER' });
  assert.equal(res.isError, undefined);
  assert.deepEqual(res.matches, []);
  assert.equal(res.total, 0);
  assert.ok(res.message, 'сообщение «ничего не найдено» присутствует');
});

test('service entries (_index.json, _classifier) are never scanned as projects', async () => {
  const dir = freshEnv();
  seed(dir);
  const handler = load();
  const res = await handler({ query: 'служебный' });
  assert.equal(res.matches.length, 0, '_classifier не попал в результаты');
});

test('read-only: the call does not modify any storage file', async () => {
  const dir = freshEnv();
  const root = seed(dir);
  const snapshot = () => {
    const out = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else out.push(`${path.relative(root, p)}:${fs.statSync(p).size}:${fs.readFileSync(p, 'utf8').length}`);
      }
    };
    walk(root);
    return out.join('|');
  };
  const handler = load();
  const before = snapshot();
  await handler({ query: 'MARKER' });
  await handler({ query: 'нет_такого_xyz' });
  await handler({ query: 'MARKER', project_id: 'alpha' });
  assert.equal(snapshot(), before, 'хранилище не изменилось');
});

test('symlink out of the storage is not followed (isolation)', async () => {
  const dir = freshEnv();
  const root = seed(dir);
  const outside = path.join(dir, 'outside-secret.md');
  fs.writeFileSync(outside, 'SECRET_MARKER наружу\n');
  try {
    fs.symlinkSync(outside, path.join(root, 'alpha', 'leak.md'));
  } catch {
    t_skip('symlinks недоступны на этой ФС');
    return;
  }
  const handler = load();
  const res = await handler({ query: 'SECRET_MARKER' });
  assert.equal(res.matches.length, 0, 'symlink наружу не прочитан');
});

function t_skip() { /* placeholder for platforms without symlink permission */ }

test('binary files (NUL) and unreadable files are skipped, call still succeeds', async () => {
  const dir = freshEnv();
  const root = seed(dir);
  fs.writeFileSync(path.join(root, 'alpha', 'bin.dat'), Buffer.from([0x00, 0x4d, 0x41, 0x52, 0x4b, 0x45, 0x52, 0x00]));
  const handler = load();
  const res = await handler({ query: 'MARKER' });
  assert.equal(res.isError, undefined);
  assert.ok(res.matches.length > 0, 'текстовые файлы найдены, бинарник пропущен');
  assert.ok(res.matches.every(m => m.file !== 'bin.dat'));
});

test('determinism: the same query returns byte-identical JSON', async () => {
  const dir = freshEnv();
  seed(dir);
  const handler = load();
  const a = JSON.stringify(await handler({ query: 'marker' }));
  const b = JSON.stringify(await handler({ query: 'marker' }));
  assert.equal(a, b, 'регистронезависимый поиск детерминирован');
});

test('invalid limit is an in-band error, not an exception', async () => {
  const dir = freshEnv();
  seed(dir);
  const handler = load();
  for (const limit of [0, -1, 1.5, 1001, '5']) {
    const res = await handler({ query: 'MARKER', limit });
    assert.equal(res.isError, true, `limit=${JSON.stringify(limit)} → in-band ошибка`);
  }
});

test('case-insensitive match across projects with project_name from index', async () => {
  const dir = freshEnv();
  seed(dir);
  const handler = load();
  const res = await handler({ query: 'marker четыре' });
  assert.equal(res.matches.length, 1);
  assert.equal(res.matches[0].project, 'beta');
  assert.equal(res.matches[0].project_name, 'beta', 'нет записи в индексе → slug как имя');
  const res2 = await handler({ query: 'MARKER один' });
  assert.equal(res2.matches[0].project_name, 'Alpha Имя', 'имя берётся из _index.json');
});
