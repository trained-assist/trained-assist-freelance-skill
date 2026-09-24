'use strict';
// Path resolution for this skill — mirrors trained-assist-agent's src/data-paths.js
// convention (USERS_DIR env var, profile root = USERS_ROOT/<username>) so this repo
// stays consistent with core even though it can't import that file directly (separate repo).
//
// Everything this skill stores lives at the PROFILE ROOT, never at process.cwd().
// process.cwd() when Claude runs is the per-Telegram-topic project workDir, which is
// picked by the bot before the session starts and is NOT a stable home for a freelance
// client project — the same project gets discussed across different topics/sessions,
// and unrelated projects can land in the same topic. See README.md "Why profile root".

const fs = require('fs');
const path = require('path');
const os = require('os');

const USERS_ROOT = process.env.USERS_DIR || path.join(os.homedir(), 'users');

function profileRoot(username) {
  if (!username) throw new Error('username required (USER_ID/AGENT_USER_ID not set)');
  return path.join(USERS_ROOT, String(username));
}

// Cyrillic folder name is intentional — this is the user-facing convention the
// profile owner chose ("Фриланс проекты"), consistent with other Cyrillic paths
// already used in this profile's workspace (contexts/, project folders).
const FREELANCE_DIRNAME = 'Фриланс проекты';

function freelanceRoot(username) {
  return path.join(profileRoot(username), FREELANCE_DIRNAME);
}

function indexPath(username) {
  return path.join(freelanceRoot(username), '_index.json');
}

function recentContextPath(username) {
  return path.join(freelanceRoot(username), '_classifier', 'recent-context.json');
}

function projectDir(username, slug) {
  return path.join(freelanceRoot(username), slug);
}

function projectFile(username, slug, ...segments) {
  return path.join(projectDir(username, slug), ...segments);
}

// ── Final-document paths (spec/) ─────────────────────────────────────────────
// The spec pipeline produces two INDEPENDENT client-facing documents per project
// (`long.md`, `short.md`), plus a normalized intermediate source (`_source.md`)
// that is the single input both variants are generated from. Legacy single
// `tz.md` is kept read-compatible (see freelance_get_spec).
const SPEC_VARIANTS = ['long', 'short'];

function specDir(username, slug) {
  return projectFile(username, slug, 'spec');
}

function specFile(username, slug, variant) {
  if (!SPEC_VARIANTS.includes(variant)) throw new Error(`Unknown spec variant: ${variant}`);
  return projectFile(username, slug, 'spec', `${variant}.md`);
}

function legacySpecFile(username, slug) {
  return projectFile(username, slug, 'spec', 'tz.md');
}

// Normalized requirements/solution context written before generation, so the
// "source materials → normalized requirements → spec" split is persisted and
// re-used by both variants.
function specSourcePath(username, slug) {
  return projectFile(username, slug, 'spec', '_source.md');
}

// ── Persistent generation notes ──────────────────────────────────────────────
// One-time user instructions ("всегда делай ТЗ техничнее", "никогда не писать
// «клиент сказал»"). Profile-level applies to every project of the profile;
// project-level applies to one project and wins.
function profileGenerationNotePath(username) {
  return path.join(freelanceRoot(username), '_generation.md');
}

function projectGenerationNotePath(username, slug) {
  return projectFile(username, slug, 'generation.md');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = {
  USERS_ROOT,
  FREELANCE_DIRNAME,
  SPEC_VARIANTS,
  profileRoot,
  freelanceRoot,
  indexPath,
  recentContextPath,
  projectDir,
  projectFile,
  specDir,
  specFile,
  legacySpecFile,
  specSourcePath,
  profileGenerationNotePath,
  projectGenerationNotePath,
  ensureDir,
};
