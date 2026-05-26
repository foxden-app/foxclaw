import fs from 'node:fs';
import path from 'node:path';

export interface SystemdDropInUpdate {
  path: string;
  replacements: number;
}

const FOXCLAW_MAIN_PATH_RE =
  /\S*(?:\.pnpm\/@foxden-app\+foxclaw@[^/\s]+\/node_modules\/@foxden-app\/foxclaw|node_modules\/@foxden-app\/foxclaw)\/dist\/main\.js/g;

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
