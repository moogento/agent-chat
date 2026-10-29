#!/usr/bin/env node
// Regenerates the standalone OpenCode adapter. The artifact is committed because the
// runtime that loads it cannot resolve filesystem imports, so it must ship pre-bundled.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'integrations/opencode/agent-chat.src.mjs');
const output = path.join(root, 'integrations/opencode/agent-chat.standalone.mjs');

function esbuildCommand() {
  const configured = process.env.ESBUILD_BINARY;
  if (configured) return configured;
  for (const candidate of [path.join(root, 'node_modules/.bin/esbuild'), 'esbuild']) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' });
      return candidate;
    } catch { /* try the next location */ }
  }
  throw new Error('esbuild is required: install it (npm install -g esbuild) or set ESBUILD_BINARY');
}

execFileSync(esbuildCommand(), [entry, '--bundle', '--platform=node', '--format=esm',
  '--target=node20', '--outfile=' + output, '--log-level=warning'], { stdio: 'inherit' });

const bundled = fs.readFileSync(output, 'utf8');
const external = [...bundled.matchAll(/^\s*import[^'"]*from\s*['"]([^'"]+)['"]/gm)]
  .map(match => match[1])
  .filter(specifier => !specifier.startsWith('node:'));
if (external.length) {
  throw new Error('standalone adapter must not import filesystem modules: ' + external.join(', '));
}
if (!bundled.includes('__AGENT_CHAT_NOTIFY_CONFIG__')) {
  throw new Error('standalone adapter lost its notify-config placeholder');
}
process.stdout.write(`wrote ${path.relative(root, output)} (${Buffer.byteLength(bundled)} bytes)\n`);
