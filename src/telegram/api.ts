import fs from 'node:fs';
import http from 'node:http';
import type { IncomingMessage } from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

export interface TelegramApiResult<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

export interface TelegramRemoteFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

const DEFAULT_API_BASE_URL = 'https://api.telegram.org';

export async function callTelegramApi<T>(botToken: string, method: string, body: Record<string, unknown>): Promise<TelegramApiResult<T>> {
  const payload = JSON.stringify(body);
  const endpoint = telegramApiUrl(botToken, method);
  return new Promise<TelegramApiResult<T>>((resolve, reject) => {
    const request = requestForUrl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve(JSON.parse(text) as TelegramApiResult<T>);
        } catch (error) {
          reject(new Error(`Failed to parse Telegram response: ${String(error)}`));
        }
      });
    });
    request.on('error', reject);
    request.setTimeout(telegramApiTimeoutMs(false), () => {
      request.destroy(new Error(`Telegram API request timed out for ${method}`));
    });
    request.write(payload);
    request.end();
  });
}

export async function callTelegramMultipartApi<T>(
  botToken: string,
  method: string,
  fields: Record<string, string>,
  files: Array<{ fieldName: string; filename: string; contents: Buffer; contentType: string }>,
): Promise<TelegramApiResult<T>> {
  const boundary = `foxclaw-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${escapeMultipartName(name)}"\r\n\r\n${value}\r\n`,
      'utf8',
    ));
  }
  for (const file of files) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${escapeMultipartName(file.fieldName)}"; filename="${escapeMultipartName(file.filename)}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
      'utf8',
    ));
    parts.push(file.contents);
    parts.push(Buffer.from('\r\n', 'utf8'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  const payload = Buffer.concat(parts);
  const endpoint = telegramApiUrl(botToken, method);
  return new Promise<TelegramApiResult<T>>((resolve, reject) => {
    const request = requestForUrl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': payload.length,
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve(JSON.parse(text) as TelegramApiResult<T>);
        } catch (error) {
          reject(new Error(`Failed to parse Telegram response: ${String(error)}`));
        }
      });
    });
    request.on('error', reject);
    request.setTimeout(telegramApiTimeoutMs(true), () => {
      request.destroy(new Error(`Telegram API request timed out for ${method}`));
    });
    request.write(payload);
    request.end();
  });
}

export async function getTelegramFile(botToken: string, fileId: string): Promise<TelegramRemoteFile> {
  const result = await callTelegramApi<TelegramRemoteFile>(botToken, 'getFile', { file_id: fileId });
  if (!result.ok || !result.result) {
    throw new Error(result.description || `Failed to resolve Telegram file ${fileId}`);
  }
  return result.result;
}

export async function downloadTelegramFile(botToken: string, remoteFilePath: string, destinationPath: string): Promise<number> {
  await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
  const tempPath = `${destinationPath}.tmp-${process.pid}-${Date.now()}`;
  let response: IncomingMessage | null = null;
  try {
    const endpoint = telegramFileUrl(botToken, remoteFilePath);
    response = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = getForUrl(endpoint, (incoming) => {
        const statusCode = incoming.statusCode ?? 500;
        if (statusCode >= 400) {
          incoming.resume();
          reject(new Error(`Telegram file download failed with status ${statusCode}`));
          return;
        }
        resolve(incoming);
      });
      request.on('error', reject);
      request.setTimeout(telegramApiTimeoutMs(true), () => {
        request.destroy(new Error(`Telegram file download timed out for ${remoteFilePath}`));
      });
    });

    let bytesWritten = 0;
    response.on('data', (chunk: Buffer | string) => {
      bytesWritten += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
    });
    await pipeline(response, fs.createWriteStream(tempPath));
    await fs.promises.rename(tempPath, destinationPath);
    return bytesWritten;
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  } finally {
    response?.destroy();
  }
}

function escapeMultipartName(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\r', '').replaceAll('\n', '');
}

function telegramApiBaseUrl(): string {
  const raw = process.env.TELEGRAM_BOT_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL;
  return raw.replace(/\/+$/g, '');
}

function telegramApiUrl(botToken: string, method: string): URL {
  return new URL(`${telegramApiBaseUrl()}/bot${botToken}/${method}`);
}

function telegramFileUrl(botToken: string, remoteFilePath: string): URL {
  return new URL(`${telegramApiBaseUrl()}/file/bot${botToken}/${remoteFilePath}`);
}

function telegramApiTimeoutMs(multipart: boolean): number {
  const raw = Number.parseInt(process.env.TELEGRAM_BOT_API_TIMEOUT_MS ?? '', 10);
  if (Number.isFinite(raw) && raw > 0) {
    return raw;
  }
  return multipart ? 300_000 : 20_000;
}

function requestForUrl(
  url: URL,
  options: http.RequestOptions,
  callback: (response: IncomingMessage) => void,
): http.ClientRequest {
  const client = url.protocol === 'http:' ? http : https;
  return client.request({
    ...options,
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || undefined,
    path: `${url.pathname}${url.search}`,
    family: url.hostname === 'localhost' ? undefined : 4,
  }, callback);
}

function getForUrl(url: URL, callback: (response: IncomingMessage) => void): http.ClientRequest {
  const client = url.protocol === 'http:' ? http : https;
  return client.get({
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || undefined,
    path: `${url.pathname}${url.search}`,
    family: url.hostname === 'localhost' ? undefined : 4,
  }, callback);
}
