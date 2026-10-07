import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseToml } from 'smol-toml';

export const INSTALL_CLIENTS = Object.freeze(['codex', 'claude', 'opencode']);
export const RUNTIME_FILES = Object.freeze(['agent-chat.mjs', 'lib/mailbox.mjs', 'lib/presentation.mjs',
  'lib/broker.mjs', 'lib/broker-client.mjs', 'lib/broker-cli.mjs',
  'lib/install.mjs', 'lib/doctor.mjs', 'lib/manage-cli.mjs', 'hooks/notify.mjs', 'hooks/notifications.mjs', 'hooks/bind.mjs',
  'integrations/opencode/agent-chat.mjs', 'skills/agent-chat/SKILL.md', 'LICENSE',
  'node_modules/smol-toml/package.json', 'node_modules/smol-toml/LICENSE',
  ...['index', 'parse', 'stringify', 'error', 'util', 'date', 'extract', 'struct', 'primitive'].map(name => `node_modules/smol-toml/dist/${name}.js`)]);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECEIPT = '.agent-chat/install.json';
const PRIVACY_GUARD = '.agent-chat/.gitignore';
const MAX_CONFIG_BYTES = 1024 * 1024;
const BEGIN = '# >>> agent-chat managed codex >>>';
const END = '# <<< agent-chat managed codex <<<';
const IGNORE_BEGIN = '# >>> agent-chat local state >>>';
const IGNORE_END = '# <<< agent-chat local state <<<';
const IGNORE_CONTENT = `\n${IGNORE_BEGIN}\n/.agent-chat/\n${IGNORE_END}\n`;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const obj = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => obj(value) && Object.hasOwn(value, key);
const json = value => JSON.stringify(value, null, 2) + '\n';
const lf = value => value.replaceAll('\r\n', '\n');
function managedText(text, content) {
  const pattern = lf(content).split('\n').map(line => line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\r?\\n');
  return new RegExp(pattern).exec(text);
}
function fileNewlines(content, text) {
  return lf(content).replaceAll('\n', text.match(/\r?\n/)?.[0] || '\n');
}
function conflict(file, detail) { throw new Error(`${file}: ${detail}. Preserve your settings and resolve this conflict before retrying.`); }
function projectPath(project) {
  if (typeof project !== 'string' || !project.trim()) throw new Error('--project must name an existing project directory');
  const resolved = (process.platform === 'win32' ? fs.realpathSync.native : fs.realpathSync)(path.resolve(project));
  if (!fs.statSync(resolved).isDirectory()) throw new Error('--project must be a directory');
  return resolved;
}
export function installationPaths(project) {
  project = projectPath(project);
  return { project, receipt: path.join(project, RECEIPT), runtime: path.join(project, '.agent-chat/runtime'),
    notificationConfig: path.join(project, '.agent-chat/notifications.json'), launchers: path.join(project, '.agent-chat/launchers') };
}
function target(project, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe installation path');
  const file = path.resolve(project, relative);
  if (!file.startsWith(project + path.sep)) throw new Error('Installation path escapes project');
  let current = project;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`${relative}: symlinks are not supported for managed installation paths`); }
    catch (error) { if (error.code === 'ENOENT') break; throw error; }
  }
  return file;
}
function readFile(project, relative, max = MAX_CONFIG_BYTES) {
  const file = target(project, relative);
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) conflict(relative, 'expected a regular file');
    if (stat.size > max) conflict(relative, 'file exceeds the installer size limit');
    const data = Buffer.alloc(max + 1);
    const length = fs.readSync(fd, data, 0, data.length, 0);
    if (length > max) conflict(relative, 'file exceeds the installer size limit');
    return data.subarray(0, length);
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function parseJson(text, file) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { conflict(file, 'invalid JSON (comments and trailing commas are not supported; use strict JSON)'); }
  if (!obj(parsed)) conflict(file, 'expected a JSON object');
  // JSON.parse silently accepts duplicate keys. Reject these before touching settings.
  let pos = 0;
  const space = () => { while (/\s/.test(text[pos] || '') && pos < text.length) pos++; };
  function string() {
    const start = pos++;
    while (pos < text.length) { if (text[pos++] === '"') break; if (text[pos - 1] === '\\') pos++; }
    return JSON.parse(text.slice(start, pos));
  }
  function value(depth = 0) {
    if (depth > 100) conflict(file, 'JSON nesting is too deep');
    space();
    if (text[pos] === '{') {
      pos++; space(); const keys = new Set();
      if (text[pos] === '}') { pos++; return; }
      for (;;) {
        space(); const key = string();
        if (keys.has(key)) conflict(file, `duplicate JSON key ${JSON.stringify(key)}`);
        keys.add(key); space(); pos++; value(depth + 1); space();
        if (text[pos++] === '}') return;
      }
    }
    if (text[pos] === '[') {
      pos++; space(); if (text[pos] === ']') { pos++; return; }
      for (;;) { value(depth + 1); space(); if (text[pos++] === ']') return; }
    }
    if (text[pos] === '"') { string(); return; }
    while (pos < text.length && !/[\s,\]}]/.test(text[pos])) pos++;
  }
  value();
  return parsed;
}
function parseTomlFile(text, file) {
  try { return parseToml(text); } catch { conflict(file, 'invalid TOML'); }
}
function clientsOption(clients, fallback) {
  const values = clients === undefined ? fallback : typeof clients === 'string' ? clients.split(',') : clients;
  if (!Array.isArray(values) || !values.length || values.some(value => !INSTALL_CLIENTS.includes(value))) throw new Error('--clients must be an explicit comma-separated selection of codex,claude,opencode');
  return [...new Set(values)];
}
function validateReceipt(receipt, project) {
  let recordedProject = receipt?.project;
  if (process.platform === 'win32' && typeof recordedProject === 'string' && path.isAbsolute(recordedProject)) {
    try { recordedProject = projectPath(recordedProject); } catch { recordedProject = null; }
  }
  if (!obj(receipt) || receipt.schemaVersion !== 1 || recordedProject !== project || !Array.isArray(receipt.clients)
    || !obj(receipt.files) || !Array.isArray(receipt.entries) || !obj(receipt.hooks) || !obj(receipt.configFiles)) conflict(RECEIPT, 'unrecognized installation receipt');
  clientsOption(receipt.clients, []);
  if (receipt.connections !== undefined) {
    if (!obj(receipt.connections) || Object.keys(receipt.connections).some(client => !receipt.clients.includes(client))) conflict(RECEIPT, "invalid broker connection ownership");
    for (const connection of Object.values(receipt.connections)) if (connection !== null) normalizeConnection(connection);
  }
  const allowedFiles = new Set([...RUNTIME_FILES.map(relative => `.agent-chat/runtime/${relative}`), '.agent-chat/runtime/package.json',
    '.agent-chat/launchers/codex.mjs', '.agent-chat/launchers/claude.mjs', '.opencode/plugins/agent-chat.js', '.opencode/plugins/agent-chat.mjs',
    ...['.agents', '.claude', '.opencode'].map(relative => `${relative}/skills/agent-chat/SKILL.md`)]);
  const allowedConfigs = new Set(['.codex/config.toml', '.codex/hooks.json', '.mcp.json', '.claude/settings.local.json', 'opencode.json']);
  for (const [relative, record] of Object.entries(receipt.files)) {
    target(project, relative);
    if (!allowedFiles.has(relative)) conflict(RECEIPT, 'unexpected owned file path');
    if (!obj(record) || !/^[a-f0-9]{64}$/.test(record.sha256) || !Array.isArray(record.clients) || record.clients.some(client => !INSTALL_CLIENTS.includes(client))) conflict(RECEIPT, 'invalid file ownership record');
  }
  const ids = new Set();
  for (const entry of receipt.entries) {
    target(project, entry.path);
    if (!allowedConfigs.has(entry.path)) conflict(RECEIPT, 'unexpected owned config path');
    if (!INSTALL_CLIENTS.includes(entry.client) || !['json-key', 'json-hook', 'toml-block'].includes(entry.kind) || typeof entry.id !== 'string' || ids.has(entry.id)) conflict(RECEIPT, 'invalid config ownership record');
    ids.add(entry.id);
    if (entry.kind !== 'toml-block' && (!Array.isArray(entry.keyPath) || entry.keyPath.some(key => typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)))) conflict(RECEIPT, 'invalid JSON ownership path');
    if (entry.kind === 'toml-block' && (typeof entry.content !== 'string' || !entry.content.includes(BEGIN) || !entry.content.includes(END))) conflict(RECEIPT, 'invalid TOML ownership block');
  }
  for (const relative of Object.keys(receipt.configFiles)) if (!allowedConfigs.has(relative)) conflict(RECEIPT, 'unexpected config path');
  if (receipt.ignore && (receipt.ignore.path !== '.gitignore' || typeof receipt.ignore.content !== 'string' || lf(receipt.ignore.content) !== IGNORE_CONTENT || typeof receipt.ignore.created !== 'boolean')) conflict(RECEIPT, 'invalid ignore ownership record');
  receipt.project = project;
  return receipt;
}
export function inspectInstallation({ project } = {}) {
  project = projectPath(project);
  const data = readFile(project, RECEIPT);
  const receipt = data === null ? null : validateReceipt(parseJson(data.toString('utf8'), RECEIPT), project);
  return { project, receipt, exists: receipt !== null, receiptHash: data === null ? null : hash(data) };
}
function getAt(root, keys) {
  let value = root;
  for (const key of keys) { if (!own(value, key)) return undefined; value = value[key]; }
  return value;
}
function setAt(root, keys, value, file, created = []) {
  let parent = root;
  for (let index = 0; index < keys.length - 1; index++) {
    const key = keys[index];
    if (!own(parent, key)) {
      parent[key] = {};
      const ancestor = keys.slice(0, index + 1);
      if (!created.some(value => isDeepStrictEqual(value, ancestor))) created.push(ancestor);
    }
    if (!obj(parent[key])) conflict(file, `${keys.slice(0, index + 1).join('.')} must be an object`);
    parent = parent[key];
  }
  parent[keys.at(-1)] = value;
  return created;
}
function deleteAt(root, keys) {
  const parent = getAt(root, keys.slice(0, -1));
  if (obj(parent)) delete parent[keys.at(-1)];
}
function prune(root, ancestors) {
  for (const keys of [...(ancestors || [])].reverse()) {
    const value = getAt(root, keys);
    if (obj(value) && !Object.keys(value).length || Array.isArray(value) && !value.length) deleteAt(root, keys);
  }
}
function referencesLauncher(value, client = '') {
  if (Array.isArray(value)) return value.some(item => referencesLauncher(item, client));
  if (!obj(value)) return false;
  const launcher = `.agent-chat/launchers/${client ? `${client}.mjs` : ''}`;
  return Object.entries(value).some(([key, item]) =>
    (key === 'command' || key === 'commandWindows') && typeof item === 'string'
      ? item.replaceAll('\\', '/').replace(/\/+/g, '/').toLowerCase().includes(launcher.toLowerCase())
      : referencesLauncher(item, client));
}
function hookState(current, entry) {
  if (current === undefined) return { status: 'missing' };
  if (!Array.isArray(current)) return { status: 'changed' };
  const indices = current.flatMap((value, index) => isDeepStrictEqual(value, entry.value) ? [index] : []);
  const edited = current.some((value, index) => !indices.includes(index) && referencesLauncher(value, entry.client));
  if (indices.length === 1 && !edited) return { status: 'present', index: indices[0] };
  return { status: indices.length || edited ? 'changed' : 'missing' };
}
function tomlBlockState(text, entry) {
  const parsed = parseTomlFile(text, entry.path);
  if (managedText(text, entry.content) && text.split(BEGIN).length === 2 && text.split(END).length === 2) return 'present';
  return text.includes(BEGIN) || text.includes(END) || parsed.mcp_servers?.['agent-chat'] !== undefined ? 'changed' : 'missing';
}
export function inspectManagedEntry({ project, entry } = {}) {
  try {
    project = projectPath(project);
    const data = readFile(project, entry.path);
    if (data === null) return { status: 'missing' };
    const text = data.toString('utf8');
    if (entry.kind === 'toml-block') return { status: tomlBlockState(text, entry) };
    const root = parseJson(text, entry.path); const current = getAt(root, entry.keyPath);
    if (entry.kind === 'json-hook') return { status: hookState(current, entry).status };
    return { status: current === undefined ? 'missing' : isDeepStrictEqual(current, entry.value) ? 'present' : 'changed' };
  } catch (error) { return { status: 'malformed', reason: error.message }; }
}
export function detectClients({ project } = {}) {
  project = projectPath(project);
  return INSTALL_CLIENTS.filter(client => (client === 'codex' ? ['.codex', '.agents'] : client === 'claude' ? ['.claude', '.mcp.json', 'CLAUDE.md'] : ['.opencode', 'opencode.json', 'opencode.jsonc']).some(relative => fs.existsSync(path.join(project, relative))));
}
export function quotePosix(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }
export function quoteWindows(value) {
  // cmd.exe expands %, ! and quotes before Node sees argv. Refuse unsafe paths rather than approximate escaping.
  if (/["%!\r\n]/.test(value)) throw new Error('Windows hook paths cannot contain quotes, percent signs, exclamation marks or newlines');
  return `"${value}"`;
}
function commandFor(node, launcher, windows = false) { const quote = windows ? quoteWindows : quotePosix; return `${quote(node)} ${quote(launcher)}`; }
function normalizeConnection(value) {
  if (!obj(value) || Object.keys(value).some(key => !['url', 'tokenFile', 'room'].includes(key))) throw new Error('Invalid broker connection settings');
  let url;
  try { url = new URL(value.url); } catch { throw new Error('--broker-url must be an HTTP or HTTPS origin'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('--broker-url must be an HTTP or HTTPS origin without credentials, query, or path');
  if (typeof value.tokenFile !== 'string' || !path.isAbsolute(value.tokenFile) || /[\r\n\0]/.test(value.tokenFile)) throw new Error('--broker-token-file must name an absolute local file path');
  if (typeof value.room !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.room)) throw new Error('--room must be an explicit broker room name (1 to 128 letters, numbers, dots, underscores or hyphens)');
  return { url: url.origin, tokenFile: value.tokenFile, room: value.room };
}
function selectedConnection(options, previous) {
  const supplied = ['brokerUrl', 'brokerTokenFile', 'room'].some(key => options[key] !== undefined);
  if (options.local && supplied) throw new Error('--local cannot be combined with broker options');
  if (options.local) return null;
  if (!supplied) return previous || null;
  return normalizeConnection({ url: options.brokerUrl ?? previous?.url, tokenFile: options.brokerTokenFile ?? previous?.tokenFile, room: options.room ?? previous?.room });
}
function clientDefinition(client, project, hooks, node, connection) {
  const runtime = path.join(project, '.agent-chat/runtime/agent-chat.mjs');
  const transportEnv = connection ? { AGENT_CHAT_BROKER_URL: connection.url, AGENT_CHAT_BROKER_TOKEN_FILE: connection.tokenFile } : { AGENT_CHAT_BROKER_URL: '', AGENT_CHAT_BROKER_TOKEN_FILE: '' };
  const env = { AGENT_CHAT_NAME: client === 'claude' ? 'claude' : client, AGENT_CHAT_ROOM: connection?.room || project, ...transportEnv };
  const hookEnv = { ...transportEnv, ...(connection ? { AGENT_CHAT_ROOM: connection.room, AGENT_CHAT_BROKER_SESSION_DIR: path.join(project, '.agent-chat/broker-sessions') } : {}) };
  if (connection) env.AGENT_CHAT_BROKER_SESSION_DIR = hookEnv.AGENT_CHAT_BROKER_SESSION_DIR;
  const entries = []; const files = {};
  const server = { command: node, args: [runtime], env };
  if (client === 'codex') {
    const content = `\n${BEGIN}\n[mcp_servers.agent-chat]\ncommand = ${JSON.stringify(node)}\nargs = [${JSON.stringify(runtime)}]\ncwd = ${JSON.stringify(project)}\ntool_timeout_sec = 120\nenv = { ${Object.entries(env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join(', ')} }\n${END}\n`;
    entries.push({ id: 'codex:mcp', client, path: '.codex/config.toml', kind: 'toml-block', content });
  } else entries.push({ id: `${client}:mcp`, client, path: client === 'claude' ? '.mcp.json' : 'opencode.json', kind: 'json-key', keyPath: [client === 'claude' ? 'mcpServers' : 'mcp', 'agent-chat'], value: client === 'claude' ? server : { type: 'local', command: [node, runtime], environment: env, enabled: true, timeout: 60000 } });
  const skillPath = `${client === 'codex' ? '.agents' : client === 'claude' ? '.claude' : '.opencode'}/skills/agent-chat/SKILL.md`;
  if (hooks && client !== 'opencode') {
    const launcher = `.agent-chat/launchers/${client}.mjs`;
    const prefix = client === 'codex' ? 'mcp__agent_chat__' : 'mcp__agent-chat__';
    const names = [`${prefix}chat_join`, `${prefix}chat_who`];
    files[launcher] = `// Managed agent-chat notification launcher.\n${Object.entries(hookEnv).map(([key, value]) => `process.env.${key} = ${JSON.stringify(value)};`).join("\n")}\nprocess.env.AGENT_CHAT_NOTIFY_CONFIG = ${JSON.stringify(path.join(project, '.agent-chat/notifications.json'))};\nprocess.env.AGENT_CHAT_NOTIFY_AUTO_BIND = '1';\nprocess.env.AGENT_CHAT_NOTIFY_IDENTITY_TOOLS = ${JSON.stringify(names.join(','))};\nprocess.argv[2] = ${JSON.stringify(client === 'claude' ? 'claude-code' : client)};\nawait import(${JSON.stringify(pathToFileURL(path.join(project, '.agent-chat/runtime/hooks/notify.mjs')).href)});\n`;
    const command = commandFor(node, path.join(project, launcher), process.platform === 'win32' && client === 'claude');
    for (const event of ['SessionStart', 'UserPromptSubmit', 'PostToolUse']) entries.push({ id: `${client}:hook:${event}`, client, path: client === 'codex' ? '.codex/hooks.json' : '.claude/settings.local.json', kind: 'json-hook', keyPath: ['hooks', event], value: { ...(event === 'PostToolUse' ? { matcher: '.*' } : {}), hooks: [{ type: 'command', command, ...(client === 'codex' && process.platform === 'win32' ? { commandWindows: commandFor(node, path.join(project, launcher), true) } : {}), timeout: 5 }] } });
  }
  if (hooks && client === 'opencode') {
    files['.opencode/plugins/agent-chat.js'] = `// Managed agent-chat notification adapter.\nimport { AgentChatPlugin } from ${JSON.stringify(pathToFileURL(path.join(project, '.agent-chat/runtime/integrations/opencode/agent-chat.mjs')).href)};\nexport const AgentChat = async context => AgentChatPlugin(context, { env: { ...process.env, AGENT_CHAT_NOTIFY_CONFIG: ${JSON.stringify(path.join(project, '.agent-chat/notifications.json'))}, ...${JSON.stringify(hookEnv)} } });\n`;
  }
  return { entries, files, skillPath };
}
function sourceFiles(sourceRoot) {
  sourceRoot = fs.realpathSync(sourceRoot || ROOT);
  const packageFile = readFile(sourceRoot, 'package.json');
  if (!packageFile) throw new Error('Source package.json is missing');
  const version = parseJson(packageFile.toString('utf8'), 'source package.json').version;
  if (typeof version !== 'string') throw new Error('Source package version is missing');
  const files = {};
  for (const relative of RUNTIME_FILES) {
    const data = readFile(sourceRoot, relative);
    if (data === null) throw new Error(`Source runtime file is missing: ${relative}`);
    files[`.agent-chat/runtime/${relative}`] = data;
  }
  files['.agent-chat/runtime/package.json'] = Buffer.from(json({ private: true, type: 'module', version }));
  const skill = readFile(sourceRoot, 'skills/agent-chat/SKILL.md');
  if (skill === null) throw new Error('Source skill is missing');
  return { version, files, skill };
}
function planner(project) {
  const changes = new Map(); const initial = new Map(); const modes = new Map();
  const read = relative => { if (!initial.has(relative)) { initial.set(relative, readFile(project, relative)); if (initial.get(relative) !== null) modes.set(relative, fs.statSync(target(project, relative)).mode & 0o777); } return changes.has(relative) ? changes.get(relative) : initial.get(relative); };
  const write = (relative, value) => { read(relative); changes.set(relative, value === null ? null : Buffer.isBuffer(value) ? value : Buffer.from(value)); };
  return { changes, initial, modes, read, write };
}
function installEntry(plan, entry, previous, receipt) {
  const currentData = plan.read(entry.path); const text = currentData?.toString('utf8') || '';
  receipt.configFiles[entry.path] ??= { created: currentData === null };
  if (entry.kind === 'toml-block') {
    const parsed = parseTomlFile(text, entry.path);
    let next;
    if (previous) {
      const matched = managedText(text, previous.content);
      if (matched) next = text.slice(0, matched.index) + fileNewlines(entry.content, text) + text.slice(matched.index + matched[0].length);
      else {
        if (text.includes(BEGIN) || text.includes(END) || parsed.mcp_servers?.['agent-chat'] !== undefined) conflict(entry.path, 'the managed agent-chat TOML block was changed');
        next = text + fileNewlines(entry.content, text);
      }
    } else {
      if (parsed.mcp_servers?.['agent-chat'] !== undefined || text.includes(BEGIN) || text.includes(END)) conflict(entry.path, 'agent-chat already exists outside this installation');
      next = text + fileNewlines(entry.content, text);
    }
    if (next.split(BEGIN).length !== 2 || next.split(END).length !== 2) conflict(entry.path, 'duplicate managed TOML markers');
    parseTomlFile(next, entry.path); plan.write(entry.path, next); return entry;
  }
  const root = currentData === null ? {} : parseJson(text, entry.path);
  const current = getAt(root, entry.keyPath);
  const inherited = receipt.entries.filter(item => item.path === entry.path).flatMap(item => item.ancestors || []).filter(keys => keys.length < entry.keyPath.length && keys.every((key, index) => entry.keyPath[index] === key));
  const ancestors = [...(previous?.ancestors || []), ...inherited].filter((keys, index, all) => all.findIndex(other => isDeepStrictEqual(keys, other)) === index);
  if (entry.kind === 'json-key') {
    if (previous ? current !== undefined && !isDeepStrictEqual(current, previous.value) : current !== undefined) conflict(entry.path, `${entry.keyPath.join('.')} already exists or was edited`);
    entry.ancestors = setAt(root, entry.keyPath, entry.value, entry.path, ancestors);
  } else {
    if (current !== undefined && !Array.isArray(current)) conflict(entry.path, `${entry.keyPath.join('.')} must be an array`);
    const values = current || [];
    if (previous) {
      const state = hookState(current, previous);
      if (state.status === 'missing') values.push(entry.value);
      else if (state.status === 'present') values[state.index] = entry.value;
      else conflict(entry.path, 'the managed notification hook was changed or duplicated');
    } else {
      if (values.some(value => referencesLauncher(value))) conflict(entry.path, 'an unmanaged agent-chat notification hook already exists');
      values.push(entry.value);
    }
    entry.ancestors = setAt(root, entry.keyPath, values, entry.path, ancestors);
    if (current === undefined && !entry.ancestors.some(keys => isDeepStrictEqual(keys, entry.keyPath))) entry.ancestors.push(entry.keyPath);
  }
  plan.write(entry.path, json(root)); return entry;
}
function removeEntry(plan, entry, receipt, warnings) {
  const data = plan.read(entry.path);
  if (data === null) return true;
  const text = data.toString('utf8');
  if (entry.kind === 'toml-block') {
    const state = tomlBlockState(text, entry);
    if (state === 'missing') return true;
    if (state !== 'present') { warnings.push(`${entry.path}: preserved changed managed TOML block`); return false; }
    const matched = managedText(text, entry.content);
    const next = text.slice(0, matched.index) + text.slice(matched.index + matched[0].length); parseTomlFile(next, entry.path);
    plan.write(entry.path, receipt.configFiles[entry.path]?.created && !next.trim() ? null : next); return true;
  }
  const root = parseJson(text, entry.path); const current = getAt(root, entry.keyPath);
  if (current === undefined) return true;
  if (entry.kind === 'json-key') {
    if (!isDeepStrictEqual(current, entry.value)) { warnings.push(`${entry.path}: preserved edited ${entry.keyPath.join('.')}`); return false; }
    deleteAt(root, entry.keyPath);
  } else {
    const state = hookState(current, entry);
    if (state.status === 'missing') return true;
    if (state.status !== 'present') { warnings.push(`${entry.path}: preserved changed or duplicated notification hook`); return false; }
    current.splice(state.index, 1);
  }
  prune(root, entry.ancestors);
  plan.write(entry.path, receipt.configFiles[entry.path]?.created && !Object.keys(root).length ? null : json(root));
  return true;
}
function summarized(action, project, clients, hooks, plan, warnings) {
  return { action, project, clients, hooks, changes: [...plan.changes].filter(([relative, value]) => !buffersEqual(plan.initial.get(relative), value)).map(([relative, value]) => ({ path: relative, action: value === null ? 'remove' : plan.initial.get(relative) === null ? 'create' : 'update' })), warnings };
}
const buffersEqual = (left, right) => left === null || right === null ? left === right : Buffer.isBuffer(left) && Buffer.isBuffer(right) && left.equals(right);
function planPrivacyGuard(plan) {
  const guard = plan.read(PRIVACY_GUARD);
  if (guard === null) plan.write(PRIVACY_GUARD, '*\n');
  else {
    const rules = guard.toString('utf8').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
    if (rules.at(-1) !== '*') conflict(PRIVACY_GUARD, 'private backups need a final * ignore rule; add it manually before retrying');
  }
}
function transact(project, plan, { beforeWrite } = {}) {
  const allChanges = [...plan.changes].filter(([relative, value]) => !buffersEqual(plan.initial.get(relative), value));
  const changes = allChanges.filter(([relative]) => relative !== PRIVACY_GUARD);
  if (!allChanges.length) return null;
  target(project, '.agent-chat/install.lock');
  const base = path.join(project, '.agent-chat'); fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const lock = path.join(base, 'install.lock');
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); fs.closeSync(fd); }
  catch (error) { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* already closed */ } if (fd !== undefined) fs.rmSync(lock, { force: true }); if (error.code === 'EEXIST') throw new Error('Installation is locked. Confirm no installer is running; inspect .agent-chat/backups before removing .agent-chat/install.lock after an interrupted run.'); throw error; }
  const transaction = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const backupRelative = `.agent-chat/backups/${transaction}`;
  const written = [];
  try {
    const backup = target(project, backupRelative);
    // This protection intentionally survives rollback, before any private snapshots exist.
    const guardPath = target(project, PRIVACY_GUARD);
    if (readFile(project, PRIVACY_GUARD) === null) fs.writeFileSync(guardPath, '*\n', { mode: 0o600, flag: 'wx' });
    const rules = readFile(project, PRIVACY_GUARD).toString('utf8').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
    if (rules.at(-1) !== '*') conflict(PRIVACY_GUARD, 'private backup protection changed before the transaction');
    if (!changes.length) return null;
    fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
    for (let index = 0; index < changes.length; index++) {
      const [relative, value] = changes[index];
      const old = plan.initial.get(relative);
      if (!buffersEqual(readFile(project, relative), old)) conflict(relative, 'file changed while the install was being planned');
      fs.writeFileSync(path.join(backup, `${index}.before`), old || '', { mode: 0o600, flag: 'wx' });
      if (value !== null) fs.writeFileSync(path.join(backup, `${index}.after`), value, { mode: 0o600, flag: 'wx' });
    }
    fs.writeFileSync(path.join(backup, 'transaction.json'), json({ status: 'prepared', files: changes.map(([relative, value], index) => ({ path: relative, before: plan.initial.get(relative) !== null, after: value !== null, index })) }), { mode: 0o600, flag: 'wx' });
    for (let index = 0; index < changes.length; index++) {
      const [relative, value] = changes[index];
      beforeWrite?.({ index, path: relative });
      if (!buffersEqual(readFile(project, relative), plan.initial.get(relative))) conflict(relative, 'file changed during the installation transaction');
      const file = target(project, relative); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      target(project, relative);
      if (value === null) fs.unlinkSync(file);
      else {
        const temporary = `${file}.${transaction}.tmp`;
        try { fs.writeFileSync(temporary, value, { mode: plan.modes.get(relative) ?? 0o600, flag: 'wx' }); fs.chmodSync(temporary, plan.modes.get(relative) ?? 0o600); fs.renameSync(temporary, file); }
        finally { fs.rmSync(temporary, { force: true }); }
      }
      written.push([relative, value]);
    }
    fs.writeFileSync(path.join(backup, 'transaction.json'), json({ status: 'committed', files: changes.map(([relative, value], index) => ({ path: relative, before: plan.initial.get(relative) !== null, after: value !== null, index })) }), { mode: 0o600 });
    return backupRelative;
  } catch (error) {
    const failures = [];
    for (const [relative, value] of written.reverse()) {
      try {
        if (!buffersEqual(readFile(project, relative), value)) { failures.push(relative); continue; }
        const old = plan.initial.get(relative); const file = target(project, relative);
        if (old === null) fs.rmSync(file, { force: true });
        else { const temp = `${file}.${transaction}.rollback`; try { fs.writeFileSync(temp, old, { mode: plan.modes.get(relative) ?? 0o600, flag: 'wx' }); fs.chmodSync(temp, plan.modes.get(relative) ?? 0o600); fs.renameSync(temp, file); } finally { fs.rmSync(temp, { force: true }); } }
      } catch { failures.push(relative); }
    }
    throw new Error(`${error.message} ${failures.length ? `Rollback preserved concurrently edited files: ${failures.join(', ')}.` : 'All file changes were rolled back.'} Backups: ${backupRelative}`);
  } finally { fs.rmSync(lock, { force: true }); }
}
export function planInstall(options = {}) {
  const { project, receipt: previous, receiptHash } = inspectInstallation(options);
  const plan = planner(project);
  const captured = plan.read(RECEIPT);
  if ((captured === null ? null : hash(captured)) !== receiptHash) conflict(RECEIPT, 'installation changed while planning; retry');
  const clients = clientsOption(options.clients, previous?.clients);
  const hooks = { ...previous?.hooks };
  for (const client of clients) hooks[client] = options.hooks === undefined ? previous?.hooks[client] || false : Boolean(options.hooks);
  if (clients.includes('opencode') && readFile(project, 'opencode.jsonc') !== null) conflict('opencode.jsonc', 'an existing JSONC config needs manual consolidation into opencode.json');
  const source = sourceFiles(options.sourceRoot);
  const receipt = previous ? structuredClone(previous) : { schemaVersion: 1, project, packageVersion: source.version, clients: [], hooks: {}, files: {}, entries: [], configFiles: {} };
  receipt.clients = [...new Set([...receipt.clients, ...clients])]; receipt.packageVersion = source.version; receipt.hooks = hooks;
  const warnings = [];
  receipt.connections ??= {};
  for (const client of clients) receipt.connections[client] = selectedConnection(options, previous?.connections?.[client]);
  planPrivacyGuard(plan);
  const ignoreData = plan.read('.gitignore'); const ignoreText = ignoreData?.toString('utf8') || '';
  if (receipt.ignore) {
    if (!managedText(ignoreText, receipt.ignore.content) || ignoreText.split(IGNORE_BEGIN).length !== 2 || ignoreText.split(IGNORE_END).length !== 2) conflict('.gitignore', 'managed local-state ignore block was changed or removed');
  } else {
    if (ignoreText.includes(IGNORE_BEGIN) || ignoreText.includes(IGNORE_END)) {
      if (!managedText(ignoreText, IGNORE_CONTENT) || ignoreText.split(IGNORE_BEGIN).length !== 2 || ignoreText.split(IGNORE_END).length !== 2) conflict('.gitignore', 'an incomplete or edited agent-chat ignore block already exists');
      receipt.ignore = { path: '.gitignore', content: IGNORE_CONTENT, created: false };
    } else {
      receipt.ignore = { path: '.gitignore', content: IGNORE_CONTENT, created: ignoreData === null };
      plan.write('.gitignore', ignoreText + fileNewlines(IGNORE_CONTENT, ignoreText));
    }
  }
  const desiredFiles = { ...source.files }; const desiredOwners = {};
  for (const relative of Object.keys(source.files)) desiredOwners[relative] = receipt.clients;
  for (const client of clients) {
    const definition = clientDefinition(client, project, hooks[client], options.nodePath || process.execPath, receipt.connections[client]);
    desiredFiles[definition.skillPath] = source.skill; desiredOwners[definition.skillPath] = [client];
    for (const [relative, text] of Object.entries(definition.files)) { desiredFiles[relative] = Buffer.from(text); desiredOwners[relative] = [client]; }
    const desiredIds = new Set(definition.entries.map(entry => entry.id));
    for (const old of receipt.entries.filter(entry => entry.client === client && !desiredIds.has(entry.id))) {
      if (!removeEntry(plan, old, receipt, warnings)) conflict(old.path, 'edited hook prevents disabling notifications');
    }
    receipt.entries = receipt.entries.filter(entry => entry.client !== client || desiredIds.has(entry.id));
    for (const entry of definition.entries) {
      const old = receipt.entries.find(item => item.id === entry.id);
      const installed = installEntry(plan, entry, old, receipt);
      receipt.entries = receipt.entries.filter(item => item.id !== entry.id); receipt.entries.push(installed);
    }
  }
  for (const [relative, record] of Object.entries(receipt.files)) {
    if (!desiredFiles[relative] && record.clients.every(client => clients.includes(client))) {
      const current = plan.read(relative);
      if (current !== null && hash(current) !== record.sha256) conflict(relative, 'owned file was edited');
      if (current !== null) plan.write(relative, null);
      delete receipt.files[relative];
    }
  }
  for (const [relative, content] of Object.entries(desiredFiles)) {
    const current = plan.read(relative); const record = receipt.files[relative];
    if (current !== null && (!record || hash(current) !== record.sha256)) conflict(relative, record ? 'owned file was edited' : 'a file exists outside this installation');
    plan.write(relative, content); receipt.files[relative] = { sha256: hash(content), kind: relative.startsWith('.agent-chat/runtime/') ? 'runtime' : relative.includes('/skills/') ? 'skill' : 'launcher', clients: desiredOwners[relative] };
  }
  plan.write(RECEIPT, json(receipt));
  return { ...summarized(options.action || 'install', project, clients, hooks, plan, warnings), receipt, _plan: plan };
}
export function installProject(options = {}) {
  const result = planInstall(options);
  const backup = options.dryRun ? null : transact(result.project, result._plan, options);
  const { _plan, receipt, ...publicResult } = result;
  return { ...publicResult, dryRun: Boolean(options.dryRun), ...(backup ? { backup } : {}) };
}
export function updateProject(options = {}) {
  if (!inspectInstallation(options).exists) throw new Error('No project installation found. Run install with an explicit --clients selection first.');
  return installProject({ ...options, action: 'update' });
}
export function uninstallProject(options = {}) {
  const { project, receipt, receiptHash } = inspectInstallation(options);
  if (!receipt) return { action: 'uninstall', project, clients: [], changes: [], warnings: ['No project installation found.'], dryRun: Boolean(options.dryRun) };
  const clients = clientsOption(options.clients, receipt.clients);
  if (clients.some(client => !receipt.clients.includes(client))) throw new Error('A selected client is not installed in this project');
  const next = structuredClone(receipt); const plan = planner(project);
  const captured = plan.read(RECEIPT);
  if ((captured === null ? null : hash(captured)) !== receiptHash) conflict(RECEIPT, 'installation changed while planning; retry');
  const warnings = []; const retained = new Set();
  planPrivacyGuard(plan);
  const remainingEntries = [];
  for (const entry of next.entries) {
    if (!clients.includes(entry.client) || !removeEntry(plan, entry, next, warnings)) { remainingEntries.push(entry); if (clients.includes(entry.client)) retained.add(entry.client); }
  }
  next.entries = remainingEntries;
  for (const [relative, record] of Object.entries(next.files)) {
    if (!record.clients.some(client => clients.includes(client))) continue;
    const current = plan.read(relative);
    if (current !== null && hash(current) !== record.sha256) { warnings.push(`${relative}: preserved edited owned file`); record.clients.forEach(client => retained.add(client)); }
  }
  next.clients = next.clients.filter(client => !clients.includes(client) || retained.has(client));
  for (const [relative, record] of Object.entries(next.files)) {
    const owners = record.clients.filter(client => next.clients.includes(client));
    if (!owners.length) { if (plan.read(relative) !== null) plan.write(relative, null); delete next.files[relative]; }
    else record.clients = owners;
  }
  for (const client of Object.keys(next.hooks)) if (!next.clients.includes(client)) delete next.hooks[client];
  if (next.connections) for (const client of Object.keys(next.connections)) if (!next.clients.includes(client)) delete next.connections[client];
  plan.write(RECEIPT, next.clients.length ? json(next) : null);
  if (!next.clients.length && receipt.ignore) warnings.push('Retained the agent-chat .gitignore block because private backups and optional notification/mailbox state remain under .agent-chat. Remove that block only after reviewing or removing that local state.');
  const result = summarized('uninstall', project, clients, next.hooks, plan, warnings);
  const backup = options.dryRun ? null : transact(project, plan, options);
  return { ...result, dryRun: Boolean(options.dryRun), retainedClients: [...retained], ...(backup ? { backup } : {}) };
}
