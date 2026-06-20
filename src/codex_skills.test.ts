import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { installBundledCodexSkills } from './codex_skills.js';

test('installBundledCodexSkills copies managed skills into a Codex home', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxclaw-skills-'));
  try {
    const sourceDir = path.join(root, 'package', 'skills', 'telegram-voice-delivery');
    const codexHome = path.join(root, 'codex-home');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'SKILL.md'), 'version one');

    assert.deepEqual(installBundledCodexSkills(path.join(root, 'package'), codexHome), ['telegram-voice-delivery']);
    assert.equal(
      fs.readFileSync(path.join(codexHome, 'skills', 'telegram-voice-delivery', 'SKILL.md'), 'utf8'),
      'version one',
    );

    fs.writeFileSync(path.join(sourceDir, 'SKILL.md'), 'version two');
    installBundledCodexSkills(path.join(root, 'package'), codexHome);
    assert.equal(
      fs.readFileSync(path.join(codexHome, 'skills', 'telegram-voice-delivery', 'SKILL.md'), 'utf8'),
      'version two',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
