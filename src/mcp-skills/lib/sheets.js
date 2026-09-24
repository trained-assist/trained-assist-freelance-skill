'use strict';
// Google Sheets export — ported from trained-assist-agent's 94-outsource-project.js.
// Self-contained: reads the same gdrive service-account file at
// ~/agent-tokens/<profile>/gdrive (or $AGENT_TOKENS_DIR/<profile>/gdrive).
// Entirely optional — every caller must handle `readSa()` returning null.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

function tokensRoot() {
  return process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
}

function readSa(username) {
  if (!username) return null;
  try {
    const raw = fs.readFileSync(path.join(tokensRoot(), username, 'gdrive'), 'utf8').trim();
    return JSON.parse(raw);
  } catch { return null; }
}

function makeJwt(sa) {
  const now = Math.floor(Date.now() / 1000);
  const hdr = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const pay = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  })).toString('base64url');
  const unsigned = `${hdr}.${pay}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(unsigned);
  return `${unsigned}.${sign.sign(sa.private_key, 'base64url')}`;
}

const _tok = new Map();
async function getAccessToken(sa) {
  const c = _tok.get(sa.client_email);
  if (c && Date.now() < c.exp) return c.token;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${makeJwt(sa)}`,
    signal: AbortSignal.timeout(10000),
  });
  const d = await res.json();
  if (!d.access_token) throw new Error(`Google OAuth: ${JSON.stringify(d)}`);
  _tok.set(sa.client_email, { token: d.access_token, exp: Date.now() + 3_550_000 });
  return d.access_token;
}

async function sheetsReq(method, apiPath, body, sa) {
  const token = await getAccessToken(sa);
  const res = await fetch(`https://sheets.googleapis.com/v4${apiPath}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body != null ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Sheets ${res.status}: ${data.error?.message || JSON.stringify(data)}`);
  return data;
}

async function driveReq(method, apiPath, body, sa) {
  const token = await getAccessToken(sa);
  const res = await fetch(`https://www.googleapis.com/drive/v3${apiPath}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body != null ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 204) return null;
  const data = await res.json();
  if (!res.ok) throw new Error(`Drive ${res.status}: ${data.error?.message || JSON.stringify(data)}`);
  return data;
}

const QUOTA_ERROR_MARKER = 'storage quota';

function explainSheetError(e, sa) {
  if (String(e.message || '').toLowerCase().includes(QUOTA_ERROR_MARKER)) {
    const email = sa?.client_email || '(email сервисного аккаунта)';
    return new Error(
      `Google не даёт сервисному аккаунту создавать файлы в обычной папке — это ограничение ` +
      `Google (Service Accounts do not have storage quota), а не прав доступа. ` +
      `Обходной путь: создай в Google Drive пустой Google Sheet сам, пошарь именно ФАЙЛ ` +
      `(не папку) с ${email} с правом Editor, затем передай его ID в spreadsheet_id — ` +
      `таблица будет использована как есть, без попытки создать новую.`
    );
  }
  return e;
}

async function createSpreadsheet(title, tabs, sa, folderId) {
  let r;
  try {
    r = await sheetsReq('POST', '/spreadsheets', {
      properties: { title },
      sheets: tabs.map((t, i) => ({ properties: { title: t, sheetId: i, index: i } })),
    }, sa);
  } catch (e) {
    throw explainSheetError(e, sa);
  }
  const id = r.spreadsheetId;

  if (folderId) {
    const meta = await driveReq('GET', `/files/${id}?fields=parents`, null, sa);
    const oldParents = (meta.parents || []).join(',');
    await driveReq('PATCH', `/files/${id}?addParents=${folderId}&removeParents=${oldParents}&fields=id`, null, sa);
  } else {
    await driveReq('POST', `/files/${id}/permissions`, { type: 'anyone', role: 'writer' }, sa);
  }

  return { id, url: `https://docs.google.com/spreadsheets/d/${id}` };
}

async function writeTab(spreadsheetId, tab, rows, sa) {
  await sheetsReq('PUT',
    `/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(tab + '!A1')}?valueInputOption=USER_ENTERED`,
    { values: rows }, sa
  );
}

module.exports = { readSa, createSpreadsheet, writeTab, explainSheetError };
