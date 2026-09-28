'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function freshEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freelance-skill-test-'));
  const usersDir = path.join(dir, 'users');
  fs.mkdirSync(path.join(usersDir, 'testuser'), { recursive: true });
  process.env.USER_ID = 'testuser';
  process.env.USERS_DIR = usersDir;
  // Isolate from this machine's real ~/agent-tokens — without this, a real
  // OPENROUTER_API_KEY in the ambient shell env makes the classifier fire an
  // actual network call during tests (found the hard way: one test took 15s).
  process.env.AGENT_TOKENS_DIR = path.join(dir, 'agent-tokens');
  delete process.env.OPENROUTER_API_KEY;

  // Every module under src/mcp-skills/ must be re-required fresh, not just the
  // two tool files — lib/paths.js in particular captures USERS_ROOT from
  // process.env at require-time, so a stale cached copy silently keeps
  // pointing every "fresh" test at the FIRST test's tmpdir.
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}src${path.sep}mcp-skills${path.sep}`)) delete require.cache[key];
  }
  return require('../src/mcp-skills/registry.js');
}

test('freelance_new_project scaffolds the pipeline files and runs risk assessment', async () => {
  const registry = freshEnv();
  const r = await registry.callTool('freelance_new_project', {
    name: 'ЖБИ-заводы', type: 'ecommerce', description: 'Сбор данных о заводах ЖБИ',
  });
  assert.equal(r.duplicate, undefined);
  assert.ok(r.project_id);
  assert.ok(r.risk_level);

  const dump = await registry.callTool('freelance_get_project', { project_id: r.project_id });
  assert.match(dump.facts, /Сбор данных о заводах ЖБИ/);
  assert.doesNotMatch(dump.requirements, /Сбор данных о заводах ЖБИ/, 'initial description must land in facts.md, not requirements.md');
});

test('freelance_new_project guards against accidental duplicates by name', async () => {
  const registry = freshEnv();
  const first = await registry.callTool('freelance_new_project', { name: 'Renovatio', description: 'x' });
  const second = await registry.callTool('freelance_new_project', { name: 'renovatio ', description: 'y' });
  assert.equal(second.duplicate, true);
  assert.equal(second.project_id, first.project_id);
});

test('freelance_add_info writes each stage to its own file and never cross-contaminates', async () => {
  const registry = freshEnv();
  const { project_id } = await registry.callTool('freelance_new_project', { name: 'Multi-stage test', description: 'init' });

  await registry.callTool('freelance_add_info', { project_id, stage: 'requirement', content: 'REQ_MARKER use CatBoost' });
  await registry.callTool('freelance_add_info', { project_id, stage: 'solution', content: 'SOL_MARKER one multi-output model instead' });
  await registry.callTool('freelance_add_info', { project_id, stage: 'interpretation', content: 'INTERP_MARKER assuming weekly batch is fine' });

  const dump = await registry.callTool('freelance_get_project', { project_id });
  assert.match(dump.requirements, /REQ_MARKER/);
  assert.doesNotMatch(dump.solution, /REQ_MARKER/);
  assert.match(dump.solution, /SOL_MARKER/);
  assert.doesNotMatch(dump.requirements, /SOL_MARKER/);
  assert.match(dump.interpretation, /INTERP_MARKER/);
});

test('academic project type skips business-relationship risk signals', async () => {
  const registry = freshEnv();
  const r = await registry.callTool('freelance_new_project', {
    name: 'Adaptive control problem set', type: 'academic', description: 'Solve 3 control theory problems',
  });
  assert.equal(r.type, 'academic');
  // Should not surface prepayment/budget questions that don't apply to a fixed-scope task-for-hire.
  const qs = JSON.stringify(r.open_questions);
  assert.doesNotMatch(qs, /предоплат/i);
  assert.doesNotMatch(qs, /Бюджет/);
});

test('freelance_classify_document returns "new project" when no active projects exist yet', async () => {
  const registry = freshEnv();
  const r = await registry.callTool('freelance_classify_document', { text: 'anything', filename: 'x.pdf' });
  assert.equal(r.new_project, true);
});

test('freelance_classify_document never auto-files without an OpenRouter key configured', async () => {
  const registry = freshEnv();
  delete process.env.OPENROUTER_API_KEY;
  await registry.callTool('freelance_new_project', { name: 'Some project', description: 'x' });
  const r = await registry.callTool('freelance_classify_document', { text: 'unrelated new document', filename: 'y.pdf' });
  assert.equal(r.auto_filed, false);
});

test('concurrent freelance_new_project calls never lose an _index.json entry', async () => {
  const registry = freshEnv();
  // Two children of the same profile can run under the managed adapter — the
  // shared read-modify-write index must serialize (epic #1271 §18).
  const [a, b] = await Promise.all([
    registry.callTool('freelance_new_project', { name: 'Project Alpha', description: 'x' }),
    registry.callTool('freelance_new_project', { name: 'Project Beta', description: 'y' }),
  ]);
  assert.notEqual(a.project_id, b.project_id);
  const list = await registry.callTool('freelance_list');
  const names = list.projects.map(p => p.name);
  assert.ok(names.includes('Project Alpha'));
  assert.ok(names.includes('Project Beta'));
  assert.equal(list.projects.length, 2, 'both concurrent creations must survive in _index.json');
});

function profileDir() {
  return path.join(process.env.USERS_DIR, 'testuser', 'Фриланс проекты');
}
test('freelance_list since filters by the window; default listing is unbounded', async () => {
  const registry = freshEnv();
  await registry.callTool('freelance_new_project', { name: 'Old project', description: 'x' });
  const idxPath = path.join(profileDir(), '_index.json');
  const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
  idx[0].updatedAt = new Date(Date.now() - 10 * 3600e3).toISOString();
  fs.writeFileSync(idxPath, JSON.stringify(idx));

  const windowed = await registry.callTool('freelance_list', { since: '6h' });
  assert.equal(windowed.window.count, 0);
  assert.match(windowed.message, /Проектов за последние 6 ч/);
  const all = await registry.callTool('freelance_list', {});
  assert.equal(all.projects.length, 1);
  assert.equal(all.window, undefined);
});
test('commands.json is the domain-owned command surface and maps only to existing tools', async () => {
  const registry = freshEnv();
  const spec = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'commands.json'), 'utf8'));
  const tools = new Set(registry.listTools().map(t => t.name));
  const mapped = spec.commands.filter(c => c.handler === 'tool');
  assert.ok(mapped.length >= 6, 'the domain should expose the project commands');
  for (const c of mapped) assert.ok(tools.has(c.tool), `${c.command} -> ${c.tool} must exist`);
  // Spec generation moved to trained-assist-engineering (issue #43) — the freelance
  // surface must not point back at the removed tools.
  for (const name of ['freelance_generate_spec', 'freelance_get_spec', 'freelance_generate_all',
    'freelance_generation_note', 'freelance_spec_generation_defaults', 'freelance_spec_generation_explained']) {
    assert.ok(!tools.has(name), `${name} was moved to the engineering skill and must be gone here`);
  }
});
test('a broken/truncated LLM response never gets silently treated as "definitely new" — regression for the duplicate-lead bug found in real testing', async () => {
  const registry = freshEnv();
  process.env.OPENROUTER_API_KEY = 'fake-key-for-this-test';
  await registry.callTool('freelance_new_project', { name: 'ЖБИ-заводы', type: 'ecommerce', description: 'x' });

  // No network mocking available here — with a fake key the real openrouter.ai
  // call will fail (auth error), exercising the exact "classification failed"
  // path the bug was in, without needing a live/successful LLM round trip.
  const r = await registry.callTool('freelance_classify_document', {
    text: 'Сбор данных о заводах-производителях РФ, карточки + прайслисты — duplicate lead',
  });
  assert.equal(r.new_project, false, 'a failed classification must never assert new_project:true');
  assert.equal(r.auto_filed, false);
  assert.ok(Array.isArray(r.active_projects) && r.active_projects.length === 1, 'must surface the active project list so the caller can judge manually');
});
