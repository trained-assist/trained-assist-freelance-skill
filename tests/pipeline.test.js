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

test('freelance_generate_spec returns independent variants, source path, and never feeds qna/provenance', async () => {
  const registry = freshEnv();
  const { project_id } = await registry.callTool('freelance_new_project', { name: 'Spec test', description: 'init' });
  await registry.callTool('freelance_add_info', { project_id, stage: 'requirement', content: 'REQ_MARKER система должна ...' });
  await registry.callTool('freelance_add_info', { project_id, stage: 'qna', content: 'QNA_MARKER клиент сказал ...' });

  const r = await registry.callTool('freelance_generate_spec', { project_id });
  assert.deepEqual(r.variants, ['long', 'short']);
  assert.match(r.spec_paths.long, /spec[\\/]long\.md$/);
  assert.match(r.spec_paths.short, /spec[\\/]short\.md$/);
  assert.match(r.spec_source_path, /spec[\\/]_source\.md$/);
  assert.match(r.sources.requirements, /REQ_MARKER/);
  assert.doesNotMatch(JSON.stringify(r.sources), /QNA_MARKER/, 'qna (conversation log) must not be fed into spec generation');
  assert.match(r.instruction, /НЕЗАВИСИМО/);
  assert.match(r.instruction, /ШАГ 1/, 'must include the explicit normalization step');
  assert.match(r.instruction, /НЕ конспект созвона или переписки/, 'spec must not read as a call summary');
  assert.match(r.instruction, /Input Info/, 'must forbid source/transcript sections');

  const onlyLong = await registry.callTool('freelance_generate_spec', { project_id, variants: 'long' });
  assert.deepEqual(onlyLong.variants, ['long']);
  assert.equal(onlyLong.spec_paths.short, undefined);
});

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

test('freelance_generate_all defaults to a 6h window and returns per-project paths', async () => {
  const registry = freshEnv();
  await registry.callTool('freelance_new_project', { name: 'Batch A', description: 'x' });
  const r = await registry.callTool('freelance_generate_all', {});
  assert.deepEqual(r.variants, ['long', 'short']);
  assert.equal(r.window.count, 1);
  assert.match(r.message, /6 час/);
  assert.match(r.projects[0].spec_paths.short, /spec[\\/]short\.md$/);
  assert.match(r.instruction, /таблиц/i);
});

test('generation notes persist per scope and are surfaced by generate_spec', async () => {
  const registry = freshEnv();
  const { project_id } = await registry.callTool('freelance_new_project', { name: 'Notes', description: 'x' });
  await registry.callTool('freelance_generation_note', { text: 'всегда делай ТЗ техничнее' });
  await registry.callTool('freelance_generation_note', { project_id, text: 'никогда не писать «клиент сказал»' });

  const r = await registry.callTool('freelance_generate_spec', { project_id });
  assert.match(r.generation_notes.profile, /техничнее/);
  assert.match(r.generation_notes.project, /клиент сказал/);
  assert.match(r.instruction, /Постоянные инструкции/);

  // project-scope replace overwrites only the project note
  await registry.callTool('freelance_generation_note', { project_id, text: 'только это', mode: 'replace' });
  const r2 = await registry.callTool('freelance_generate_spec', { project_id });
  assert.equal(r2.generation_notes.project, 'только это');
  assert.match(r2.generation_notes.profile, /техничнее/);
});

test('freelance_get_spec returns current docs (read-compatible with legacy tz.md) and an edit instruction', async () => {
  const registry = freshEnv();
  const { project_id } = await registry.callTool('freelance_new_project', { name: 'Edit', description: 'x' });

  const longPath = path.join(profileDir(), project_id, 'spec', 'long.md');
  fs.mkdirSync(path.dirname(longPath), { recursive: true });
  fs.writeFileSync(longPath, '# Long spec\n\n## Раздел 1\n');

  const r = await registry.callTool('freelance_get_spec', { project_id, variant: 'long' });
  assert.match(r.docs.long, /# Long spec/);
  assert.match(r.spec_paths.long, /spec[\\/]long\.md$/);
  assert.match(r.instruction, /приоритет/i);

  // legacy fallback: only spec/tz.md exists → surfaced as long
  const legacyProject = await registry.callTool('freelance_new_project', { name: 'Legacy', description: 'y' });
  const legacyPath = path.join(profileDir(), legacyProject.project_id, 'spec', 'tz.md');
  fs.writeFileSync(legacyPath, '# Legacy TZ');
  const lr = await registry.callTool('freelance_get_spec', { project_id: legacyProject.project_id, variant: 'long' });
  assert.match(lr.docs.long, /# Legacy TZ/);
});

test('spec-generation info tools describe current settings, notes and the repo link', async () => {
  const registry = freshEnv();
  const { project_id } = await registry.callTool('freelance_new_project', { name: 'Info', description: 'x' });
  await registry.callTool('freelance_generation_note', { project_id, text: 'всегда техничнее' });

  const d = await registry.callTool('freelance_spec_generation_defaults', { project_id });
  assert.match(d.text, /Настройки генерации/);
  assert.match(d.text, /markdown/);
  assert.match(d.text, /всегда техничнее/);
  assert.ok('last_change' in d);

  const e = await registry.callTool('freelance_spec_generation_explained', {});
  assert.match(e.text, /НЕЗАВИСИМО/);
  assert.match(e.text, /github\.com\/trained-assist\/trained-assist-freelance-skill/);
});

test('commands.json is the domain-owned command surface and maps only to existing tools', async () => {
  const registry = freshEnv();
  const spec = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'commands.json'), 'utf8'));
  const tools = new Set(registry.listTools().map(t => t.name));
  const mapped = spec.commands.filter(c => c.handler === 'tool');
  assert.ok(mapped.length >= 9, 'the domain should expose the project + spec-generation commands');
  for (const c of mapped) assert.ok(tools.has(c.tool), `${c.command} -> ${c.tool} must exist`);
  assert.deepEqual(
    spec.commands.filter(c => c.command.startsWith('spec_generation')).map(c => c.command),
    ['spec_generation_defaults', 'spec_generation_explained'],
  );
  assert.ok(spec.commands.some(c => c.command === 'remember' && c.handler === 'local'), '/remember must be a local command');
});

test('freelance_generation_note returns a readable confirmation', async () => {
  const registry = freshEnv();
  await registry.callTool('freelance_new_project', { name: 'R', description: 'x' });
  const r = await registry.callTool('freelance_generation_note', { text: 'всегда md' });
  assert.match(r.text, /Запомнил/);
  assert.match(r.note, /всегда md/);
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
