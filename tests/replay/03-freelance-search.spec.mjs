// Mandatory replay scenario — freelance_search full-text search (see
// docs/user-scenarios/freelance/02-freelance-search.md).
// Deterministic: real MCP subprocess, no network, no LLM.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { startMcpServer } = require('../helpers/mcp-client.cjs');

const text = (reply) => reply.content[0].text;
const json = (reply) => JSON.parse(text(reply));

let server;
let alphaId;
let betaId;

beforeAll(async () => { server = await startMcpServer(); });
afterAll(async () => { if (server) await server.stop(); });

describe('freelance_search replay', () => {
  it('finds an agreed condition across all projects in one call', async () => {
    alphaId = json(await server.callTool('freelance_new_project', {
      name: 'Alpha Budget', type: 'default', description: 'SEARCH_MARKER бюджет проекта',
    })).project_id;
    betaId = json(await server.callTool('freelance_new_project', {
      name: 'Beta Deadline', type: 'default', description: 'некий проект',
    })).project_id;
    await server.callTool('freelance_add_info', {
      project_id: betaId, stage: 'requirement', content: 'SEARCH_MARKER срок сдачи',
    });

    const res = json(await server.callTool('freelance_search', { query: 'search_marker' }));
    expect(res.isError).toBeUndefined();
    expect(res.matches.length).toBeGreaterThanOrEqual(2);
    const projects = res.matches.map(m => m.project);
    expect(projects).toContain(alphaId);
    expect(projects).toContain(betaId);
    for (const m of res.matches) {
      expect(m.file).toBeTruthy();
      expect(typeof m.line).toBe('number');
      expect(m.snippet).toContain('SEARCH_MARKER');
      expect(m.project_name).toBeTruthy();
    }
  });

  it('narrows to a single project via project_id', async () => {
    const res = json(await server.callTool('freelance_search', { query: 'SEARCH_MARKER', project_id: betaId }));
    expect(res.matches.length).toBeGreaterThan(0);
    for (const m of res.matches) expect(m.project).toBe(betaId);
    expect(res.project_id).toBe(betaId);
  });

  it('unknown project_id and empty query are in-band errors, the process stays alive', async () => {
    const unknown = await server.callTool('freelance_search', { query: 'x', project_id: 'no-such-project' });
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toMatch(/Проект не найден/);

    const empty = await server.callTool('freelance_search', { query: '' });
    expect(empty.isError).toBe(true);

    // Still answers after errors.
    const ok = json(await server.callTool('freelance_search', { query: 'SEARCH_MARKER' }));
    expect(ok.matches.length).toBeGreaterThan(0);
  });

  it('no matches → empty list without error; empty profile → empty list without error', async () => {
    const none = json(await server.callTool('freelance_search', { query: 'НЕТ_ТАКОГО_МАРКЕРА_XYZ' }));
    expect(none.isError).toBeUndefined();
    expect(none.matches).toEqual([]);
    expect(none.total).toBe(0);

    const emptyServer = await startMcpServer();
    try {
      const res = json(await emptyServer.callTool('freelance_search', { query: 'anything' }));
      expect(res.isError).toBeUndefined();
      expect(res.matches).toEqual([]);
    } finally {
      await emptyServer.stop();
    }
  });

  it('limit caps the list and flags truncation; storage is untouched (read-only)', async () => {
    const profileDir = path.join(server.env.USERS_DIR, server.env.USER_ID, 'Фриланс проекты');
    const snapshot = () => {
      const entries = fs.readdirSync(profileDir).sort();
      return entries.map(n => `${n}:${fs.statSync(path.join(profileDir, n)).mtimeMs}`).join('|');
    };
    const before = snapshot();

    const res = json(await server.callTool('freelance_search', { query: 'SEARCH_MARKER', limit: 1 }));
    expect(res.matches.length).toBe(1);
    expect(res.total).toBeGreaterThan(1);
    expect(res.truncated).toBe(true);
    expect(res.message).toMatch(/Показаны первые 1/);

    expect(snapshot()).toBe(before, 'хранилище не изменилось');
  });
});
