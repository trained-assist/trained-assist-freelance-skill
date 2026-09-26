'use strict';
// L2 — Behavior layer (hermetic: real MCP server subprocess + fixtures).
//
// The server is started as a real stdio JSON-RPC subprocess and queried only
// through the MCP envelope. No handler is called directly, no real HTTP leaves
// the process (network guard + isolated token/profile roots), and the only
// scripted seam is the LLM (a loopback OpenRouter fixture).
require('../helpers/network-guard.cjs').installNetworkGuard();

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');

const { startMcpServer } = require('../helpers/mcp-client.cjs');

const FIXTURES = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'fixtures', 'tool-contract.json'), 'utf8')).tools;
const LLM_ROUTE_EXISTING = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'fixtures', 'llm', 'classifier-route-existing.json'), 'utf8'));

function toolText(reply) {
  assert.ok(Array.isArray(reply.content), `expected content[] envelope, got ${JSON.stringify(reply)}`);
  assert.equal(reply.content[0].type, 'text');
  assert.equal(typeof reply.content[0].text, 'string');
  return reply.content[0].text;
}

function toolJson(reply) {
  return JSON.parse(toolText(reply));
}

test('initialize and tools/list follow the MCP envelope; every tool is described and schema-compilable', async () => {
  const server = await startMcpServer();
  try {
    const tools = (await server.call('tools/list', {})).tools;
    const names = tools.map((t) => t.name);
    assert.equal(new Set(names).size, names.length, 'tool names must be unique');
    for (const t of tools) {
      assert.ok(t.description && t.description.trim().length > 0, `${t.name} needs a description`);
      assert.equal(t.inputSchema.type, 'object', `${t.name} inputSchema must be an object`);
    }
    assert.deepEqual([...names].sort(), FIXTURES.map((f) => f.name).sort(), 'every tool needs exactly one fixture');
  } finally {
    await server.stop();
  }
});

test('every tool returns a content[] envelope for its valid fixture args', async () => {
  const server = await startMcpServer();
  try {
    const ctx = {};
    for (const fixture of FIXTURES) {
      const args = JSON.parse(JSON.stringify(fixture.validArgs).replace(/\$project_id/g, ctx.project_id || ''));
      // new_project must run before anything that references $project_id.
      const reply = await server.callTool(fixture.name, args);
      const text = toolText(reply);
      assert.equal(reply.isError, undefined, `${fixture.name} unexpectedly errored: ${text}`);
      if (fixture.name === 'freelance_new_project') ctx.project_id = JSON.parse(text).project_id;
      if (fixture.name === 'freelance_generate_spec') {
        const spec = JSON.parse(text);
        assert.deepEqual(spec.variants, ['long', 'short']);
        assert.match(spec.instruction, /НЕЗАВИСИМО/);
      }
    }
  } finally {
    await server.stop();
  }
});

test('unknown tool and invalid arguments are in-band isError, never a crash', async () => {
  const server = await startMcpServer();
  try {
    const unknown = await server.callTool('freelance_does_not_exist', {});
    assert.equal(unknown.isError, true);
    assert.match(toolText(unknown), /Unknown tool/);

    const badArgs = await server.callTool('freelance_add_info', { project_id: 'nope', content: 'x' });
    assert.equal(badArgs.isError, true);

    // The process must still answer contract calls after errors.
    const tools = (await server.call('tools/list', {})).tools;
    assert.ok(tools.length >= FIXTURES.length);
  } finally {
    await server.stop();
  }
});

test('classifier without credentials never guesses "new project" and never auto-files', async () => {
  const server = await startMcpServer();
  try {
    const created = toolJson(await server.callTool('freelance_new_project', { name: 'No-key project', description: 'x' }));
    const r = toolJson(await server.callTool('freelance_classify_document', { text: 'unrelated new document', filename: 'y.pdf' }));
    assert.equal(r.auto_filed, false);
    assert.equal(r.new_project, false, 'a failed classification must not assert new_project:true');
    assert.ok(Array.isArray(r.active_projects) && r.active_projects.some((p) => p.project_id === created.project_id));
  } finally {
    await server.stop();
  }
});

test('classifier routes by content using a scripted loopback LLM fixture', async () => {
  const server = await startMcpServer({ env: {} });
  // The recorded fixture is keyed on the project slug the classifier put in its
  // prompt (`### <slug> — <name>`); substitute it so the replay matches.
  const llm = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const slug = (body.match(/### ([^\s]+) —/) || [])[1] || '';
      const content = JSON.stringify(LLM_ROUTE_EXISTING).replace(/\$project_id/g, slug);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise((r) => llm.listen(0, '127.0.0.1', r));
  try {
    const port = llm.address().port;
    // Re-point the server process at the loopback fixture and give it a key.
    await server.stop();
    const mock = await startMcpServer({ env: { OPENROUTER_BASE_URL: `http://127.0.0.1:${port}` } });
    try {
      const created = toolJson(await mock.callTool('freelance_new_project', { name: 'Фото товара', description: 'x' }));
      fs.mkdirSync(path.join(mock.env.AGENT_TOKENS_DIR, mock.env.USER_ID), { recursive: true });
      fs.writeFileSync(path.join(mock.env.AGENT_TOKENS_DIR, mock.env.USER_ID, 'openrouter'), 'fixture-key');
      const r = toolJson(await mock.callTool('freelance_classify_document', { text: 'фото товара и описание', filename: 'doc.pdf' }));
      assert.equal(r.auto_filed, true);
      assert.equal(r.project_id, created.project_id);
    } finally {
      await mock.stop();
    }
  } finally {
    await new Promise((r) => llm.close(r));
  }
});

test('network canary: non-loopback HTTP is denied without a fixture', async () => {
  await assert.rejects(fetch('https://openrouter.ai/api/v1/chat/completions'), /STAGING_OUTBOUND_BLOCKED/);
});
