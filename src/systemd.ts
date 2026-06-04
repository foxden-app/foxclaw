import fs from 'node:fs';
import path from 'node:path';

export interface SystemdDropInUpdate {
  path: string;
  replacements: number;
}

export interface FoxclawSystemdUnitTextOptions {
  workingDirectory: string;
  envPath: string;
  home: string;
  user: string;
  logname: string;
  pathValue: string;
  execStart: string;
}

const FOXCLAW_MAIN_PATH_RE =
  /\S*(?:\.pnpm\/@foxden-app\+foxclaw@[^/\s]+\/node_modules\/@foxden-app\/foxclaw|node_modules\/@foxden-app\/foxclaw)\/dist\/main\.js/g;

export function buildFoxclawSystemdUnitText(options: FoxclawSystemdUnitTextOptions): string {
  return `[Unit]
Description=FoxClaw local Codex execution bridge
Documentation=https://github.com/foxden-app/foxclaw
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=${options.workingDirectory}
EnvironmentFile=-${options.envPath}
Environment=HOME=${options.home}
Environment=USER=${options.user}
Environment=LOGNAME=${options.logname}
Environment=PATH=${options.pathValue}
Environment=FOXCLAW_ENV=${options.envPath}
ExecStart=${options.execStart}
Restart=always
RestartSec=10
TimeoutStopSec=45
KillMode=control-group

[Install]
WantedBy=default.target
`;
}

export function refreshFoxclawExecStartDropIns(
  userSystemdDir: string,
  unitName: string,
  escapedEntryPoint: string,
): SystemdDropInUpdate[] {
  const dropInDir = path.join(userSystemdDir, `${unitName}.d`);
  let names: string[];
  try {
    names = fs.readdirSync(dropInDir).filter((name) => name.endsWith('.conf')).sort();
  } catch {
    return [];
  }

  const updates: SystemdDropInUpdate[] = [];
  for (const name of names) {
    const filePath = path.join(dropInDir, name);
    let before = '';
    try {
      before = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    const { text, replacements } = refreshFoxclawExecStartText(before, escapedEntryPoint);
    if (replacements === 0 || text === before) {
      continue;
    }
    fs.writeFileSync(filePath, text, 'utf8');
    updates.push({ path: filePath, replacements });
  }
  return updates;
}

export function removeFoxclawExecStartDropIns(userSystemdDir: string, unitName: string): SystemdDropInUpdate[] {
  const dropInDir = path.join(userSystemdDir, `${unitName}.d`);
  let names: string[];
  try {
    names = fs.readdirSync(dropInDir).filter((name) => name.endsWith('.conf')).sort();
  } catch {
    return [];
  }

  const updates: SystemdDropInUpdate[] = [];
  for (const name of names) {
    const filePath = path.join(dropInDir, name);
    let before = '';
    try {
      before = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    const { text, replacements } = removeFoxclawExecStartText(before);
    if (replacements === 0 || text === before) {
      continue;
    }
    if (isEmptyServiceDropIn(text)) {
      fs.rmSync(filePath, { force: true });
    } else {
      fs.writeFileSync(filePath, text, 'utf8');
    }
    updates.push({ path: filePath, replacements });
  }
  return updates;
}

export function refreshFoxclawExecStartText(text: string, escapedEntryPoint: string): { text: string; replacements: number } {
  let replacements = 0;
  const lines = text.split(/(\r?\n)/);
  const refreshed = lines.map((part) => {
    if (!part.startsWith('ExecStart=') || part.trim() === 'ExecStart=') {
      return part;
    }
    return part.replace(FOXCLAW_MAIN_PATH_RE, () => {
      replacements += 1;
      return escapedEntryPoint;
    });
  });
  return { text: refreshed.join(''), replacements };
}

export function removeFoxclawExecStartText(text: string): { text: string; replacements: number } {
  const hasFoxclawExecStart = text
    .split(/\r?\n/)
    .some((line) => line.startsWith('ExecStart=') && FOXCLAW_MAIN_PATH_RE.test(line));
  if (!hasFoxclawExecStart) {
    return { text, replacements: 0 };
  }

  let replacements = 0;
  const lines = text.split(/(\r?\n)/);
  const cleaned = lines.map((part) => {
    if (!part.startsWith('ExecStart=')) {
      return part;
    }
    replacements += 1;
    return '';
  });
  return { text: cleaned.join(''), replacements };
}

function isEmptyServiceDropIn(text: string): boolean {
  const meaningfulLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return meaningfulLines.length === 0 || (meaningfulLines.length === 1 && meaningfulLines[0] === '[Service]');
}
