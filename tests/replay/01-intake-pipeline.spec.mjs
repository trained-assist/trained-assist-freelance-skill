// Mandatory replay scenario — freelance intake pipeline (see scenarios/freelance-intake/scenario.md).
// Deterministic: real MCP subprocess, real risk-engine, no network, no LLM.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { startMcpServer } = require('../helpers/mcp-client.cjs');

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const golden = (name) => JSON.parse(fs.readFileSync(path.join(REPO, 'scenarios', 'freelance-intake', 'expected', name), 'utf8'));
const text = (reply) => reply.content[0].text;
const json = (reply) => JSON.parse(text(reply));

let server;
let projectId;
let academicId;
const profileDir = () => path.join(server.env.USERS_DIR, server.env.USER_ID, 'Фриланс проекты');

beforeAll(async () => { server = await startMcpServer(); });
afterAll(async () => { if (server) await server.stop(); });

describe('freelance intake pipeline', () => {
  it('creates the project, lands the raw description as a source (facts), not as a requirement', async () => {
    const empty = golden('risk-empty-ecommerce.json');
    const created = json(await server.callTool('freelance_new_project', {
      name: 'Behavior pipeline', type: 'ecommerce', description: 'RAW_INPUT клиент хочет систему приёма фото товара',
    }));
    expect(created.duplicate).toBeUndefined();
    expect(created.project_id).toBeTruthy();
    projectId = created.project_id;
    expect(created.risk_score).toBe(empty.score);
    expect(created.risk_level).toBe(empty.level);

    const dump = json(await server.callTool('freelance_get_project', { project_id: projectId }));
    expect(dump.facts).toMatch(/RAW_INPUT/);
    expect(dump.requirements).not.toMatch(/RAW_INPUT/);
    expect(dump.solution).not.toMatch(/RAW_INPUT/);

    const log = fs.readFileSync(path.join(profileDir(), projectId, 'provenance', 'log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(log).toHaveLength(1);
    expect(log[0].raw_excerpt).toMatch(/RAW_INPUT/);
    expect(log[0].source).toBe('chat');
    expect(log[0].reliability).toBe('medium');
  });

  it('keeps each stage in exactly one file', async () => {
    await server.callTool('freelance_add_info', { project_id: projectId, stage: 'requirement', content: 'REQ_MARKER «Система должна …»' });
    await server.callTool('freelance_add_info', { project_id: projectId, stage: 'solution', content: 'SOL_MARKER один multi-output классификатор' });
    await server.callTool('freelance_add_info', { project_id: projectId, stage: 'interpretation', content: 'INTERP_MARKER допускаем еженедельный батч' });

    const dump = json(await server.callTool('freelance_get_project', { project_id: projectId }));
    expect(dump.requirements).toMatch(/REQ_MARKER/);
    expect(dump.requirements).not.toMatch(/SOL_MARKER|INTERP_MARKER/);
    expect(dump.solution).toMatch(/SOL_MARKER/);
    expect(dump.solution).not.toMatch(/REQ_MARKER/);
    expect(dump.interpretation).toMatch(/INTERP_MARKER/);
  });

  it('persists signals/score/verdict and the verdict is deterministic across runs', async () => {
    const first = json(await server.callTool('freelance_assess', { project_id: projectId }));
    const second = json(await server.callTool('freelance_assess', { project_id: projectId }));
    expect(first.verdict).toBe(second.verdict);
    expect(first.risk_score).toBe(second.risk_score);

    const onDisk = JSON.parse(fs.readFileSync(path.join(profileDir(), projectId, 'risk-assessment.json'), 'utf8'));
    expect(onDisk.signals).toBeTypeOf('object');
    expect(onDisk.score).toBeTypeOf('number');
    expect(onDisk.verdict).toBeTypeOf('string');
  });

  it('a fully-specified default project scores the golden low-risk verdict', async () => {
    const specified = golden('risk-specified-default.json');
    const created = json(await server.callTool('freelance_new_project', { name: 'Specified default', type: 'default', description: 'полностью определённый проект' }));
    const allTrue = { hasTZ: true, valueClear: true, clientSeesResult: true, clientAnsweredQuestions: true, hasValueWording: true, prepaymentReady: true, hasClearDeadline: true, budgetConfirmed: true };
    await server.callTool('freelance_add_info', { project_id: created.project_id, stage: 'requirement', content: 'полный комплект', ...allTrue, integrationCount: specified.integrationCount, hasMVP: specified.hasMVP });
    const assessed = json(await server.callTool('freelance_assess', { project_id: created.project_id }));
    expect(assessed.risk_score).toBe(specified.score);
    expect(assessed.risk_level).toBe(specified.level);
    expect(assessed.verdict).toContain(specified.verdictContains);
  });

  it('academic projects ignore business-relationship signals', async () => {
    const acad = golden('risk-academic-empty.json');
    const created = json(await server.callTool('freelance_new_project', { name: 'Academic problem set', type: 'academic', description: 'Решить 3 задачи по теории управления' }));
    academicId = created.project_id;
    const assessed = json(await server.callTool('freelance_assess', { project_id: academicId }));
    expect(assessed.risk_score).toBe(acad.score);
    expect(assessed.risk_level).toBe(acad.level);
    const qs = JSON.stringify(assessed.open_questions);
    expect(qs).not.toMatch(/предоплат/i);
    expect(qs).not.toMatch(/Бюджет/);
  });

  it('spec generation feeds normalized sources, never qna, and asks for independent variants', async () => {
    await server.callTool('freelance_add_info', { project_id: projectId, stage: 'qna', content: 'QNA_MARKER клиент сказал ...' });
    const gen = json(await server.callTool('freelance_generate_spec', { project_id: projectId }));
    expect(gen.variants).toEqual(['long', 'short']);
    expect(gen.spec_source_path).toMatch(/spec[\\/]_source\.md$/);
    expect(JSON.stringify(gen.sources)).not.toMatch(/QNA_MARKER/);
    expect(gen.instruction).toMatch(/НЕЗАВИСИМО/);
  });
});
