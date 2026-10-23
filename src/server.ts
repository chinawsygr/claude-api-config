/**
 * claude-api-config — 后端服务
 *
 * 插件定位（重要）：
 * 这是一个配置文件编辑器，不是运行时 API 路由。
 * - 只负责读写 `~/.claude/settings.json` 中的 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`
 * - 不拦截、不代理任何 API 请求，也不参与 Claude Code 的运行时请求链路
 * - 不能控制 Claude Code 进程生命周期（不重启、不 kill）
 * - 保存或恢复后，已运行的 Claude Code 会话不会热切换，需要新建会话或重启进程才生效
 *
 * 实现约束：只使用 Node.js 内置模块（http / fs/promises / path / os），不引入任何框架。
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import type {
  ConfigResponse,
  ErrorResponse,
  HistoryItem,
  RestoreResponse,
  SaveConfigResponse,
} from './types.js';

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

/** 目标配置文件：~/.claude/settings.json */
const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

/** 插件数据目录：~/.claude-code-ui/plugins/claude-api-config/data */
const DATA_DIR = path.join(
  os.homedir(),
  '.claude-code-ui',
  'plugins',
  'claude-api-config',
  'data',
);

/** 历史备份目录 */
const HISTORY_DIR = path.join(DATA_DIR, 'history');

/** 历史最多保留份数 */
const MAX_HISTORY = 20;

/** 请求体大小上限（1MB），避免异常请求耗尽内存 */
const MAX_BODY_BYTES = 1024 * 1024;

const ENV_BASE_URL = 'ANTHROPIC_BASE_URL';
const ENV_AUTH_TOKEN = 'ANTHROPIC_AUTH_TOKEN';

/** 顶层 settings 对象的宽松类型：保留未知字段原样写回 */
type SettingsObject = Record<string, unknown>;

/* ------------------------------------------------------------------ */
/* 错误类型                                                            */
/* ------------------------------------------------------------------ */

/** 带 HTTP 状态码的业务错误，最终以 `{ error }` 形式返回前端 */
class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

function errorCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/* ------------------------------------------------------------------ */
/* settings.json 读写                                                  */
/* ------------------------------------------------------------------ */

interface SettingsReadResult {
  /** 文件存在且内容非空（损坏文件也会抛错，不会走到这里） */
  exists: boolean;
  /** 原始文本，用于原样备份 */
  raw: string;
  /** 解析后的对象；文件不存在或为空时为 {} */
  data: SettingsObject;
}

/**
 * 读取 settings.json。
 * - 不存在 / 内容为空：返回 { exists: false, raw: '', data: {} }
 * - 存在但 JSON 异常：抛 500「settings.json 格式异常，无法解析」（不覆盖损坏文件）
 */
async function readSettings(): Promise<SettingsReadResult> {
  let raw: string;
  try {
    raw = await fs.readFile(SETTINGS_PATH, 'utf8');
  } catch (err) {
    if (errorCode(err) === 'ENOENT') {
      return { exists: false, raw: '', data: {} };
    }
    throw new HttpError(500, `读取 settings.json 失败：${errorMessage(err)}`);
  }

  if (raw.trim() === '') {
    return { exists: false, raw, data: {} };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(500, 'settings.json 格式异常，无法解析');
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(500, 'settings.json 格式异常，无法解析');
  }

  return { exists: true, raw, data: parsed as SettingsObject };
}

/** 安全地取出 settings.env 中的字符串字段 */
function readEnvString(data: SettingsObject, key: string): string {
  const env = data.env;
  if (env === null || typeof env !== 'object' || Array.isArray(env)) return '';
  const value = (env as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

/** 取出可写的 env 对象（缺失或类型异常时新建） */
function ensureEnvObject(data: SettingsObject): Record<string, unknown> {
  const env = data.env;
  if (env !== null && typeof env === 'object' && !Array.isArray(env)) {
    return env as Record<string, unknown>;
  }
  const created: Record<string, unknown> = {};
  data.env = created;
  return created;
}

/** 写入 settings.json（自动创建 .claude 目录） */
async function writeSettings(settings: SettingsObject): Promise<void> {
  try {
    await fs.mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
    await fs.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    throw new HttpError(500, `写入 settings.json 失败：${errorMessage(err)}`);
  }
}

/** 把原始文本原样写回 settings.json（恢复用） */
async function writeSettingsRaw(raw: string): Promise<void> {
  try {
    await fs.mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
    await fs.writeFile(SETTINGS_PATH, raw, 'utf8');
  } catch (err) {
    throw new HttpError(500, `写入 settings.json 失败：${errorMessage(err)}`);
  }
}

/* ------------------------------------------------------------------ */
/* 历史备份                                                            */
/* ------------------------------------------------------------------ */

/** 生成备份文件名：settings-{ISO 时间戳，: 和 . 替换为 -}.json */
function historyFilename(date = new Date()): string {
  const stamp = date.toISOString().replace(/[:.]/g, '-');
  return `settings-${stamp}.json`;
}

/** 列出历史文件名，按文件名倒序（最新在前）。目录不存在返回空数组。 */
async function listHistoryFiles(): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(HISTORY_DIR);
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return [];
    throw new HttpError(500, `读取历史目录失败：${errorMessage(err)}`);
  }
  return entries
    .filter((name) => name.startsWith('settings-') && name.endsWith('.json'))
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}

/** 只保留最新 MAX_HISTORY 份，删除最旧的 */
async function pruneHistory(): Promise<void> {
  let files: string[];
  try {
    files = await listHistoryFiles();
  } catch {
    return; // 清理失败不影响主流程
  }
  const stale = files.slice(MAX_HISTORY);
  for (const name of stale) {
    try {
      await fs.unlink(path.join(HISTORY_DIR, name));
    } catch {
      // 忽略单个文件删除失败
    }
  }
}

/**
 * 备份当前 settings.json。
 * - 文件不存在或为空：跳过
 * - 文件损坏（JSON 异常）：跳过，且不覆盖损坏文件（由调用方已提前拒绝）
 */
async function backupCurrentSettings(): Promise<void> {
  const current = await readSettings(); // 损坏时抛出 500，调用方因此不会继续写盘
  if (!current.exists) return;

  try {
    await fs.mkdir(HISTORY_DIR, { recursive: true });
    await fs.writeFile(
      path.join(HISTORY_DIR, historyFilename()),
      current.raw,
      'utf8',
    );
  } catch (err) {
    throw new HttpError(500, `备份 settings.json 失败：${errorMessage(err)}`);
  }

  await pruneHistory();
}

/** 从备份文件名还原可读时间；解析失败时退回文件名主体 */
function parseTimestamp(filename: string): string {
  const stem = filename.replace(/^settings-/, '').replace(/\.json$/, '');
  const separator = stem.indexOf('T');
  if (separator > 0) {
    const datePart = stem.slice(0, separator);
    const timePart = stem.slice(separator + 1);
    const matched = /^(\d{2})-(\d{2})-(\d{2})-(\d{3})(Z?)$/.exec(timePart);
    if (matched) {
      const iso = `${datePart}T${matched[1]}:${matched[2]}:${matched[3]}.${matched[4]}${matched[5] || 'Z'}`;
      const date = new Date(iso);
      if (!Number.isNaN(date.getTime())) {
        return date.toLocaleString('zh-CN', { hour12: false });
      }
    }
  }
  return stem;
}

/** 校验历史文件名，防止路径穿越 */
function assertSafeHistoryFilename(filename: string): void {
  const ok =
    filename.startsWith('settings-') &&
    filename.endsWith('.json') &&
    !filename.includes('/') &&
    !filename.includes('\\') &&
    !filename.includes('..') &&
    filename.length > 'settings-.json'.length;
  if (!ok) {
    throw new HttpError(400, `非法的历史文件名：${filename}`);
  }
  const resolved = path.resolve(HISTORY_DIR, filename);
  if (path.dirname(resolved) !== path.resolve(HISTORY_DIR)) {
    throw new HttpError(400, `非法的历史文件名：${filename}`);
  }
}

/* ------------------------------------------------------------------ */
/* 校验                                                                */
/* ------------------------------------------------------------------ */

/** baseUrl 必须是合法的 http / https URL */
function assertValidBaseUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new HttpError(400, `${ENV_BASE_URL} 不是合法的 URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new HttpError(400, `${ENV_BASE_URL} 必须以 http:// 或 https:// 开头`);
  }
  if (!parsed.hostname) {
    throw new HttpError(400, `${ENV_BASE_URL} 不是合法的 URL`);
  }
}

/* ------------------------------------------------------------------ */
/* HTTP 工具                                                           */
/* ------------------------------------------------------------------ */

function setCommonHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  setCommonHeaders(res);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body).toString());
  res.end(body);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  const payload: ErrorResponse = { error: message };
  sendJson(res, status, payload);
}

/** 读取并解析 JSON 请求体 */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, '请求体过大');
    }
    chunks.push(buf);
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw === '') return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(400, '请求体不是合法的 JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, '请求体必须是 JSON 对象');
  }
  return parsed as Record<string, unknown>;
}

function readStringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value : '';
}

/* ------------------------------------------------------------------ */
/* 路由处理                                                            */
/* ------------------------------------------------------------------ */

/** GET /api/config */
async function handleGetConfig(res: ServerResponse): Promise<void> {
  const current = await readSettings();
  const payload: ConfigResponse = {
    baseUrl: current.exists ? readEnvString(current.data, ENV_BASE_URL) : '',
    authToken: current.exists ? readEnvString(current.data, ENV_AUTH_TOKEN) : '',
    exists: current.exists,
  };
  sendJson(res, 200, payload);
}

/** POST /api/config */
async function handleSaveConfig(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const baseUrl = readStringField(body, 'baseUrl').trim();
  const authToken = readStringField(body, 'authToken').trim();

  if (baseUrl === '') throw new HttpError(400, `${ENV_BASE_URL} 不能为空`);
  if (authToken === '') throw new HttpError(400, `${ENV_AUTH_TOKEN} 不能为空`);
  assertValidBaseUrl(baseUrl);

  // 先备份当前配置；settings.json 损坏时 readSettings 会抛 500，从而拒绝覆盖
  await backupCurrentSettings();

  const current = await readSettings();
  const settings = current.data;
  const env = ensureEnvObject(settings);
  env[ENV_BASE_URL] = baseUrl;
  env[ENV_AUTH_TOKEN] = authToken;

  await writeSettings(settings);

  const payload: SaveConfigResponse = { success: true };
  sendJson(res, 200, payload);
}

/** GET /api/history */
async function handleGetHistory(res: ServerResponse): Promise<void> {
  const files = await listHistoryFiles();
  const items: HistoryItem[] = [];

  for (const filename of files) {
    let baseUrl = '';
    try {
      const raw = await fs.readFile(path.join(HISTORY_DIR, filename), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        baseUrl = readEnvString(parsed as SettingsObject, ENV_BASE_URL);
      }
    } catch {
      baseUrl = '';
    }
    items.push({ filename, timestamp: parseTimestamp(filename), baseUrl });
  }

  sendJson(res, 200, items);
}

/** POST /api/restore */
async function handleRestore(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const filename = readStringField(body, 'filename').trim();

  if (filename === '') throw new HttpError(400, 'filename 不能为空');
  assertSafeHistoryFilename(filename);

  const sourcePath = path.join(HISTORY_DIR, filename);

  let content: string;
  try {
    content = await fs.readFile(sourcePath, 'utf8');
  } catch (err) {
    if (errorCode(err) === 'ENOENT') {
      throw new HttpError(404, `历史文件不存在：${filename}`);
    }
    throw new HttpError(500, `读取历史文件失败：${errorMessage(err)}`);
  }

  // 恢复前确认备份内容可解析，避免把明显损坏的内容写回配置文件
  try {
    JSON.parse(content);
  } catch {
    throw new HttpError(400, `历史文件内容不是合法 JSON，拒绝恢复：${filename}`);
  }

  // 先备份当前配置（损坏的 settings.json 会在此被拒绝，不会覆盖）
  await backupCurrentSettings();

  // 再把历史文件内容原样写回
  await writeSettingsRaw(content);

  const payload: RestoreResponse = { success: true };
  sendJson(res, 200, payload);
}

/* ------------------------------------------------------------------ */
/* 服务启动                                                            */
/* ------------------------------------------------------------------ */

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  if (method === 'OPTIONS') {
    setCommonHeaders(res);
    res.statusCode = 204;
    res.end();
    return;
  }

  if (pathname === '/api/config' && method === 'GET') {
    await handleGetConfig(res);
    return;
  }
  if (pathname === '/api/config' && method === 'POST') {
    await handleSaveConfig(req, res);
    return;
  }
  if (pathname === '/api/history' && method === 'GET') {
    await handleGetHistory(res);
    return;
  }
  if (pathname === '/api/restore' && method === 'POST') {
    await handleRestore(req, res);
    return;
  }

  throw new HttpError(404, `未知接口：${method} ${pathname}`);
}

const server = createServer((req, res) => {
  void route(req, res).catch((err: unknown) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (err instanceof HttpError) {
      sendError(res, err.status, err.message);
      return;
    }
    sendError(res, 500, errorMessage(err));
  });
});

server.on('error', (err) => {
  process.stderr.write(`[claude-api-config] server error: ${errorMessage(err)}\n`);
  process.exit(1);
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  // 宿主通过这一行获知端口
  process.stdout.write(`${JSON.stringify({ ready: true, port })}\n`);
});

function shutdown(): void {
  server.close(() => process.exit(0));
  // 兜底：5 秒内未正常关闭则强制退出
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
