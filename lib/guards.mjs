import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const GUARD_FILE = '.agent-chat-guards.json';
export const GUARD_LIMITS = Object.freeze({ guards: 50, patternChars: 500, fileBytes: 64 * 1024 });
const LOCK_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SITE_SLOT = '$<site>';
const SITE_VALUE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
const COMMAND_TOOLS = /^(Bash|shell|exec_command|local_shell|mcp__terminal__run_in_terminal)$/;

function readGuardFile(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > GUARD_LIMITS.fileBytes) throw new Error('is not a regular file of at most 64 KiB');
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
}

export function parseGuards(config, source) {
  if (config?.version !== 1 || !Array.isArray(config.guards) || config.guards.length > GUARD_LIMITS.guards) {
    throw new Error(`${source}: requires version 1 and at most ${GUARD_LIMITS.guards} guards`);
  }
  return config.guards.map((guard, index) => {
    const label = `${source}: guard ${index + 1}`;
    if (!guard || typeof guard !== 'object' || !LOCK_NAME.test(guard.lock ?? '')) throw new Error(`${label} needs a lock name of 1 to 64 safe characters`);
    if (typeof guard.pattern !== 'string' || !guard.pattern || guard.pattern.length > GUARD_LIMITS.patternChars) throw new Error(`${label} needs a pattern of at most ${GUARD_LIMITS.patternChars} characters`);
    const perSite = guard.siteLock !== undefined;
    if (perSite !== (guard.site !== undefined)) throw new Error(`${label}: siteLock and site go together`);
    if (perSite && (typeof guard.siteLock !== 'string' || guard.siteLock.split(SITE_SLOT).length !== 2 || !LOCK_NAME.test(guard.siteLock.replace(SITE_SLOT, 'x')))) throw new Error(`${label} siteLock needs one ${SITE_SLOT} in a safe lock name`);
    if (perSite && (!Array.isArray(guard.site) || !guard.site.length || guard.site.length > 10)) throw new Error(`${label} needs 1 to 10 site patterns`);
    const compile = (pattern, what, flags = 'i') => {
      if (typeof pattern !== 'string' || !pattern || pattern.length > GUARD_LIMITS.patternChars) throw new Error(`${label} needs a ${what} of at most ${GUARD_LIMITS.patternChars} characters`);
      try { return new RegExp(pattern, flags); } catch (error) { throw new Error(`${label} ${what} is invalid: ${error.message}`); }
    };
    const regex = compile(guard.pattern, 'pattern');
    const site = perSite ? guard.site.map(pattern => {
      const siteRegex = compile(pattern, 'site pattern', 'gi');
      if (!pattern.includes('(?<site>')) throw new Error(`${label} site pattern needs a (?<site>...) group`);
      return siteRegex;
    }) : null;
    return { lock: perSite ? guard.siteLock : guard.lock, regex, site, pattern: guard.pattern, why: typeof guard.why === 'string' ? guard.why.slice(0, 300) : '', source };
  });
}

/** Guards from the nearest project guard file above each directory, plus the mailbox-wide file. */
export function loadGuards(directories, home = process.env.AGENT_CHAT_HOME || path.join(os.homedir(), '.agent-chat')) {
  const files = new Set();
  for (const start of directories.filter(dir => typeof dir === 'string' && path.isAbsolute(dir))) {
    let dir = path.resolve(start);
    for (;;) {
      const file = path.join(dir, GUARD_FILE);
      if (fs.existsSync(file)) { files.add(file); break; }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  const global = path.join(home, 'guards.json');
  if (fs.existsSync(global)) files.add(global);
  return [...files].flatMap(file => {
    let config;
    try { config = readGuardFile(file); } catch (error) { throw new Error(`${file}: ${error.message}`); }
    return parseGuards(config, file);
  });
}

/** The shell command a tool call will run, or null for tools that run none. */
export function commandText(toolName, toolInput) {
  if (typeof toolName !== 'string' || !COMMAND_TOOLS.test(toolName) || !toolInput || typeof toolInput !== 'object') return null;
  const value = toolInput.command ?? toolInput.cmd;
  const text = Array.isArray(value) ? value.filter(item => typeof item === 'string').join(' ') : typeof value === 'string' ? value : null;
  return text;
}

export function matchingGuards(guards, command) {
  return guards.filter(guard => guard.regex.test(command));
}

/** The lock names one matched guard needs: one per site the command names, none when it names no site. */
export function guardLocks(guard, command) {
  if (!guard.site) return [guard.lock];
  const sites = new Set();
  for (const regex of guard.site) {
    for (const match of command.matchAll(regex)) {
      const value = match.groups?.site?.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
      if (value && SITE_VALUE.test(value)) sites.add(value);
    }
  }
  return [...sites].map(site => guard.lock.replace(SITE_SLOT, site)).filter(lock => LOCK_NAME.test(lock));
}

/**
 * Decide one tool call. Unguarded commands pass without touching the mailbox; a guarded command
 * passes only while this host session's bound mailbox session holds every lock it needs.
 */
export async function guardDecision({ client, payload, env = process.env, mailbox, findBinding }) {
  const command = commandText(payload?.tool_name, payload?.tool_input);
  if (command === null) return { allow: true };
  const projectDir = client === 'claude-code' ? env.CLAUDE_PROJECT_DIR : undefined;
  let guards;
  try { guards = loadGuards([payload.cwd, projectDir], env.AGENT_CHAT_HOME); }
  catch (error) {
    // Commands that touch the guard file stay runnable so it can be repaired.
    if (command.includes('agent-chat-guards')) return { allow: true };
    return { allow: false, reason: `agent-chat guard: ${error.message}. Fix the guard file before running other commands.` };
  }
  const matched = matchingGuards(guards, command);
  if (!matched.length) return { allow: true };
  const why = matched.map(guard => guard.why).filter(Boolean)[0];
  const unnamed = matched.filter(guard => !guardLocks(guard, command).length);
  if (unnamed.length) {
    const lock = unnamed[0].lock.replace(SITE_SLOT, '<site>');
    return { allow: false, reason: `agent-chat guard: this command needs a per-site ${lock} lock${why ? ` (${why})` : ''}, but it names no site the guard can read. Name the site in the command (for example --site example.com), then call chat_lock(lock: "${lock}") for that site only.` };
  }
  const locks = [...new Set(matched.flatMap(guard => guardLocks(guard, command)))];
  const instruction = `Call chat_lock(lock: "${locks[0]}", note: "<what you are doing>") first; it announces the lock to your room and fails if another session holds it. Call chat_unlock after the operation is finished and verified.`;
  const prefix = `agent-chat guard: this command needs the ${locks.join(', ')} lock${locks.length > 1 ? 's' : ''}${why ? ` (${why})` : ''}.`;
  try {
    // Broker locks live in the broker's home, which this hook cannot read; the skill rule still applies.
    if (env.AGENT_CHAT_BROKER_URL) return { allow: true, unchecked: 'broker' };
    const hostSessionId = typeof payload.session_id === 'string' ? payload.session_id : '';
    const cwd = projectDir || payload.cwd;
    findBinding ??= (await import('../hooks/notifications.mjs')).findBinding;
    const binding = hostSessionId ? findBinding({ client, hostSessionId, cwd, env }) : null;
    if (!binding) return { allow: false, reason: `${prefix} This session is not linked to agent-chat yet: call chat_who once, then ${instruction}` };
    if (!mailbox) {
      const { createMailbox } = await import('./mailbox.mjs');
      mailbox = createMailbox({ home: env.AGENT_CHAT_HOME || path.join(os.homedir(), '.agent-chat'), cwd });
    }
    for (const lock of locks) {
      const held = mailbox.heldLock(lock);
      if (!held) return { allow: false, reason: `${prefix} ${instruction}` };
      if (held.sessionId !== binding.mailboxSessionId) return { allow: false, reason: `${prefix} ${mailbox.describeLock(held)}. Wait for its UNLOCK; do not start this operation in parallel.` };
    }
    return { allow: true, locks };
  } catch (error) {
    return { allow: false, reason: `${prefix} The lock could not be checked (${error.message}); retry shortly.` };
  }
}
