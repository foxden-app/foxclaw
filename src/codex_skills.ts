import fs from 'node:fs';
import path from 'node:path';

const BUNDLED_CODEX_SKILLS = ['telegram-voice-delivery', 'telegram-media-delivery'] as const;

export function installBundledCodexSkills(packageRoot: string, codexHome: string): string[] {
  const installed: string[] = [];
  for (const skillName of BUNDLED_CODEX_SKILLS) {
    const sourceDir = path.join(packageRoot, 'skills', skillName);
    if (!fs.existsSync(path.join(sourceDir, 'SKILL.md'))) continue;
    const destinationDir = path.join(codexHome, 'skills', skillName);
    fs.mkdirSync(destinationDir, { recursive: true, mode: 0o700 });
    fs.cpSync(sourceDir, destinationDir, { recursive: true, force: true });
    installed.push(skillName);
  }
  return installed;
}
