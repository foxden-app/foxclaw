import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { installBundledCodexSkills } from './codex_skills.js';

test('installBundledCodexSkills copies managed skills into a Codex home', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxclaw-skills-'));
  try {
    const voiceSourceDir = path.join(root, 'package', 'skills', 'telegram-voice-delivery');
    const mediaSourceDir = path.join(root, 'package', 'skills', 'telegram-media-delivery');
    const codexHome = path.join(root, 'codex-home');
    fs.mkdirSync(voiceSourceDir, { recursive: true });
    fs.mkdirSync(mediaSourceDir, { recursive: true });
    fs.writeFileSync(path.join(voiceSourceDir, 'SKILL.md'), 'voice version one');
    fs.writeFileSync(path.join(mediaSourceDir, 'SKILL.md'), 'media version one');

    assert.deepEqual(installBundledCodexSkills(path.join(root, 'package'), codexHome), ['telegram-voice-delivery', 'telegram-media-delivery']);
    assert.equal(
      fs.readFileSync(path.join(codexHome, 'skills', 'telegram-voice-delivery', 'SKILL.md'), 'utf8'),
      'voice version one',
    );
    assert.equal(
      fs.readFileSync(path.join(codexHome, 'skills', 'telegram-media-delivery', 'SKILL.md'), 'utf8'),
      'media version one',
    );

    fs.writeFileSync(path.join(voiceSourceDir, 'SKILL.md'), 'voice version two');
    installBundledCodexSkills(path.join(root, 'package'), codexHome);
    assert.equal(
      fs.readFileSync(path.join(codexHome, 'skills', 'telegram-voice-delivery', 'SKILL.md'), 'utf8'),
      'voice version two',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
