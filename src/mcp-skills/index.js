#!/usr/bin/env node
// MCP server — freelance-skills
// Raw JSON-RPC 2.0 over stdio (no SDK dependency, avoids ESM/CJS issues)
// Mirrors trained-assist-agent's src/mcp-skills/index.js exactly — same contract,
// so this repo plugs into a profile's .mcp.json the same way trained-assist-hh-skill does.
'use strict';

const readline = require('readline');
const registry = require('./registry.js');

const rl = readline.createInterface({ input: process.stdin, terminal: false });

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

rl.on('line', async (line) => {
  line = line.trim();
  if (!line) return;

  let req;
  try { req = JSON.parse(line); } catch { return; }

  const { id, method, params } = req;

  // Notifications have no id — no response needed
  if (id === undefined || id === null) return;

  try {
    if (method === 'initialize') {
      respond(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'freelance-skills', version: '1.0.0' },
      });

    } else if (method === 'tools/list') {
      respond(id, { tools: registry.listTools() });

    } else if (method === 'tools/call') {
      const { name, arguments: args } = params || {};
      try {
        const result = await registry.callTool(name, args || {});
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        respond(id, { content: [{ type: 'text', text }] });
      } catch (e) {
        // Tool execution errors are reported in-band (`isError`), not as a
        // JSON-RPC fault and never as a process crash — the MCP tools contract.
        respond(id, { content: [{ type: 'text', text: e.message }], isError: true });
      }

    } else {
      respondError(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    respondError(id, -32603, e.message);
  }
});

// Keep process alive while stdin is open
process.stdin.resume();
