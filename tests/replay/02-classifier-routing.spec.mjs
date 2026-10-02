// Mandatory replay scenario — classifier routing by content, with a scripted
// loopback LLM fixture (see scenarios/freelance-classifier-routing/scenario.md).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { startMcpServer } = require('../helpers/mcp-client.cjs');

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(REPO, 'fixtures', 'llm', name), 'utf8'));
const json = (reply) => JSON.parse(reply.content[0].text);

const RESPONSES = {
  existing: fixture('classifier-route-existing.json'),
  ambiguous: fixture('classifier-ambiguous.json'),
  newProject: fixture('classifier-new-project.json'),
};

let mode = 'existing';
let llm;
let server;
let projectId;

beforeAll(async () => {
  llm = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const slug = (body.match(/### ([^\s]+) —/) || [])[1] || '';
      const content = JSON.stringify(RESPONSES[mode]).replace(/\$project_id/g, slug);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise((r) => llm.listen(0, '127.0.0.1', r));
  server = await startMcpServer({ env: { OPENROUTER_BASE_URL: `http://127.0.0.1:${llm.address().port}` } });
  const tokenDir = path.join(server.env.AGENT_TOKENS_DIR, server.env.USER_ID);
  fs.mkdirSync(tokenDir, { recursive: true });
  fs.writeFileSync(path.join(tokenDir, 'openrouter'), 'fixture-key');
  projectId = json(await server.callTool('freelance_new_project', { name: 'Фото товара', description: 'приёмка фото → описание' })).project_id;
});

afterAll(async () => {
  if (server) await server.stop();
  if (llm) await new Promise((r) => llm.close(r));
});

describe('classifier routes by content via scripted LLM fixtures', () => {
  it('auto-files a high-confidence content match', async () => {
    mode = 'existing';
    const r = json(await server.callTool('freelance_classify_document', { text: 'фото товара и описание', filename: 'doc.pdf' }));
    expect(r.auto_filed).toBe(true);
    expect(r.project_id).toBe(projectId);
  });

  it('does not auto-file on insufficient confidence, and surfaces candidates', async () => {
    mode = 'ambiguous';
    const r = json(await server.callTool('freelance_classify_document', { text: 'частично похожий документ', filename: 'doc2.pdf' }));
    expect(r.auto_filed).toBe(false);
    expect(r.new_project).toBe(false);
    expect(r.candidates.length).toBeGreaterThan(0);
  });

  it('flags a genuinely new document', async () => {
    mode = 'newProject';
    const r = json(await server.callTool('freelance_classify_document', { text: 'совсем другая тема', filename: 'doc3.pdf' }));
    expect(r.new_project).toBe(true);
    expect(r.auto_filed).toBe(false);
  });
});
