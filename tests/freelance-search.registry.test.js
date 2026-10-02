'use strict';
// RED registration test for freelance_search (issue #33 / playbooks #53).
// The tool must be discoverable through the real registry (src/mcp-skills/registry.js)
// with the agreed name and inputSchema. Fails now - the tool is not registered yet.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function freshRegistry() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freelance-skill-reg-'));
  const usersDir = path.join(dir, 'users', 'tuser');
  fs.mkdirSync(usersDir, { recursive: true });
  process.env.USER_ID = 'tuser';
  process.env.USERS_DIR = path.join(dir, 'users');
  process.env.AGENT_TOKENS_DIR = path.join(dir, 'agent-tokens');
  delete process.env.OPENROUTER_API_KEY;
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}src${path.sep}mcp-skills${path.sep}`)) delete require.cache[key];
  }
  return require('../src/mcp-skills/registry.js');
}

test('freelance_search присутствует в реестре тулов с именем и inputSchema', () => {
  const registry = freshRegistry();
  const tools = registry.listTools();
  const t = tools.find(x => x.name === 'freelance_search');
  assert.ok(t, 'тул freelance_search не найден в реестре — фича не реализована (красная песочница по правильной причине)');
  assert.ok(typeof t.description === 'string' && t.description.length > 0, 'описание непустое');
  assert.ok(t.inputSchema && t.inputSchema.type === 'object', 'inputSchema — объект-схема');
  const props = Object.keys((t.inputSchema && t.inputSchema.properties) || {}).sort();
  assert.deepStrictEqual(props, ['project_id', 'query'], 'схема заявляет ровно query и project_id');
});