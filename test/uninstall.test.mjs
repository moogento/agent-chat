import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installProject, updateProject, uninstallProject, inspectInstallation } from '../lib/install.mjs';

function fixture(t, clients = ['codex', 'claude']) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-uninstall-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const project = path.join(base, 'project'); fs.mkdirSync(project);
  const options = { project, sourceRoot: fileURLToPath(new URL('../', import.meta.url)) };
  installProject({ ...options, clients, hooks: true });
  const file = relative => path.join(project, relative);
  const read = relative => fs.readFileSync(file(relative), 'utf8');
  const write = (relative, contents) => fs.writeFileSync(file(relative), contents);
  return { ...options, file, read, write };
}

test('an edited skill survives uninstall without retaining or resurrecting its removed client', t => {
  const f = fixture(t);
  const skill = '.claude/skills/agent-chat/SKILL.md';
  const custom = '# My custom skill\nPreserve this text.\n'; f.write(skill, custom);
  const result = uninstallProject({ ...f, clients: ['claude'] });
  const receipt = inspectInstallation(f).receipt;
  assert.deepEqual(result.retainedClients, []);
  assert.deepEqual(receipt.clients, ['codex']);
  assert.equal(receipt.files[skill], undefined);
  assert.equal(f.read(skill), custom);
  assert.equal(fs.existsSync(f.file('.mcp.json')), false);
  assert.equal(fs.existsSync(f.file('.agent-chat/launchers/claude.mjs')), false);
  assert.ok(result.warnings.some(warning => warning.includes(skill) && /outside installation ownership/.test(warning)));
  assert.equal(updateProject(f).changes.length, 0);
  assert.deepEqual(inspectInstallation(f).receipt.clients, ['codex']);
  assert.equal(fs.existsSync(f.file('.mcp.json')), false);
  assert.equal(f.read(skill), custom);
});

test('an edited shared runtime drops the removed owner and remains managed for other clients', t => {
  const f = fixture(t);
  const runtime = '.agent-chat/runtime/agent-chat.mjs'; const original = f.read(runtime);
  const custom = original + '\n// Preserve a user runtime edit.\n'; f.write(runtime, custom);
  const result = uninstallProject({ ...f, clients: ['claude'] });
  const receipt = inspectInstallation(f).receipt;
  assert.deepEqual(result.retainedClients, []);
  assert.deepEqual(receipt.clients, ['codex']);
  assert.deepEqual(receipt.files[runtime].clients, ['codex']);
  assert.equal(f.read(runtime), custom);
  assert.equal(fs.existsSync(f.file('.mcp.json')), false);
  assert.equal(fs.existsSync(f.file('.claude/skills/agent-chat/SKILL.md')), false);
  assert.ok(result.warnings.some(warning => warning.includes(runtime) && /remaining clients/.test(warning)));
  // Resolving the surviving client's runtime edit must not bring Claude back on update.
  f.write(runtime, original);
  assert.equal(updateProject(f).changes.length, 0);
  assert.deepEqual(inspectInstallation(f).receipt.clients, ['codex']);
  assert.equal(fs.existsSync(f.file('.mcp.json')), false);
});

test('removing every client preserves orphan edited files and removes all installation membership', t => {
  const f = fixture(t);
  const runtime = '.agent-chat/runtime/agent-chat.mjs'; const skill = '.claude/skills/agent-chat/SKILL.md';
  const customRuntime = f.read(runtime) + '\n// Orphan custom runtime.\n';
  const customSkill = '# Orphan custom skill\n'; f.write(runtime, customRuntime); f.write(skill, customSkill);
  const result = uninstallProject(f);
  assert.deepEqual(result.retainedClients, []);
  assert.equal(inspectInstallation(f).exists, false);
  assert.equal(f.read(runtime), customRuntime); assert.equal(f.read(skill), customSkill);
  assert.equal(fs.existsSync(f.file('.agent-chat/runtime/lib/mailbox.mjs')), false);
  assert.equal(fs.existsSync(f.file('.agents/skills/agent-chat/SKILL.md')), false);
  assert.equal(fs.existsSync(f.file('.mcp.json')), false);
  assert.equal(fs.existsSync(f.file('.codex/config.toml')), false);
  assert.equal(result.warnings.filter(warning => /outside installation ownership/.test(warning)).length, 2);
  assert.throws(() => updateProject(f), /No project installation/);
});

test('edited configuration still retains its client and runtime dependencies', t => {
  const f = fixture(t, ['claude']);
  const mcp = JSON.parse(f.read('.mcp.json')); mcp.mcpServers['agent-chat'].args.push('custom-argument');
  f.write('.mcp.json', JSON.stringify(mcp, null, 2) + '\n');
  const custom = '# Retained managed custom skill\n'; f.write('.claude/skills/agent-chat/SKILL.md', custom);
  const result = uninstallProject(f); const receipt = inspectInstallation(f).receipt;
  assert.deepEqual(result.retainedClients, ['claude']);
  assert.deepEqual(receipt.clients, ['claude']);
  assert.ok(receipt.entries.some(entry => entry.id === 'claude:mcp'));
  assert.deepEqual(receipt.files['.agent-chat/runtime/agent-chat.mjs'].clients, ['claude']);
  assert.deepEqual(receipt.files['.claude/skills/agent-chat/SKILL.md'].clients, ['claude']);
  assert.deepEqual(JSON.parse(f.read('.mcp.json')), mcp);
  assert.equal(f.read('.claude/skills/agent-chat/SKILL.md'), custom);
  assert.ok(fs.existsSync(f.file('.agent-chat/runtime/lib/mailbox.mjs')));
});
