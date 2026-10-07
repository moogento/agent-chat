import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const CLIENTS = ['codex', 'claude', 'opencode'];
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const sourceRoot = fileURLToPath(new URL('../', import.meta.url));

function readFile(file, limit = MAX_FILE_BYTES) {
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Unsupported symlink');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error('Unsupported file');
    const data = Buffer.alloc(stat.size + 1);
    const length = fs.readSync(fd, data, 0, data.length, 0);
    if (length > stat.size) throw new Error('File changed during inspection');
    return data.subarray(0, length);
  } finally { fs.closeSync(fd); }
}

function projectFile(project, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) throw new Error('Unsupported managed path');
  const file = path.resolve(project, relative);
  const inside = path.relative(project, file);
  if (!inside || inside === '..' || inside.startsWith(`..${path.sep}`)) throw new Error('Unsupported managed path');
  let ancestor = project;
  for (const segment of inside.split(path.sep)) {
    ancestor = path.join(ancestor, segment);
    try { if (fs.lstatSync(ancestor).isSymbolicLink()) throw new Error('Unsupported symlink'); }
    catch (error) { if (error.code === 'ENOENT') break; throw error; }
  }
  return file;
}

function versionAt(file) {
  const value = JSON.parse(readFile(file, 64 * 1024).toString('utf8'));
  if (typeof value.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(value.version) || value.version.length > 64) {
    throw new Error('Unsupported package version');
  }
  return value.version;
}

function entryCategory(entry) {
  if (entry.kind === 'json-hook' || entry.keyPath?.includes('hooks') || /\[\[hooks\./.test(entry.content || '')) return 'hooks';
  return 'mcp';
}

function selectedClient(client) {
  if (!client || client === 'all') return null;
  if (client === 'claude-code') return 'claude';
  if (!CLIENTS.includes(client)) throw new Error('client must be codex, claude, or opencode');
  return client;
}

function executableExists(command) {
  if (typeof command !== 'string' || !command || command.includes('\0')) return false;
  let candidates;
  if (path.isAbsolute(command)) candidates = [command];
  else if (/[\\/]/.test(command)) return false;
  else {
    const extensions = process.platform === 'win32' && !path.extname(command)
      ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';') : [''];
    candidates = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
      .flatMap(directory => extensions.map(extension => path.join(directory, command + extension)));
  }
  return candidates.some(file => {
    try {
      if (!fs.statSync(file).isFile()) return false;
      fs.accessSync(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
      return true;
    }
    catch { return false; }
  });
}

async function entryCommand(entry) {
  if (entry.kind === 'toml-block') {
    const { parse } = await import('smol-toml');
    return parse(entry.content).mcp_servers?.['agent-chat']?.command;
  }
  return Array.isArray(entry.value?.command) ? entry.value.command[0] : entry.value?.command;
}

// Inspect only bounded room metadata. Constructing a mailbox would create directories.
function localRoomMetadata() {
  const home = path.resolve(process.env.AGENT_CHAT_HOME || path.join(os.homedir(), '.agent-chat'));
  const rooms = path.join(home, 'rooms');
  const result = [];
  let directory;
  try {
    for (const file of [home, rooms]) {
      const stat = fs.lstatSync(file);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return result;
    }
    directory = fs.opendirSync(rooms);
    for (let scanned = 0; scanned < 256; scanned++) {
      const entry = directory.readSync();
      if (!entry) break;
      if (!entry.isDirectory() || !/^[A-Za-z0-9._-]{1,128}$/.test(entry.name) || ['.', '..'].includes(entry.name)) continue;
      try {
        const dir = path.join(rooms, entry.name);
        if (fs.lstatSync(dir).isSymbolicLink()) continue;
        const value = JSON.parse(readFile(path.join(dir, 'room.json'), 4096).toString('utf8'));
        if (value.id === entry.name && typeof value.label === 'string' && value.label.length <= 1024) result.push(value);
      } catch { /* Ignore missing, malformed, inaccessible, or unsupported metadata. */ }
    }
  } catch { /* An absent mailbox is healthy and must remain absent. */ }
  finally { directory?.closeSync(); }
  return result;
}

function checkLocalRoom({ add, report, receipt, client, metadata }) {
  const named = receipt.localRooms?.[client];
  add(`${client}.room`, 'ok', named
    ? `Local mailbox default is the explicit named room ${JSON.stringify(named)}; it is preserved on updates and project moves.`
    : 'Local mailbox default is derived from the project path. An explicit room with the project basename is a separate room.', client);
  const literal = metadata.find(room => room.id === (named || path.basename(report.project)) && room.label === room.id);
  const derived = metadata.find(room => room.label === report.project && room.id !== literal?.id);
  if (literal && derived) {
    add(`${client}.room-mismatch`, 'warning', `This mailbox contains separate named (${literal.id}) and project-path (${derived.id}) rooms. Agents in these rooms cannot see each other. Compare Room id from chat_who in both clients and join the same room.`, client);
    report.hints.push('To share a named project default, run agent-chat update --local --room NAME for all installed clients, then restart them. Existing room history stays in its original room.');
  }
}

/** Read-only diagnosis. Credentials, message contents, and session IDs are omitted. */
export async function doctorProject({ project = process.cwd(), client, expectedVersion } = {}) {
  const selected = selectedClient(client);
  const report = { schemaVersion: 1, project: path.resolve(project), status: 'attention', ok: false,
    runtime: { status: 'unknown', installedVersion: null, expectedVersion: null }, clients: [], checks: [], hints: [] };
  const add = (id, status, message, clientId) => report.checks.push({ id, status, message, ...(clientId ? { client: clientId } : {}) });
  const finish = () => {
    report.ok = !report.checks.some(check => check.status === 'error');
    if (report.status !== 'not-installed') report.status = report.ok
      ? (report.checks.some(check => check.status === 'warning') ? 'attention' : 'healthy') : 'attention';
    return report;
  };
  try {
    if (!fs.statSync(report.project).isDirectory()) throw new Error('Project is not a directory');
    report.project = (process.platform === 'win32' || process.platform === 'darwin' ? fs.realpathSync.native : fs.realpathSync)(report.project);
  } catch {
    add('project', 'error', 'Project directory is missing or inaccessible. Choose an existing project.');
    return finish();
  }
  add('node', Number(process.versions.node.split('.')[0]) >= 22 ? 'ok' : 'error',
    Number(process.versions.node.split('.')[0]) >= 22 ? 'Node.js meets the supported baseline.' : 'Use Node.js 22 or newer.');
  let installation;
  let paths;
  let inspectManagedEntry;
  try {
    // Loading the installer parser is limited to this explicit diagnostic path.
    const installer = await import('./install.mjs');
    installation = await installer.inspectInstallation({ project: report.project });
    paths = installer.installationPaths(report.project);
    inspectManagedEntry = installer.inspectManagedEntry;
  } catch {
    add('installation', 'error', 'Installation metadata is malformed, unsupported, or inaccessible. Inspect the project receipt before reinstalling.');
    return finish();
  }
  const receipt = installation.receipt;
  if (!receipt) {
    report.status = 'not-installed';
    report.runtime.status = 'missing';
    add('installation', 'error', 'Agent Chat has no managed installation in this project. Run agent-chat install for this project.');
    return finish();
  }
  if (receipt.schemaVersion !== 1 || !Array.isArray(receipt.clients) || !Array.isArray(receipt.entries)
    || !receipt.files || typeof receipt.files !== 'object' || Object.keys(receipt.files).length > 256
    || receipt.clients.some(value => !CLIENTS.includes(value))) {
    add('installation', 'error', 'Installation receipt format is unsupported. Use a compatible Agent Chat version or inspect the receipt before reinstalling.');
    return finish();
  }
  add('installation', 'ok', 'Managed installation receipt is present; actual files and client settings are checked below.');
  if (installation.relocated) add('installation.location', 'error', 'Project moved since installation. Run agent-chat update --dry-run here, then agent-chat update to rewrite managed paths for all installed clients. Doctor did not change files.');
  const clients = selected ? [selected] : receipt.clients;
  report.clients = clients;
  if (selected && !receipt.clients.includes(selected)) {
    add(`${selected}.installation`, 'error', 'This client is not installed in the project. Run install with this client selected.', selected);
  }
  try {
    report.runtime.expectedVersion = expectedVersion ?? versionAt(path.join(sourceRoot, 'package.json'));
    report.runtime.installedVersion = versionAt(projectFile(report.project, path.relative(report.project, path.join(paths.runtime, 'package.json'))));
    if (report.runtime.installedVersion !== receipt.packageVersion) {
      report.runtime.status = 'changed';
      add('runtime.version', 'error', 'Installed runtime version differs from its receipt. Inspect local changes before running update.');
    } else if (report.runtime.installedVersion !== report.runtime.expectedVersion) {
      report.runtime.status = 'outdated';
      add('runtime.version', 'warning', 'Installed runtime differs from the package running this doctor. Run agent-chat update to refresh it.');
    } else {
      report.runtime.status = 'present';
      add('runtime.version', 'ok', `Installed Agent Chat runtime version ${report.runtime.installedVersion} matches this package.`);
    }
  } catch {
    report.runtime.status = 'missing';
    add('runtime.version', 'error', 'Runtime package metadata is missing, malformed, or inaccessible. Restore the managed file from an installation backup, or review preserved files before uninstalling and reinstalling.');
  }
  try {
    for (const relative of ['agent-chat.mjs', 'lib/mailbox.mjs', 'lib/presentation.mjs']) {
      readFile(projectFile(report.project, path.relative(report.project, path.join(paths.runtime, relative))));
    }
    add('runtime.entrypoints', 'ok', 'MCP entrypoint and shared runtime modules exist.');
  } catch {
    report.runtime.status = 'missing';
    add('runtime.entrypoints', 'error', 'A required runtime entrypoint is missing or unsupported. Run update to restore missing owned files; review unsupported paths before retrying.');
  }
  const fileGroups = new Map();
  for (const [relative, info] of Object.entries(receipt.files)) {
    const owners = Array.isArray(info?.clients) ? info.clients.filter(owner => clients.includes(owner)) : [];
    const runtime = relative.startsWith('.agent-chat/runtime/');
    if (!runtime && owners.length === 0) continue;
    const group = runtime ? 'runtime.files' : `${owners[0]}.${relative.includes('/skills/') ? 'skill' : 'adapter'}`;
    const current = fileGroups.get(group) || { status: 'ok', count: 0, client: runtime ? undefined : owners[0] };
    current.count++;
    try {
      if (!/^[a-f0-9]{64}$/.test(info.sha256)) throw new Error('Unsupported file receipt');
      const actual = crypto.createHash('sha256').update(readFile(projectFile(report.project, relative))).digest('hex');
      if (actual !== info.sha256) current.status = 'changed';
    } catch (error) { current.status = error.code === 'ENOENT' ? 'missing' : 'unsupported'; }
    fileGroups.set(group, current);
  }
  if (!fileGroups.has('runtime.files')) add('runtime.files', 'error', 'Receipt has no runtime files to verify. Inspect the receipt before reinstalling.');
  for (const [group, result] of fileGroups) {
    if (result.status === 'ok') add(group, 'ok', `${result.count} managed ${group === 'runtime.files' ? 'runtime' : group.endsWith('.skill') ? 'skill' : 'adapter'} file(s) match their installation receipt.`, result.client);
    else {
      if (group === 'runtime.files') report.runtime.status = result.status;
      const action = result.status === 'missing' ? 'Run agent-chat update to restore missing owned files.'
        : 'Preserve local edits and restore managed files from an installation backup before updating.';
      add(group, 'error', `Managed ${group === 'runtime.files' ? 'runtime' : group.endsWith('.skill') ? 'skill' : 'adapter'} files are ${result.status}. ${action}`, result.client);
    }
  }
  const roomMetadata = clients.some(value => !receipt.connections?.[value]) ? localRoomMetadata() : [];
  const configuredLocalRooms = new Set(receipt.clients.filter(value => !receipt.connections?.[value]).map(value => receipt.localRooms?.[value] || report.project));
  if (configuredLocalRooms.size > 1) {
    add('rooms.defaults', 'warning', 'Installed local clients have different room defaults. Compare Room id from chat_who and use agent-chat update --local --room NAME to select one shared named default for all clients.');
  }
  for (const clientId of clients.filter(value => receipt.clients.includes(value))) {
    if (clientId === 'opencode' && fs.existsSync(path.join(report.project, 'opencode.jsonc'))) {
      add('opencode.config-format', 'error', 'OpenCode JSONC settings coexist with the managed JSON configuration. Consolidate settings manually before updating Agent Chat.', clientId);
    }
    const connection = receipt.connections?.[clientId];
    if (connection) {
      let available = false;
      try {
        const { readBrokerToken } = await import('./broker-client.mjs');
        readBrokerToken(connection.tokenFile);
        available = true;
      } catch { /* Report only availability, never credentials or their contents. */ }
      add(`${clientId}.broker-token`, available ? 'ok' : 'error', available
        ? 'Broker token file is readable. This check does not contact the broker.'
        : 'Broker token file is missing, inaccessible, or invalid. Mount a readable token file in this client environment.', clientId);
      add(`${clientId}.transport`, 'warning', 'Broker transport is configured with an explicit room. Verify connectivity by calling chat_who in the client; doctor does not start a session.', clientId);
    } else checkLocalRoom({ add, report, receipt, client: clientId, metadata: roomMetadata });
    const entries = receipt.entries.filter(entry => entry.client === clientId);
    const mcp = entries.filter(entry => entryCategory(entry) === 'mcp');
    if (!mcp.length) add(`${clientId}.mcp`, 'error', 'Receipt does not identify the client MCP connection. Inspect the receipt before reinstalling.', clientId);
    for (const entry of entries) {
      const category = entryCategory(entry);
      let actual;
      try {
        projectFile(report.project, entry.path);
        actual = await inspectManagedEntry({ project: report.project, entry });
      } catch { actual = { status: 'malformed' }; }
      const messages = {
        present: `Project ${category === 'mcp' ? 'MCP connection' : 'lifecycle hooks'} match the installed Agent Chat settings.`,
        missing: `Project ${category === 'mcp' ? 'MCP connection' : 'lifecycle hooks'} are missing. Run agent-chat update to restore missing managed settings.`,
        changed: `Project ${category === 'mcp' ? 'MCP connection' : 'lifecycle hooks'} differ from the installation. Inspect your changes before updating.`,
        malformed: `Client configuration is malformed, unsupported, or inaccessible. Fix its syntax before updating Agent Chat.`,
      };
      add(`${clientId}.${category}`, actual.status === 'present' ? 'ok' : 'error', messages[actual.status] || messages.malformed, clientId);
      if (category === 'mcp' && actual.status === 'present') {
        let available = false;
        try { available = executableExists(await entryCommand(entry)); } catch { /* unsupported command metadata */ }
        add(`${clientId}.node`, available ? 'ok' : 'error', available
          ? 'Configured Node.js executable exists and is executable.'
          : 'Configured Node.js executable is missing or not executable. Run Agent Chat update using your current Node.js installation.', clientId);
      }
    }
    if (!Object.entries(receipt.files).some(([file, info]) => file.includes('/skills/') && info.clients?.includes(clientId))) {
      add(`${clientId}.skill`, 'error', 'Managed Agent Chat skill is missing from the receipt. Inspect the receipt before reinstalling.', clientId);
    }
    if (receipt.hooks?.[clientId]) {
      await checkBindings({ report, add, project: report.project, file: paths.notificationConfig, client: clientId, connection });
      if (clientId === 'codex') report.hints.push('In Codex, review and trust the installed hooks with /hooks. File checks cannot confirm client trust.');
    } else add(`${clientId}.hooks`, 'ok', 'Optional lifecycle notifications are disabled for this installation.', clientId);
  }
  if (receipt.clients.length) report.hints.push('Restart or reload the configured clients after install or update so they discover the project MCP connection, skill, and hooks.');
  if (receipt.hooks?.opencode && clients.includes('opencode')) report.hints.push('OpenCode notices run at supported tool and idle-transition events. They do not wake an already idle conversation.');
  return finish();
}

async function checkBindings({ report, add, project, file, client, connection }) {
  try {
    projectFile(project, path.relative(project, file));
    const { readConfig, NOTIFICATION_LIMITS, sameBindingCwd } = await import('../hooks/notifications.mjs');
    const config = readConfig(file);
    const nearCapacity = config.bindings.length >= NOTIFICATION_LIMITS.warningBindings
      || fs.statSync(file).size >= NOTIFICATION_LIMITS.warningBytes;
    const hostClient = client === 'claude' ? 'claude-code' : client;
    const bindings = config.bindings.filter(binding => binding.client === hostClient && sameBindingCwd(binding.cwd, project)
      && (connection ? binding.brokerUrl === connection.url && binding.room === connection.room : !binding.brokerUrl));
    const keys = bindings.map(binding => JSON.stringify([binding.client, binding.hostSessionId, project]));
    if (new Set(keys).size !== keys.length) {
      add(`${client}.notifications`, 'error', 'Notification bindings conflict for this project. Remove duplicate bindings or rerun the binding helper.', client);
    } else if (bindings.length) {
      add(`${client}.notifications`, nearCapacity ? 'warning' : 'ok', `${bindings.length} conversation binding(s) match this client and project. This does not confirm a running client or trusted hooks.`, client);
    } else addBindingHint({ add, report, project, file, client, connection });
    if (nearCapacity) add(`${client}.notification-history`, 'warning', 'Notification binding history is near its bounded limit. New conversations can evict older bindings. Rebind an older conversation with chat_join, chat_who, or the binding helper if its notices stop.', client);
  } catch (error) {
    if (error.code === 'ENOENT') addBindingHint({ add, report, project, file, client, connection });
    else add(`${client}.notifications`, 'error', 'Notification binding config is malformed, unsupported, or inaccessible. Inspect it with the binding guide; doctor did not change it.', client);
  }
}

function addBindingHint({ add, report, project, file, client, connection }) {
  add(`${client}.notifications`, 'warning', client === 'opencode'
    ? 'No conversation binding yet. Follow the notification guide to bind the OpenCode conversation.'
    : 'No conversation binding yet. After reloading the client, call chat_join or chat_who to auto-bind; use the binding helper if structured metadata is unavailable.', client);
  const quote = value => process.platform === 'win32' ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`;
  const flags = [['--config', file], ['--client', client === 'claude' ? 'claude-code' : client],
    ['--host-session', 'HOST_CONVERSATION_ID'], ['--cwd', project],
    ['--room', connection?.room || 'ROOM_ID_FROM_CHAT_WHO'], ['--session', 'MAILBOX_SESSION_FROM_CHAT_WHO'],
    ...(connection ? [['--broker-url', connection.url]] : [])];
  const command = `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} ${quote(path.join(project, '.agent-chat/runtime/hooks/bind.mjs'))} ${flags.map(([key, value]) => `${key} ${quote(value)}`).join(' ')}`;
  report.hints.push(`Manual binding for ${client} (${process.platform === 'win32' ? 'PowerShell' : 'shell'}): replace HOST_CONVERSATION_ID with the hook debug identity and copy the room/session from chat_who; use the exact debug working directory for --cwd if different. ${command}`);
}
