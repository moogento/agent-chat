import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CHAT_LABEL } from './presentation.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
export const MANAGEMENT_COMMANDS = new Set(['install', 'update', 'uninstall', 'doctor']);

function usage(command) {
  if (command === 'doctor') return 'agent-chat doctor [--project PATH] [--json]';
  return `agent-chat ${command} [--clients codex,claude,opencode] [--project PATH]${command !== 'uninstall' ? ' [--hooks | --no-hooks] [--wake-permission | --no-wake-permission] [--room NAME] [--broker-url URL --broker-token-file PATH | --local]' : ''} [--dry-run] [--json]`;
}

export async function managementCli(command, argv) {
  const options = {
    project: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    ...(command !== 'doctor' ? { clients: { type: 'string' }, 'dry-run': { type: 'boolean' } } : {}),
    ...(['install', 'update'].includes(command) ? { hooks: { type: 'boolean' }, 'no-hooks': { type: 'boolean' }, 'wake-permission': { type: 'boolean' }, 'no-wake-permission': { type: 'boolean' }, 'broker-url': { type: 'string' }, 'broker-token-file': { type: 'string' }, room: { type: 'string' }, local: { type: 'boolean' } } : {}),
  };
  const { values } = parseArgs({ args: argv, options, strict: true, allowPositionals: false });
  if (values.help) { console.log(usage(command)); return; }
  if (values.hooks && values['no-hooks']) throw new Error('Choose --hooks or --no-hooks, not both.');
  if (values['wake-permission'] && values['no-wake-permission']) throw new Error('Choose --wake-permission or --no-wake-permission, not both.');
  if (values.clients !== undefined && (!values.clients.trim() || values.clients.split(',').some(value => !value.trim()))) {
    throw new Error('--clients must be a nonempty comma-separated list.');
  }
  if (values.project !== undefined && !values.project.trim()) throw new Error('--project must be a nonempty path.');
  const project = path.resolve(values.project ?? process.cwd());
  if (command === 'doctor') {
    const { doctorProject } = await import('./doctor.mjs');
    const result = await doctorProject({ project });
    if (values.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`${CHAT_LABEL}: ${result.status}\nProject: ${result.project}`);
      for (const check of result.checks) console.log(`${check.status.toUpperCase()}: ${check.message}`);
      for (const hint of result.hints) console.log(`Next: ${hint}`);
    }
    if (!result.ok) process.exitCode = 1;
    return result;
  }
  const installer = await import('./install.mjs');
  if (command === 'install' && values.clients === undefined) {
    const detected = installer.detectClients({ project });
    const message = 'Choose clients explicitly with --clients codex,claude,opencode. No settings were changed.';
    if (values.json) console.log(JSON.stringify({ action: 'detect', project, detected, message }, null, 2));
    else console.log(`${CHAT_LABEL}\nDetected: ${detected.length ? detected.join(', ') : 'none'}\n${message}\n${usage(command)}`);
    return;
  }
  const operation = { install: 'installProject', update: 'updateProject', uninstall: 'uninstallProject' }[command];
  const result = await installer[operation]({ project, clients: values.clients, sourceRoot,
    brokerUrl: values['broker-url'], brokerTokenFile: values['broker-token-file'], room: values.room, local: values.local,
    hooks: values.hooks ? true : values['no-hooks'] ? false : undefined,
    wakePermission: values['wake-permission'] ? true : values['no-wake-permission'] ? false : undefined, dryRun: values['dry-run'] || false });
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`${CHAT_LABEL}: ${result.dryRun ? 'preview of ' : ''}${command}\nProject: ${result.project}`);
    console.log(`Clients: ${result.clients.join(', ')}`);
    for (const change of result.changes) console.log(`${change.action}: ${change.path}`);
    if (!result.changes.length) console.log('No changes needed.');
    for (const warning of result.warnings || []) console.log(`Note: ${warning}`);
    if (result.backup) console.log(`Backup: ${result.backup}`);
    if (!result.dryRun && command !== 'uninstall') console.log('Restart the selected clients, then run agent-chat doctor. Review any client trust prompts before enabling hooks.');
  }
  return result;
}
