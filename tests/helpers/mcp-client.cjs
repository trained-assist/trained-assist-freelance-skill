'use strict';
// Spawn the real MCP skills server as a subprocess and speak JSON-RPC 2.0 over
// stdio — the executable contract, never a direct handler call. Mirrors
// trained-assist-agent tests/helpers/mcp.js, adapted for this repo's entrypoint.
const { spawn } = require('child_process');
const { createInterface } = require('readline');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const MCP_ENTRY = path.join(REPO, 'src', 'mcp-skills', 'index.js');

function freshProfileEnv(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freelance-mcp-'));
  const userId = extra.userId || 'mcp-test-user';
  const env = {
    PATH: process.env.PATH,
    HOME: path.join(root, 'home'),
    USER_ID: userId,
    USERS_DIR: extra.usersDir || path.join(root, 'users'),
    AGENT_TOKENS_DIR: extra.tokensDir || path.join(root, 'agent-tokens'),
    AGENT_DATA_DIR: extra.agentDataDir || path.join(root, 'data'),
    ...extra.env,
  };
  // When this helper itself runs under the staging replay gate, the spawned MCP
  // child inherits the guard preload + isolated roots so outbound stays blocked.
  for (const key of ['STAGING_ROOT', 'STAGING_ISOLATION', 'STAGING_BLOCKED_LOG', 'STAGING_RUNNER_PID', 'NODE_OPTIONS', 'TMPDIR']) {
    if (process.env[key] && !(key in env)) env[key] = process.env[key];
  }
  fs.mkdirSync(env.HOME, { recursive: true });
  fs.mkdirSync(env.USERS_DIR, { recursive: true });
  fs.mkdirSync(env.AGENT_TOKENS_DIR, { recursive: true });
  fs.mkdirSync(env.AGENT_DATA_DIR, { recursive: true });
  delete env.OPENROUTER_API_KEY;
  return { root, env };
}

async function startMcpServer({
  workDir = REPO,
  userId = 'mcp-test-user',
  usersDir,
  tokensDir,
  env: extraEnv = {},
  timeoutMs = 10000,
} = {}) {
  const { root, env } = freshProfileEnv({ userId, usersDir, tokensDir, env: extraEnv });
  const proc = spawn(process.execPath, [MCP_ENTRY], { cwd: workDir, env, stdio: ['pipe', 'pipe', 'pipe'] });

  const rl = createInterface({ input: proc.stdout, terminal: false });
  let seq = 0;
  const pending = new Map();

  rl.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id == null || !pending.has(msg.id)) return;
    const { resolve, reject, timer } = pending.get(msg.id);
    pending.delete(msg.id);
    clearTimeout(timer);
    if (msg.error) reject(Object.assign(new Error(msg.error.message), { rpcCode: msg.error.code }));
    else resolve(msg.result);
  });

  proc.stderr.on('data', (d) => process.stderr.write(`[mcp:${userId}] ${d}`));

  function call(method, params = {}) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP call timed out: ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  await call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'freelance-ci', version: '1.0' },
  });

  return {
    call,
    callTool: (name, args = {}) => call('tools/call', { name, arguments: args }),
    root,
    env,
    stop: () => new Promise((resolve) => {
      try { proc.kill(); } catch { /* already gone */ }
      proc.on('close', () => { fs.rmSync(root, { recursive: true, force: true }); resolve(); });
    }),
  };
}

module.exports = { startMcpServer, freshProfileEnv, MCP_ENTRY, REPO };
