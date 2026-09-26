'use strict';
// L3 — Guards: static gates mirroring the core CI gates
// (docs/domain-skill-repo-test-rules.md §1). No tests, no network — grep only.
//
//   * quick-action MCP tools never spawn Claude / opencode / runner.js
//   * every outbound fetch/HTTP call carries a timeout (AbortSignal.timeout)
//   * secrets / tokens are never logged
//   * storage paths go through the resolver, never os.homedir()/process.cwd()
//     inside a tool module
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const SRC = path.join(REPO, 'src');
const TOOLS = path.join(SRC, 'mcp-skills', 'tools');

const violations = [];
const fail = (check, file, detail) => violations.push(`[${check}] ${path.relative(REPO, file)}: ${detail}`);

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const srcFiles = walk(SRC);
const toolFiles = walk(TOOLS);

// 1. No Claude/opencode/runner spawn from a quick-action tool. `execFileSync('git')`
//    (revision stamping) is allowed; spawning an agent is not.
const SPAWN_RE = /spawn\s*\(|execSync\s*\(|exec\s*\(|execFile\s*\(|opencode|runner\.js|\bclaude\b/;
for (const file of toolFiles) {
  const text = fs.readFileSync(file, 'utf8');
  for (const [i, line] of text.split('\n').entries()) {
    const stripped = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
    if (SPAWN_RE.test(stripped)) fail('no-agent-spawn', file, `line ${i + 1}: ${line.trim()}`);
  }
}

// 2. Every outbound HTTP call must set a timeout.
for (const file of srcFiles) {
  const text = fs.readFileSync(file, 'utf8');
  const usesNetwork = /\bfetch\s*\(|https?\.request\s*\(/.test(text);
  if (usesNetwork && !text.includes('AbortSignal.timeout')) {
    fail('http-timeout', file, 'outbound call without AbortSignal.timeout');
  }
}

// 3. Never log secrets/tokens.
const SECRET_LOG_RE = /console\.[a-z]+\([^)]*(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|secret|password)/i;
for (const file of srcFiles) {
  const text = fs.readFileSync(file, 'utf8');
  for (const [i, line] of text.split('\n').entries()) {
    if (SECRET_LOG_RE.test(line)) fail('no-secret-logs', file, `line ${i + 1}: ${line.trim()}`);
  }
}

// 4. Tool modules resolve storage through lib/paths — never the ambient home/cwd.
for (const file of toolFiles) {
  const text = fs.readFileSync(file, 'utf8');
  for (const [i, line] of text.split('\n').entries()) {
    const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
    if (/os\.homedir\s*\(/.test(code) || /process\.cwd\s*\(/.test(code)) {
      fail('path-resolver', file, `line ${i + 1}: ${line.trim()}`);
    }
  }
}

if (violations.length) {
  console.error('GUARDS FAILED:');
  for (const v of violations) console.error('  ' + v);
  process.exitCode = 1;
} else {
  console.log(`guards OK (${toolFiles.length} tool files, ${srcFiles.length} source files)`);
}
