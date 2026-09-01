#!/usr/bin/env node
'use strict';

/**
 * Safety net: make sure no private-key material is tracked by git.
 * Run manually with:  npm run check-secrets
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TOOL_DIR = path.resolve(__dirname, '..');

let tracked = [];
try {
  tracked = execSync('git ls-files .', { cwd: TOOL_DIR, encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean);
} catch (e) {
  console.error('Could not query git (not a git repo?).');
  process.exit(2);
}

const R = (s) => `\x1b[31m${s}\x1b[0m`;
const Y = (s) => `\x1b[33m${s}\x1b[0m`;

let errors = 0;
let warnings = 0;

const secretFileRe = /(^|\/)(\.env|.*\.key|.*_private_key.*|keystore\.json)$/i;
const pkHexRe = /0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/g;
const pemRe = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

for (const rel of tracked) {
  const abs = path.join(TOOL_DIR, rel);
  let stat;
  try { stat = fs.statSync(abs); } catch (_) { continue; }
  if (!stat.isFile()) continue;

  if (secretFileRe.test(rel)) {
    console.error(R(`✘ SECRET-LIKE FILE TRACKED IN GIT: ${rel}  → remove it and add it to .gitignore!`));
    errors++;
    continue;
  }

  const content = fs.readFileSync(abs, 'utf8');
  if (pemRe.test(content)) {
    console.error(R(`✘ PEM private key found in: ${rel}  → remove it from git history!`));
    errors++;
    continue;
  }
  const hexMatches = content.match(pkHexRe) || [];
  for (const m of hexMatches) {
    // 64 hex chars could be a tx hash or token — warn, don't fail.
    console.warn(Y(`⚠ 64-hex string in ${rel}: ${m.slice(0, 10)}…  (verify this is not a private key)`));
    warnings++;
  }
}

if (errors) {
  console.error(R(`\n${errors} error(s), ${warnings} warning(s) — DO NOT PUSH until fixed.`));
  process.exit(1);
}
console.log(`\x1b[32m✔ No secret files tracked.\x1b[0m${warnings ? ` (${warnings} warning(s) to review)` : ''}`);
