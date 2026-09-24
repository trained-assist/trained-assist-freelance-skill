#!/usr/bin/env node
// End-to-end spec-generation test — one fixed scenario, real production flow.
//
// input (fixture) → real pipeline (opencode + this repo's MCP: new_project →
// generate_spec → normalize → long.md/short.md) → deterministic structural
// checks → LLM judge → PASS/FAIL.
//
// Deliberately NOT in the offline `npm test` (needs network + opencode). Run:
//   npm run test:e2e
// Env:
//   E2E_MODEL        engine model (default opencode-go/deepseek-v4.1-flash)
//   JUDGE_MODEL      judge model via OpenRouter (default deepseek/deepseek-chat)
//   OPENROUTER_API_KEY  required for the judge (skipped if absent)
// Missing `opencode` binary → SKIP (exit 0), never a false FAIL.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(REPO, 'e2e', 'fixtures', 'doctor-agent.input.md');
const ENGINE_MODEL = process.env.E2E_MODEL || 'opencode-go/deepseek-v4.1-flash';
const JUDGE_MODEL = process.env.JUDGE_MODEL || 'deepseek/deepseek-chat';
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';

function log(...a) { console.log('[e2e]', ...a); }
function which(bin) { return spawnSync('sh', ['-c', `command -v ${bin}`]).status === 0; }

async function runEngine(workDir, prompt) {
  return await new Promise((resolve) => {
    const child = spawn('opencode', ['run', '-m', ENGINE_MODEL, '--auto', '--dir', workDir, prompt], {
      cwd: workDir, env: process.env, timeout: 12 * 60 * 1000,
    });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { err += d.toString(); });
    child.on('close', code => resolve({ code, out, err }));
    child.on('error', e => resolve({ code: -1, out, err: e.message }));
  });
}

function structuralChecks(long, short) {
  const issues = [];
  const has = (t, re) => re.test(t || '');
  if (!long || long.trim().length < 400) issues.push('long.md пустой или слишком короткий');
  if (!short || short.trim().length < 200) issues.push('short.md пустой или слишком короткий');
  if (!has(long, /требован|система должна|должна|функциональн/i)) issues.push('long: нет требований');
  if (!has(long, /этап|срок|недел|месяц|график/i)) issues.push('long: нет этапов/сроков');
  if (!has(long, /интеграц|api/i)) issues.push('long: нет интеграций');
  if (!has(short, /проблем|объ[её]м|срок|стоимост|цен|риск|решени/i)) issues.push('short: нет обязательных разделов (проблема/объём/сроки/цена/риски)');
  if (/(?:…|\.\.\.)\s*$/.test((long || '').trim())) issues.push('long: документ оборван');
  return issues;
}

async function judge(input, long, short) {
  const prompt = [
    'Ты — приёмочный судья. На вход: исходный запрос клиента, требования к структуре и полученное ТЗ.',
    'Оцени: получилась ли из исходного запроса полноценная, пригодная к передаче разработчику спецификация, содержащая необходимую информацию?',
    'Не оценивай красоту формулировок и не сравнивай с эталоном. Верни СТРОГО JSON: {"verdict":"PASS"|"FAIL","reasons":["..."]}.',
    'Требования к структуре: long — цель/объём, требования, интеграции, этапы/сроки, критерии приёмки; short — проблема, объём, сроки, цена, риски, результат. Обе — о СИСТЕМЕ, не конспект разговора.',
    'Исходный запрос:\n' + input,
    'Long:\n' + long.slice(0, 9000),
    'Short:\n' + short.slice(0, 4000),
  ].join('\n\n');
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENROUTER_KEY}` },
    body: JSON.stringify({ model: JUDGE_MODEL, max_tokens: 700, temperature: 0, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`judge HTTP ${res.status}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`judge: no JSON in answer: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(m[0]);
  return { verdict: String(parsed.verdict || '').toUpperCase(), reasons: parsed.reasons || [] };
}

function firstProjectDir(usersDir, profile) {
  const root = path.join(usersDir, profile, 'Фриланс проекты');
  if (!fs.existsSync(root)) return null;
  const dirs = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
  return dirs.length ? path.join(root, dirs[0]) : null;
}

async function main() {
  if (!which('opencode')) { log('SKIP: opencode not found (needs the production engine).'); process.exit(0); }
  const input = fs.readFileSync(FIXTURE, 'utf8');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freelance-e2e-'));
  const usersDir = path.join(root, 'users');
  const profile = 'e2e';
  const workDir = path.join(usersDir, profile);
  fs.mkdirSync(workDir, { recursive: true });

  fs.writeFileSync(path.join(workDir, 'opencode.json'), JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    mcp: { 'freelance-skills': { type: 'local', command: ['node', path.join(REPO, 'src', 'mcp-skills', 'index.js')],
      environment: { USER_ID: profile, USERS_DIR: usersDir, AGENT_TOKENS_DIR: path.join(root, 'agent-tokens') } } },
  }, null, 2));

  const task = [
    'Это тест сквозного процесса. Действуй без вопросов.',
    'Ниже — исходный запрос клиента. Создай фриланс-проект (freelance_new_project) и сгенерируй ТЗ:',
    'вызови freelance_generate_spec (variants=both), выполни его инструкцию — нормализуй контекст в spec/_source.md,',
    'затем сгенерируй long.md и short.md независимо, по правилам документа. Не задавай вопросов.',
    '', '--- ИСХОДНЫЙ ЗАПРОС ---', input,
  ].join('\n');

  log(`engine=${ENGINE_MODEL} judge=${JUDGE_MODEL} workdir=${workDir}`);
  const run = await runEngine(workDir, task);
  if (run.code !== 0) log(`engine exit ${run.code}; tail: ${(run.err || run.out).slice(-400)}`);

  const projectDir = firstProjectDir(usersDir, profile);
  const longPath = projectDir && path.join(projectDir, 'spec', 'long.md');
  const shortPath = projectDir && path.join(projectDir, 'spec', 'short.md');
  const long = longPath && fs.existsSync(longPath) ? fs.readFileSync(longPath, 'utf8') : '';
  const short = shortPath && fs.existsSync(shortPath) ? fs.readFileSync(shortPath, 'utf8') : '';

  const structural = structuralChecks(long, short);
  log(`project=${projectDir || '(none)'} long=${long.length}b short=${short.length}b`);
  log(structural.length ? `structural issues: ${structural.join('; ')}` : 'structural: ok');

  let judgeResult = null;
  if (!OPENROUTER_KEY) log('judge: SKIPPED (no OPENROUTER_API_KEY)');
  else if (!long && !short) log('judge: SKIPPED (no documents)');
  else {
    try { judgeResult = await judge(input, long, short); log(`judge: ${judgeResult.verdict} — ${(judgeResult.reasons || []).join('; ')}`); }
    catch (e) { log(`judge: ERROR ${e.message}`); }
  }

  const failed = structural.length > 0 || (judgeResult && judgeResult.verdict !== 'PASS');
  console.log(`\n[e2e] RESULT: ${failed ? 'FAIL' : 'PASS'}`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('[e2e] fatal:', e?.message || e); process.exit(1); });
