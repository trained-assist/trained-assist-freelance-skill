#!/usr/bin/env node
'use strict';
// Minimal standalone Telegram bot + Claude Code runner for this skill only.
// Deliberately decoupled from trained-assist-agent's server/runner/session code
// (per an explicit "don't touch the huge project's code yet" decision) — runs on
// the same shared VM under the same user, in its own directory, with its own
// bot token and its own tiny per-chat workspace. Long-polling, no framework,
// no dependencies beyond Node's built-ins — intentionally small.
//
// Once this is debugged and proven, the plan is to integrate it into
// trained-assist-agent properly (as a sibling MCP skill, like trained-assist-hh-skill)
// rather than keep running it as a separate bot forever.

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.FREELANCE_BOT_DATA_DIR || path.join(os.homedir(), 'freelance-bot-data');
const USERS_DIR = path.join(DATA_DIR, 'users');
const STATE_FILE = path.join(DATA_DIR, 'bot-state.json');
const TOKEN_FILE = process.env.FREELANCE_BOT_TOKEN_FILE || path.join(DATA_DIR, 'bot-token');

// opencode + DeepSeek instead of Claude Code — much cheaper for this bot's volume.
// "opencode-go/deepseek-v4.1-flash" is the VM's existing `deepseek-go` opencode
// profile's model (~/*/​.opencode/profiles/deepseek-go.json), already authenticated
// via ~/.local/share/opencode/auth.json — invoked directly per-task with -m so we
// never touch the machine-wide ~/.config/opencode/opencode.json, which other
// concurrent sessions/repos on this VM also read.
const AGENT_MODEL = process.env.FREELANCE_BOT_MODEL || 'opencode-go/deepseek-v4.1-flash';

function readToken() {
  if (process.env.FREELANCE_BOT_TOKEN) return process.env.FREELANCE_BOT_TOKEN.trim();
  return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
}

const TOKEN = readToken();

function tg(method, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TOKEN}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function downloadFile(filePath, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(`https://api.telegram.org/file/bot${TOKEN}/${filePath}`, (res) => {
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(destPath)));
    }).on('error', (e) => { fs.unlink(destPath, () => {}); reject(e); });
  });
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { offset: 0 }; }
}
function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function profileForChat(chatId) {
  return `chat-${chatId}`;
}

function ensureWorkspace(profile) {
  const workDir = path.join(USERS_DIR, profile);
  fs.mkdirSync(path.join(workDir, 'intake'), { recursive: true });

  // Project-local opencode.json — ONLY this repo's own MCP server, nothing from
  // trained-assist-agent. opencode merges this with the machine-wide
  // ~/.config/opencode/opencode.json rather than replacing it, so this is safe
  // to write without touching that shared file.
  const mcpEnv = {
    USER_ID: profile,
    USERS_DIR,
    AGENT_TOKENS_DIR: path.join(DATA_DIR, 'agent-tokens'),
    ...(process.env.OPENROUTER_API_KEY ? { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY } : {}),
  };
  const opencodeConfig = {
    $schema: 'https://opencode.ai/config.json',
    mcp: {
      'freelance-skills': {
        type: 'local',
        command: ['node', path.join(REPO_ROOT, 'src', 'mcp-skills', 'index.js')],
        environment: mcpEnv,
      },
    },
  };
  fs.writeFileSync(path.join(workDir, 'opencode.json'), JSON.stringify(opencodeConfig, null, 2));
  return workDir;
}

function runAgent(workDir, prompt) {
  return new Promise((resolve) => {
    const args = ['run', '-m', AGENT_MODEL, '--auto', '--dir', workDir, prompt];
    const child = spawn('opencode', args, {
      cwd: workDir,
      env: process.env,
      timeout: 10 * 60 * 1000,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { err += d.toString(); });
    child.on('close', (code) => resolve({ code, out: stripAnsi(out), err }));
    child.on('error', (e) => resolve({ code: -1, out, err: e.message }));
  });
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function stripAnsi(s) {
  const lines = s.split('\n').map(line => line.replace(ANSI_RE, ''));
  const out = [];
  for (const line of lines) {
    if (line.trim() === '' && out[out.length - 1] === '') continue; // collapse repeated blank lines
    out.push(line);
  }
  return out.join('\n').trim();
}

// Telegram messages cap at 4096 chars — split on paragraph boundaries.
async function sendLong(chatId, text) {
  const MAX = 3500;
  if (!text) text = '(пусто)';
  const chunks = [];
  let rest = text;
  while (rest.length > MAX) {
    let cut = rest.lastIndexOf('\n', MAX);
    if (cut < MAX * 0.5) cut = MAX;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  chunks.push(rest);
  for (const c of chunks) {
    await tg('sendMessage', { chat_id: chatId, text: c });
  }
}

const WELCOME_TEXT = [
  'Привет! Это фриланс-скилл: присылай сюда описания заказов, файлы, скриншоты —',
  'разложу по проектам (факты/требования/наше решение отдельно) и дам GO/NO-GO риск-оценку.',
  'Пиши обычным текстом, что нужно — не команду.',
].join(' ');

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const profile = profileForChat(chatId);

  // Handle Telegram's own bot commands at the bot level, before ever reaching
  // the agent — found the hard way that forwarding a leading "/" straight into
  // an agent CLI's --print/run message gets misparsed as the CLI's OWN slash
  // command (e.g. Claude Code's --print '/start' -> "Unknown command: /start"
  // instead of being treated as plain user text).
  if (msg.text && /^\/start\b/.test(msg.text.trim())) {
    console.log(`[bot] /start from chat ${chatId}`);
    ensureWorkspace(profile);
    await tg('sendMessage', { chat_id: chatId, text: WELCOME_TEXT });
    return;
  }

  const workDir = ensureWorkspace(profile);

  let taskParts = [];
  if (msg.text) taskParts.push(msg.text);

  const fileRefs = [];
  const attachment = msg.document || (msg.photo && msg.photo[msg.photo.length - 1]);
  if (attachment) {
    try {
      const info = await tg('getFile', { file_id: attachment.file_id });
      const tgPath = info.result?.file_path;
      if (tgPath) {
        const ext = path.extname(tgPath) || (msg.photo ? '.jpg' : '');
        const destName = `${Date.now()}-${attachment.file_unique_id}${ext}`;
        const dest = path.join(workDir, 'intake', destName);
        await downloadFile(tgPath, dest);
        fileRefs.push(path.join('intake', destName));
      }
    } catch (e) {
      await tg('sendMessage', { chat_id: chatId, text: `⚠️ Не удалось скачать файл: ${e.message}` });
    }
  }
  if (msg.caption) taskParts.push(msg.caption);
  if (fileRefs.length) taskParts.push(`[Файл сохранён: ${fileRefs.join(', ')}]`);

  const task = taskParts.join('\n').trim();
  if (!task) return;

  console.log(`[bot] chat ${chatId}: running (${task.length} chars)`);
  await tg('sendMessage', { chat_id: chatId, text: '⏳ Обрабатываю...' });
  const { code, out, err } = await runAgent(workDir, task);
  console.log(`[bot] chat ${chatId}: done, code=${code}, out=${out.length} chars, err=${err.length} chars`);
  if (code !== 0 && !out) {
    await sendLong(chatId, `❌ Ошибка (code ${code}): ${err.slice(0, 1500) || '(нет вывода)'}`);
    return;
  }
  await sendLong(chatId, out || err || '(пустой ответ)');
}

// Serialize messages per chat — two concurrent `claude` processes writing into
// the same profile's "Фриланс проекты" files at once is a real corruption risk,
// not just a nicety, given everything here is plain JSON/markdown on disk.
const chatQueues = new Map();
function enqueue(chatId, fn) {
  const prev = chatQueues.get(chatId) || Promise.resolve();
  const next = prev.then(fn, fn).finally(() => {
    if (chatQueues.get(chatId) === next) chatQueues.delete(chatId);
  });
  chatQueues.set(chatId, next);
  return next;
}

async function poll() {
  const state = readState();
  for (;;) {
    let updates;
    try {
      const res = await tg('getUpdates', { offset: state.offset, timeout: 25 });
      updates = res.result || [];
    } catch (e) {
      console.error('[bot] getUpdates error:', e.message);
      await new Promise(r => setTimeout(r, 5000));
      continue;
    }
    for (const u of updates) {
      state.offset = u.update_id + 1;
      writeState(state);
      if (u.message) {
        const chatId = u.message.chat.id;
        console.log(`[bot] update ${u.update_id} from chat ${chatId}: ${(u.message.text || '[non-text]').slice(0, 80)}`);
        enqueue(chatId, () => handleMessage(u.message)).catch(e => console.error('[bot] handleMessage error:', e.message, e.stack));
      }
    }
  }
}

console.log(`[bot] starting, data dir: ${DATA_DIR}`);
fs.mkdirSync(DATA_DIR, { recursive: true });
poll();
