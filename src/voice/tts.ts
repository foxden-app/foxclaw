import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { AppConfig } from '../config.js';

const execFileAsync = promisify(execFile);

export interface VoiceSynthesisResult {
  filename: string;
  contents: Buffer;
  contentType: 'audio/ogg';
}

export async function synthesizeTelegramVoice(text: string, config: AppConfig): Promise<VoiceSynthesisResult> {
  if (!config.voiceTtsEnabled) {
    throw new Error('voice TTS is disabled');
  }
  const normalized = normalizeVoiceText(text, config.voiceTextLimit);
  if (!normalized) {
    throw new Error('voice text is empty');
  }
  const contents = config.voiceTtsMode === 'ssh'
    ? await synthesizeViaSsh(normalized, config)
    : await synthesizeViaHttp(normalized, config);
  return {
    filename: `foxclaw-summary-${Date.now()}.ogg`,
    contents,
    contentType: 'audio/ogg',
  };
}

export function normalizeVoiceText(text: string, limit: number): string {
  const normalized = text
    .replace(/```[\s\S]*?```/g, ' 代码块已省略。 ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/!\[[^\]]*]\([^)]+\)/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/^\s*[-*+]\s+/gm, ' - ')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\|/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return normalized.length > limit ? `${normalized.slice(0, Math.max(0, limit - 20)).trim()}。后文省略。` : normalized;
}

async function synthesizeViaHttp(text: string, config: AppConfig): Promise<Buffer> {
  if (!config.voiceTtsUrl) {
    throw new Error('VOICE_TTS_URL is not configured');
  }
  if (config.voiceTtsEngine === 'soulx') {
    return convertToOggOpus(await requestTtsWav(config, '/v1/tts', { text, seed: '7' }), config.voiceFfmpegBin);
  }
  try {
    return convertToOggOpus(await requestTtsWav(config, '/v1/tts/custom', { text, language: 'zh' }), config.voiceFfmpegBin);
  } catch (error) {
    if (!isNoCustomSpeakerError(error)) {
      throw error;
    }
  }
  const wav = await requestTtsWav(config, '/v1/tts/design', {
    text,
    language: 'zh',
    instruct: config.voiceTtsDesignInstruct,
  });
  return convertToOggOpus(wav, config.voiceFfmpegBin);
}

async function requestTtsWav(config: AppConfig, pathname: string, body: Record<string, string>): Promise<Buffer> {
  if (!config.voiceTtsUrl) {
    throw new Error('VOICE_TTS_URL is not configured');
  }
  const endpoint = new URL(pathname, config.voiceTtsUrl.endsWith('/') ? config.voiceTtsUrl : `${config.voiceTtsUrl}/`);
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), config.voiceTtsTimeoutMs);
  const response = await fetch(endpoint, {
    method: 'POST',
    signal: abortController.signal,
    headers: {
      'content-type': 'application/json',
      ...(config.voiceTtsToken ? { authorization: `Bearer ${config.voiceTtsToken}` } : {}),
    },
    body: JSON.stringify(body),
  }).finally(() => clearTimeout(timer));
  if (!response.ok) {
    throw new Error(`TTS request failed: ${response.status} ${response.statusText}: ${await response.text().catch(() => '')}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function isNoCustomSpeakerError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('no supported speakers');
}

async function convertToOggOpus(input: Buffer, ffmpegBin: string): Promise<Buffer> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxclaw-voice-'));
  const inputPath = path.join(root, 'input.wav');
  const outputPath = path.join(root, 'voice.ogg');
  try {
    await fs.writeFile(inputPath, input, { mode: 0o600 });
    await execFileAsync(ffmpegBin, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      inputPath,
      '-ac',
      '1',
      '-c:a',
      'libopus',
      '-b:a',
      '32k',
      outputPath,
    ], { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
    return await fs.readFile(outputPath);
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function synthesizeViaSsh(text: string, config: AppConfig): Promise<Buffer> {
  if (!config.voiceTtsSshHost) {
    throw new Error('VOICE_TTS_SSH_HOST is not configured');
  }
  if (!config.voiceTtsSshDir) {
    throw new Error('VOICE_TTS_SSH_DIR is not configured');
  }
  if (config.voiceTtsEngine === 'soulx') {
    return synthesizeSoulxViaSsh(text, config);
  }
  const encodedText = Buffer.from(text, 'utf8').toString('base64');
  const script = String.raw`set -euo pipefail
TEXT="$(printf '%s' "$1" | base64 -d)"
SERVICE_DIR="$2"
cd "$SERVICE_DIR"
set -a
. ./.env
set +a
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
TEXT="$TEXT" python3 - <<'PY' > "$tmp/body.json"
import json
import os
print(json.dumps({"text": os.environ["TEXT"], "language": "zh"}, ensure_ascii=False))
PY
status="$(curl -sS -w '%{http_code}' -X POST http://127.0.0.1:18081/v1/tts/custom \
  -H "Authorization: Bearer $QWEN_SPEECH_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary "@$tmp/body.json" \
  --output "$tmp/tts.wav")"
if [[ "$status" != "200" ]]; then
  if grep -q 'no supported speakers' "$tmp/tts.wav"; then
    INSTRUCT="$3" TEXT="$TEXT" python3 - <<'PY' > "$tmp/body.json"
import json
import os
print(json.dumps({
    "text": os.environ["TEXT"],
    "language": "zh",
    "instruct": os.environ["INSTRUCT"],
}, ensure_ascii=False))
PY
    status="$(curl -sS -w '%{http_code}' -X POST http://127.0.0.1:18081/v1/tts/design \
      -H "Authorization: Bearer $QWEN_SPEECH_API_TOKEN" \
      -H "Content-Type: application/json" \
      --data-binary "@$tmp/body.json" \
      --output "$tmp/tts.wav")"
  fi
fi
if [[ "$status" != "200" ]]; then
  python3 - "$tmp/tts.wav" <<'PY' >&2
import pathlib
import sys
sys.stdout.buffer.write(pathlib.Path(sys.argv[1]).read_bytes())
PY
  exit 22
fi
ffmpeg -nostdin -hide_banner -loglevel error -y -i "$tmp/tts.wav" -ac 1 -c:a libopus -b:a 32k "$tmp/voice.ogg"
python3 - "$tmp/voice.ogg" <<'PY'
import pathlib
import sys
sys.stdout.buffer.write(pathlib.Path(sys.argv[1]).read_bytes())
PY
`;
  return runSshBinary([
    config.voiceTtsSshHost,
    'bash',
    '-s',
    '--',
    encodedText,
    config.voiceTtsSshDir,
    config.voiceTtsDesignInstruct,
  ], script, config.voiceTtsTimeoutMs);
}

async function synthesizeSoulxViaSsh(text: string, config: AppConfig): Promise<Buffer> {
  const sshHost = config.voiceTtsSshHost;
  const envDir = config.voiceTtsSshDir;
  if (!sshHost) {
    throw new Error('VOICE_TTS_SSH_HOST is not configured');
  }
  if (!envDir) {
    throw new Error('VOICE_TTS_SSH_DIR is not configured');
  }
  const encodedText = Buffer.from(text, 'utf8').toString('base64');
  const baseUrl = config.voiceTtsUrl || 'http://127.0.0.1:18082';
  const script = String.raw`set -euo pipefail
TEXT="$(printf '%s' "$1" | base64 -d)"
ENV_DIR="$2"
BASE_URL="$3"
cd "$ENV_DIR"
set -a
. ./.env
set +a
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -sS "\${BASE_URL}/health" >/dev/null
TEXT="$TEXT" python3 - <<'PY' > "$tmp/body.json"
import json
import os
print(json.dumps({"text": os.environ["TEXT"], "seed": 7, "dialect_prompt": ""}, ensure_ascii=False))
PY
status="$(curl -sS -w '%{http_code}' -X POST "\${BASE_URL}/v1/tts" \
  -H "Authorization: Bearer $QWEN_SPEECH_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary "@$tmp/body.json" \
  --output "$tmp/tts.wav")"
if [[ "$status" != "200" ]]; then
  python3 - "$tmp/tts.wav" <<'PY' >&2
import pathlib
import sys
sys.stdout.buffer.write(pathlib.Path(sys.argv[1]).read_bytes())
PY
  exit 22
fi
ffmpeg -nostdin -hide_banner -loglevel error -y -i "$tmp/tts.wav" -ac 1 -c:a libopus -b:a 32k "$tmp/voice.ogg"
python3 - "$tmp/voice.ogg" <<'PY'
import pathlib
import sys
sys.stdout.buffer.write(pathlib.Path(sys.argv[1]).read_bytes())
PY
`;
  return runSshBinary([
    sshHost,
    'bash',
    '-s',
    '--',
    encodedText,
    envDir,
    baseUrl,
  ], script, config.voiceTtsTimeoutMs);
}

async function runSshBinary(args: string[], stdin: string, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('remote TTS timed out'));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`remote TTS failed with exit ${code}: ${Buffer.concat(stderr).toString('utf8').trim()}`));
        return;
      }
      const output = Buffer.concat(stdout);
      if (output.length === 0) {
        reject(new Error(`remote TTS returned empty audio: ${Buffer.concat(stderr).toString('utf8').trim()}`));
        return;
      }
      resolve(output);
    });
    child.stdin.end(stdin);
  });
}
