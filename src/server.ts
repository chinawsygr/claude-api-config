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
import { createReadStream, promises as fs } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import os from 'node:os';

import type {
  ChangeLogEntry,
  ConfigResponse,
  ErrorResponse,
  HistoryItem,
  RestoreResponse,
  SaveConfigResponse,
  UsageReport,
} from './types.js';

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

/**
 * 用户主目录。
 * CloudCLI 只向插件进程透传 PATH / HOME / NODE_ENV / PLUGIN_NAME，
 * Windows 上 os.homedir() 依赖 USERPROFILE，故显式按优先级回退。
 */
const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();

/** 目标配置文件：~/.claude/settings.json */
const SETTINGS_PATH = path.join(HOME, '.claude', 'settings.json');

/** 插件数据目录：~/.claude-code-ui/plugins/claude-api-config/data */
const DATA_DIR = path.join(
  HOME,
  '.claude-code-ui',
  'plugins',
  'claude-api-config',
  'data',
);

/** 历史备份目录 */
const HISTORY_DIR = path.join(DATA_DIR, 'history');

/** 变更日志文件（JSONL，追加写） */
const CHANGELOG_PATH = path.join(DATA_DIR, 'changelog.jsonl');

/** 变更日志保留条数 */
const MAX_CHANGELOG = 500;

/** Claude Code 会话日志目录：~/.claude/projects/<project>/<session>.jsonl */
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');

/** 用量统计结果缓存时间（避免每次切 tab 都全量扫描） */
const USAGE_CACHE_TTL = 30_000;

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
/* 变更日志                                                            */
/* ------------------------------------------------------------------ */

/**
 * 令牌脱敏：只保留首 3 位与末 4 位，其余用 * 替代。
 * 变更日志永远只记录脱敏后的值，绝不落盘完整令牌。
 */
function maskToken(token: string): string {
  if (token === '') return '';
  if (token.length <= 8) return '****';
  return `${token.slice(0, 3)}****${token.slice(-4)}`;
}

/** 追加一条变更日志，必要时裁剪到 MAX_CHANGELOG 条 */
async function appendChangeLog(entry: ChangeLogEntry): Promise<void> {
  const line = `${JSON.stringify(entry)}\n`;
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.appendFile(CHANGELOG_PATH, line, 'utf8');
  } catch (err) {
    // 日志写失败不影响主流程，仅记录到 stderr
    process.stderr.write(`[claude-api-config] changelog append failed: ${errorMessage(err)}\n`);
    return;
  }

  // 文件超过 256KB 时裁剪，避免无限增长
  try {
    const stat = await fs.stat(CHANGELOG_PATH);
    if (stat.size <= 256 * 1024) return;
    const raw = await fs.readFile(CHANGELOG_PATH, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim() !== '');
    const kept = lines.slice(-MAX_CHANGELOG);
    await fs.writeFile(CHANGELOG_PATH, kept.map((l) => `${l}\n`).join(''), 'utf8');
  } catch {
    // 裁剪失败忽略
  }
}

/** 读取变更日志，返回最新在前的数组 */
async function readChangeLog(limit: number): Promise<ChangeLogEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(CHANGELOG_PATH, 'utf8');
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return [];
    throw new HttpError(500, `读取变更日志失败：${errorMessage(err)}`);
  }

  const entries: ChangeLogEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        entries.push(parsed as ChangeLogEntry);
      }
    } catch {
      // 单行损坏跳过
    }
  }
  entries.reverse();
  return entries.slice(0, limit);
}

/* ------------------------------------------------------------------ */
/* Token 用量统计                                                      */
/* ------------------------------------------------------------------ */

interface UsageTotals {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  total: number;
}

function emptyTotals(): UsageTotals {
  return { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 };
}

function addTotals(target: UsageTotals, source: UsageTotals): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheCreate += source.cacheCreate;
  target.cacheRead += source.cacheRead;
  target.total += source.total;
}

/** 本地日期 YYYY-MM-DD */
function localDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 递归列出 ~/.claude/projects 下的所有 *.jsonl 会话文件 */
async function listSessionFiles(): Promise<Array<{ file: string; project: string; session: string }>> {
  let projectDirs: string[];
  try {
    projectDirs = await fs.readdir(PROJECTS_DIR);
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return [];
    throw new HttpError(500, `读取会话目录失败：${errorMessage(err)}`);
  }

  const result: Array<{ file: string; project: string; session: string }> = [];
  for (const project of projectDirs) {
    const projectPath = path.join(PROJECTS_DIR, project);
    let entries: Array<{ name: string; isFile: () => boolean }>;
    try {
      entries = await fs.readdir(projectPath, { withFileTypes: true });
    } catch {
      continue; // 不是目录或无权限，跳过
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      result.push({
        file: path.join(projectPath, entry.name),
        project,
        session: entry.name.replace(/\.jsonl$/, ''),
      });
    }
  }
  return result;
}

/** 从单条 usage 中取出各项 token */
function readUsage(raw: unknown): UsageTotals | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const usage = raw as Record<string, unknown>;
  const num = (key: string): number => {
    const value = usage[key];
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
  };
  const input = num('input_tokens');
  const output = num('output_tokens');
  const cacheCreate = num('cache_creation_input_tokens');
  const cacheRead = num('cache_read_input_tokens');
  if (input === 0 && output === 0 && cacheCreate === 0 && cacheRead === 0) return null;
  return { input, output, cacheCreate, cacheRead, total: input + output + cacheCreate + cacheRead };
}

const RANGE_DAYS: Record<string, number | null> = { '7d': 7, '30d': 30, all: null };

let usageCache: { key: string; at: number; data: UsageReport } | null = null;

/** 扫描所有会话日志，按天 / 按模型聚合 token 用量 */
async function buildUsageReport(range: string): Promise<UsageReport> {
  const days = RANGE_DAYS[range] ?? null;
  const cacheKey = `${range}`;
  if (usageCache !== null && usageCache.key === cacheKey && Date.now() - usageCache.at < USAGE_CACHE_TTL) {
    return usageCache.data;
  }

  const cutoff = days === null ? null : Date.now() - days * 24 * 60 * 60 * 1000;
  const files = await listSessionFiles();

  const totals = emptyTotals();
  const dayMap = new Map<string, UsageTotals>();
  const modelMap = new Map<string, UsageTotals>();
  const seenMessageIds = new Set<string>();
  let sessions = 0;
  let messages = 0;
  let scannedFiles = 0;

  for (const item of files) {
    // 范围过滤的快速路径：文件修改时间早于窗口起点就整份跳过
    if (cutoff !== null) {
      try {
        const stat = await fs.stat(item.file);
        if (stat.mtimeMs < cutoff - 24 * 60 * 60 * 1000) continue;
      } catch {
        continue;
      }
    }

    scannedFiles += 1;
    let sessionCounted = false;
    const before = { ...totals };

    try {
      const stream = createReadStream(item.file, { encoding: 'utf8' });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      for await (const line of rl) {
        if (line.trim() === '') continue;
        let record: unknown;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        if (record === null || typeof record !== 'object') continue;
        const row = record as Record<string, unknown>;
        if (row.type !== 'assistant') continue;

        const message = row.message;
        if (message === null || typeof message !== 'object') continue;
        const msg = message as Record<string, unknown>;
        const usage = readUsage(msg.usage);
        if (usage === null) continue;

        // 同一条助手消息可能被拆成多行（每行重复完整 usage），按 message.id 去重
        const id = typeof msg.id === 'string' ? msg.id : '';
        if (id !== '') {
          if (seenMessageIds.has(id)) continue;
          seenMessageIds.add(id);
        }

        const timestamp = typeof row.timestamp === 'string' ? row.timestamp : '';
        const at = timestamp === '' ? null : new Date(timestamp);
        if (at !== null && !Number.isNaN(at.getTime())) {
          if (cutoff !== null && at.getTime() < cutoff) continue;
        }

        const model = typeof msg.model === 'string' && msg.model !== '' ? msg.model : 'unknown';

        addTotals(totals, usage);
        if (at !== null && !Number.isNaN(at.getTime())) {
          const day = localDay(at);
          const bucket = dayMap.get(day) ?? emptyTotals();
          addTotals(bucket, usage);
          dayMap.set(day, bucket);
        }
        const modelBucket = modelMap.get(model) ?? emptyTotals();
        addTotals(modelBucket, usage);
        modelMap.set(model, modelBucket);

        messages += 1;
        sessionCounted = true;
      }
      rl.close();
      stream.destroy();
    } catch (err) {
      process.stderr.write(`[claude-api-config] read ${item.file} failed: ${errorMessage(err)}\n`);
      // 回滚该文件已累加的部分，避免半份数据
      totals.input = before.input;
      totals.output = before.output;
      totals.cacheCreate = before.cacheCreate;
      totals.cacheRead = before.cacheRead;
      totals.total = before.total;
      sessionCounted = false;
    }

    if (sessionCounted) sessions += 1;
  }

  const byDay = [...dayMap.entries()]
    .map(([date, value]) => ({ date, ...value }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  const byModel = [...modelMap.entries()]
    .map(([model, value]) => ({ model, ...value }))
    .sort((a, b) => b.total - a.total);

  const report: UsageReport = {
    range: days === null ? 'all' : `${days}d`,
    totals,
    byDay,
    byModel,
    sessions,
    messages,
    files: scannedFiles,
    scannedAt: new Date().toISOString(),
  };

  usageCache = { key: cacheKey, at: Date.now(), data: report };
  return report;
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
  const previousBaseUrl = readEnvString(settings, ENV_BASE_URL);
  const previousToken = readEnvString(settings, ENV_AUTH_TOKEN);
  const env = ensureEnvObject(settings);
  env[ENV_BASE_URL] = baseUrl;
  env[ENV_AUTH_TOKEN] = authToken;

  await writeSettings(settings);

  await appendChangeLog({
    at: new Date().toISOString(),
    action: 'save',
    baseUrl: { from: previousBaseUrl, to: baseUrl },
    authToken: { from: maskToken(previousToken), to: maskToken(authToken) },
  });

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

  const before = await readSettings();
  const beforeBaseUrl = readEnvString(before.data, ENV_BASE_URL);
  const beforeToken = readEnvString(before.data, ENV_AUTH_TOKEN);

  // 再把历史文件内容原样写回
  await writeSettingsRaw(content);

  let afterBaseUrl = '';
  let afterToken = '';
  try {
    const after = await readSettings();
    afterBaseUrl = readEnvString(after.data, ENV_BASE_URL);
    afterToken = readEnvString(after.data, ENV_AUTH_TOKEN);
  } catch {
    // 历史内容可解析（前面已校验），此处异常仅影响日志展示
  }

  await appendChangeLog({
    at: new Date().toISOString(),
    action: 'restore',
    filename,
    baseUrl: { from: beforeBaseUrl, to: afterBaseUrl },
    authToken: { from: maskToken(beforeToken), to: maskToken(afterToken) },
  });

  const payload: RestoreResponse = { success: true };
  sendJson(res, 200, payload);
}

/** GET /api/usage?range=all|30d|7d */
async function handleGetUsage(res: ServerResponse, range: string): Promise<void> {
  const normalized = range === '7d' || range === '30d' ? range : 'all';
  const report = await buildUsageReport(normalized);
  sendJson(res, 200, report);
}

/** GET /api/changelog?limit=50 */
async function handleGetChangeLog(res: ServerResponse, limitRaw: string): Promise<void> {
  const parsed = Number.parseInt(limitRaw, 10);
  const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, MAX_CHANGELOG) : 50;
  const entries = await readChangeLog(limit);
  sendJson(res, 200, entries);
}

/* ------------------------------------------------------------------ */
/* 服务启动                                                            */
/* ------------------------------------------------------------------ */

/**
 * 路由匹配。
 * 宿主把 `api.rpc('GET', '/api/config')` 原样转发过来，因此服务器收到 `/api/config`；
 * 同时兼容不带 `/api` 前缀的写法（`/config`）。
 */
function isRoute(pathname: string, name: string): boolean {
  return pathname === `/api/${name}` || pathname === `/${name}`;
}

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

  if (isRoute(pathname, 'config') && method === 'GET') {
    await handleGetConfig(res);
    return;
  }
  if (isRoute(pathname, 'config') && method === 'POST') {
    await handleSaveConfig(req, res);
    return;
  }
  if (isRoute(pathname, 'history') && method === 'GET') {
    await handleGetHistory(res);
    return;
  }
  if (isRoute(pathname, 'restore') && method === 'POST') {
    await handleRestore(req, res);
    return;
  }
  if (isRoute(pathname, 'usage') && method === 'GET') {
    await handleGetUsage(res, url.searchParams.get('range') ?? 'all');
    return;
  }
  if (isRoute(pathname, 'changelog') && method === 'GET') {
    await handleGetChangeLog(res, url.searchParams.get('limit') ?? '50');
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
