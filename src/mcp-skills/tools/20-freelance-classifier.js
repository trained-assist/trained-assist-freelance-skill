'use strict';

// Incoming-document classifier — routes a new message/file to an existing
// freelance project or flags it as a new one. Cheap LLM only (OpenRouter),
// mirroring the rule this pattern follows elsewhere in the trained-assist
// ecosystem for quick/routing tools: never spawn a full Claude Code session
// just to classify text. Content dominates; filename and recency are weak
// supporting signals only — a single prior document must never be enough by
// itself to auto-route the next one to the same project.

const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const USER_ID = process.env.USER_ID || process.env.AGENT_USER_ID || '';

const { freelanceRoot, recentContextPath, ensureDir, projectFile } = require('../lib/paths');

function tokensRoot() {
  return process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
}

function readOrKey() {
  try {
    const f = path.join(tokensRoot(), USER_ID, 'openrouter');
    if (fs.existsSync(f)) {
      const key = fs.readFileSync(f, 'utf8').trim();
      if (key) return key;
    }
  } catch { /* fall through */ }
  return process.env.OPENROUTER_API_KEY || null;
}

const FAST_MODEL = 'deepseek/deepseek-v4-flash-0731';

function llmCall(apiKey, model, messages, maxTokens = 800, temperature = 0.1) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model, messages, temperature, max_tokens: maxTokens });
    const req = https.request({
      hostname: 'openrouter.ai',
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (parsed.error) return reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
          const content = parsed.choices?.[0]?.message?.content;
          if (content == null) return reject(new Error(`LLM returned empty content (model: ${model})`));
          resolve(content);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function parseLlmJson(content) {
  content = content.trim();
  const fence = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) content = fence[1].trim();
  return JSON.parse(content);
}

function readIndex() {
  const f = path.join(freelanceRoot(USER_ID), '_index.json');
  if (!fs.existsSync(f)) return [];
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return []; }
}

function readRecentContext() {
  const f = recentContextPath(USER_ID);
  if (!fs.existsSync(f)) return [];
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return []; }
}

function appendRecentContext(entry) {
  const f = recentContextPath(USER_ID);
  ensureDir(path.dirname(f));
  const list = readRecentContext();
  list.push({ at: new Date().toISOString(), ...entry });
  fs.writeFileSync(f, JSON.stringify(list.slice(-50), null, 2));
}

function projectCorpus(slug) {
  const read = (f) => { try { return fs.readFileSync(projectFile(USER_ID, slug, f), 'utf8'); } catch { return ''; } };
  return `${read('facts.md')}\n${read('requirements.md')}`.slice(0, 4000);
}

const HIGH_CONFIDENCE = 0.72;
const MIN_MARGIN = 0.15; // top candidate must clear the runner-up by this much to auto-file

module.exports = {
  isReady: () => true,

  tools: {

    freelance_classify_document: {
      description: [
        'Классифицировать новый входящий документ/сообщение: относится ли он к существующему фриланс-проекту или это новый проект.',
        'Content > filename. Recency — это prior (несколько документов подряд по одному проекту повышают уверенность),',
        'НИКОГДА не единственное основание — один предыдущий документ не даёт права молча приписать следующий к тому же проекту.',
        `confidence >= ${HIGH_CONFIDENCE} с отрывом от второго места >= ${MIN_MARGIN} — можно авто-приписать. Иначе — вернуть кандидатов, НЕ угадывать.`,
      ].join(' '),
      inputSchema: {
        type: 'object',
        required: ['text'],
        properties: {
          text: { type: 'string', description: 'Текст документа/сообщения (или содержимое файла)' },
          filename: { type: 'string', description: 'Имя файла, если есть — слабый сигнал, не решающий' },
        },
      },
      handler: async ({ text, filename }) => {
        const projects = readIndex().filter(p => p.status === 'active');
        if (projects.length === 0) {
          return { new_project: true, confidence: 1, candidates: [], message: 'Активных проектов нет — это новый проект.' };
        }

        const recent = readRecentContext().slice(-5);
        const recentSummary = recent.length
          ? recent.map(r => `- ${r.at}: ${r.assigned_project_id || 'new'} (conf ${r.confidence ?? '?'}, ${r.resolved_by})`).join('\n')
          : '(нет недавней истории)';

        const corpusBlocks = projects.map(p => `### ${p.slug} — ${p.name}\n${projectCorpus(p.slug)}`).join('\n\n');

        const apiKey = readOrKey();
        let result;
        if (apiKey) {
          const prompt = [
            'Ты классифицируешь новый входящий документ по фриланс-проектам заказчика.',
            'Верни СТРОГО JSON: {"ranked":[{"project_id":"<slug>","confidence":0..1,"why":"..."}, ...], "likely_new": true|false}.',
            'Ранжируй по content, не по имени файла. Учитывай recency ТОЛЬКО как слабый дополнительный сигнал, не решающий.',
            '',
            `Имя файла (слабый сигнал): ${filename || '(нет)'}`,
            '',
            'Недавняя история классификации (recency prior):',
            recentSummary,
            '',
            'Активные проекты и их факты/требования:',
            corpusBlocks,
            '',
            'Новый документ:',
            text.slice(0, 6000),
          ].join('\n');

          try {
            const raw = await llmCall(apiKey, FAST_MODEL, [{ role: 'user', content: prompt }]);
            result = parseLlmJson(raw);
          } catch (e) {
            result = { ranked: [], likely_new: true, _llm_error: e.message };
          }
        } else {
          result = { ranked: [], likely_new: true, _no_api_key: true };
        }

        const ranked = (result.ranked || []).filter(r => projects.some(p => p.slug === r.project_id)).sort((a, b) => b.confidence - a.confidence);
        const top = ranked[0];
        const second = ranked[1];
        const margin = top ? top.confidence - (second?.confidence || 0) : 0;
        const autoFile = !!top && top.confidence >= HIGH_CONFIDENCE && margin >= MIN_MARGIN;

        appendRecentContext({
          source_summary: text.slice(0, 200),
          assigned_project_id: autoFile ? top.project_id : null,
          confidence: top?.confidence ?? null,
          resolved_by: autoFile ? 'auto' : 'pending_user',
        });

        if (autoFile) {
          return {
            new_project: false, auto_filed: true, project_id: top.project_id,
            confidence: top.confidence, why: top.why,
            message: `Высокая уверенность (${top.confidence}) — отнесено к проекту ${top.project_id}.`,
          };
        }

        return {
          new_project: !!result.likely_new && ranked.length === 0,
          auto_filed: false,
          candidates: ranked.slice(0, 3).map(r => ({ project_id: r.project_id, confidence: r.confidence, why: r.why })),
          message: ranked.length
            ? `Недостаточная уверенность для авто-классификации (топ ${top?.confidence ?? '?'}, отрыв ${margin.toFixed(2)}). Спроси пользователя, к какому проекту это относится, или создавай новый.`
            : 'Похоже на новый проект — совпадений с существующими не найдено.',
          _note: result._no_api_key ? 'OPENROUTER_API_KEY не настроен — классификация недоступна, спроси пользователя явно.' : (result._llm_error ? `LLM error: ${result._llm_error}` : undefined),
        };
      },
    },

  },
};
