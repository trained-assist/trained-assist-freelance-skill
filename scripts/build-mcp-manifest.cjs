'use strict';

// build-mcp-manifest.cjs — deterministic builder for `mcp.manifest.json`, the
// reviewed descriptor this domain skill exposes to the Agent Control Plane.
//
// Contract rules (docs/domain-skill-repo-test-rules.md §1 L1):
//   * `mcp.manifest.json` conforms to contracts/mcp-skill-sources.schema.json.
//   * `artifactDigest` is a sha256 over the content-addressed artifact bundle
//     (provider manifest + command surface + every MCP tool file), and CI
//     recomputes it — so a manifest/tool change cannot land without a manifest
//     refresh, and a stale digest is a hard failure.
//   * `revision` is the repo revision the descriptor was built at (40-hex).
//   * `approvedManifest` is byte-identical to provider-manifest.json (the rich
//     v2 catalog the real core ActionProviderRegistry consumes).
//
// Run: npm run build:manifest
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const PROVIDER_MANIFEST = 'provider-manifest.json';
const TOOLS_DIR = path.join(REPO, 'src', 'mcp-skills', 'tools');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function listToolFiles() {
  return fs.readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.js')).sort();
}

// Canonical, order-independent bundle: file name, length and bytes, mirroring
// the staging gate's source digest. Changing a tool byte changes the digest;
// reordering the directory does not.
function computeArtifactDigest() {
  const hash = crypto.createHash('sha256');
  const files = [PROVIDER_MANIFEST, 'commands.json', ...listToolFiles().map((f) => path.join('src', 'mcp-skills', 'tools', f))];
  for (const rel of files) {
    const bytes = fs.readFileSync(path.join(REPO, rel));
    hash.update(JSON.stringify([rel, bytes.length]));
    hash.update(bytes);
  }
  return hash.digest('hex');
}

function currentRevision() {
  if (process.env.SKILL_REVISION) return process.env.SKILL_REVISION;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  } catch {
    return '0'.repeat(40);
  }
}

function buildMcpManifest() {
  const approvedManifest = JSON.parse(fs.readFileSync(path.join(REPO, PROVIDER_MANIFEST), 'utf8'));
  return {
    version: 1,
    sources: [
      {
        id: 'freelance',
        providerId: approvedManifest.providerId,
        mcpServerId: 'freelance-skills',
        repository: 'trained-assist/trained-assist-freelance-skill',
        revision: currentRevision(),
        manifestVersion: approvedManifest.version,
        artifactDir: 'src',
        entrypoint: 'src/mcp-skills/index.js',
        manifest: PROVIDER_MANIFEST,
        artifactDigest: computeArtifactDigest(),
        approvedManifest,
        enabled: true,
        profiles: [],
      },
    ],
  };
}

if (require.main === module) {
  const out = path.join(REPO, 'mcp.manifest.json');
  const bytes = JSON.stringify(buildMcpManifest(), null, 2) + '\n';
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
    if (current !== bytes) {
      console.error('mcp.manifest.json is stale — run: npm run build:manifest');
      process.exitCode = 1;
    } else {
      console.log('mcp.manifest.json is up to date');
    }
  } else {
    fs.writeFileSync(out, bytes);
    console.log(`wrote ${out}`);
  }
}

module.exports = { buildMcpManifest, computeArtifactDigest, currentRevision };
