'use strict';

// sync-provider-manifest.cjs — keep provider-manifest.json's inputSchema in lock
// step with the live tool modules (the contract suite asserts exact parity with
// `tools/list`). Action-level policy (allowedTriggers/effect/requiresApproval/
// retrySafety) is hand-authored and preserved; only inputSchema is refreshed.
//
// Run: npm run sync:manifest
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const manifestPath = path.join(REPO, 'provider-manifest.json');

process.env.USER_ID = process.env.USER_ID || 'manifest-sync';
const registry = require(path.join(REPO, 'src', 'mcp-skills', 'registry.js'));
const live = new Map(registry.listTools().map((t) => [t.name, t]));

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const missing = [];
for (const action of manifest.actions) {
  const tool = live.get(action.name);
  if (!tool) { missing.push(action.name); continue; }
  action.inputSchema = tool.inputSchema || { type: 'object', properties: {} };
}
const extra = [...live.keys()].filter((name) => !manifest.actions.some((a) => a.name === name));
if (missing.length) throw new Error(`provider-manifest declares actions with no tool: ${missing.join(', ')}`);
if (extra.length) throw new Error(`tools missing from provider-manifest: ${extra.join(', ')}`);

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`synced ${manifest.actions.length} action schemas from live tools`);
