/**
 * claude-api-config — 类型定义
 *
 * 插件定位（重要）：
 * 这是一个配置文件编辑器，不是运行时 API 路由。
 * - 只负责读写 `~/.claude/settings.json` 中的 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`
 * - 不拦截、不代理任何 API 请求
 * - 不控制 Claude Code 进程生命周期
 * - 保存或恢复后，已运行的 Claude Code 会话不会热切换，需要新建会话或重启进程才生效
 *
 * PluginContext / PluginAPI 与 CloudCLI 官方 docs/plugins/frontend-api 保持一致。
 */

/** 宿主注入的上下文（官方结构） */
export interface PluginContext {
  /** 当前主题，随用户切换实时变化 */
  theme: 'dark' | 'light';
  /** 当前选中的项目，未选中为 null */
  project: { name: string; path: string } | null;
  /** 当前会话，无会话为 null */
  session: { id: string; title: string } | null;
}

/** 宿主通过 mount(container, api) 注入的前端 API */
export interface PluginAPI {
  /** 当前上下文（每次访问都返回最新值） */
  readonly context: PluginContext;
  /** 订阅上下文变化，返回取消订阅函数（订阅时不会立即回调） */
  onContextChange(callback: (context: PluginContext) => void): () => void;
  /** 调用插件后端；path 前导斜杠会被剥离，按同路径转发到插件服务器 */
  rpc<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
}

/** 插件入口模块导出 */
export interface PluginModule {
  mount(container: HTMLElement, api: PluginAPI): void | Promise<void>;
  unmount?(container: HTMLElement): void;
}

/** `GET /api/config` 返回体 */
export interface ConfigResponse {
  /** settings.env.ANTHROPIC_BASE_URL，不存在时为空字符串 */
  baseUrl: string;
  /** settings.env.ANTHROPIC_AUTH_TOKEN，不存在时为空字符串 */
  authToken: string;
  /** 文件是否存在且内容非空 */
  exists: boolean;
}

/** `POST /api/config` 请求体 */
export interface SaveConfigRequest {
  baseUrl: string;
  authToken: string;
}

/** `POST /api/config` 返回体 */
export interface SaveConfigResponse {
  success: true;
}

/** `GET /api/history` 返回数组的元素 */
export interface HistoryItem {
  /** 历史文件名，例如 `settings-2026-10-23T13-27-35-123Z.json` */
  filename: string;
  /** 从文件名解析出的可读时间 */
  timestamp: string;
  /** 该历史文件中的 ANTHROPIC_BASE_URL，解析失败为空字符串 */
  baseUrl: string;
}

/** `POST /api/restore` 请求体 */
export interface RestoreRequest {
  filename: string;
}

/** `POST /api/restore` 返回体 */
export interface RestoreResponse {
  success: true;
}

/** 后端统一错误返回体 */
export interface ErrorResponse {
  error: string;
}

/* ------------------------------------------------------------------ */
/* Token 用量统计                                                      */
/* ------------------------------------------------------------------ */

/** 一组 token 计数 */
export interface UsageTotals {
  /** 输入 token */
  input: number;
  /** 输出 token */
  output: number;
  /** 缓存写入 token */
  cacheCreate: number;
  /** 缓存读取 token */
  cacheRead: number;
  /** 四项之和 */
  total: number;
}

/** 按天聚合 */
export interface UsageDayBucket extends UsageTotals {
  /** 本地日期 YYYY-MM-DD */
  date: string;
}

/** 按模型聚合 */
export interface UsageModelBucket extends UsageTotals {
  model: string;
}

/** `GET /api/usage` 返回体 */
export interface UsageReport {
  /** 生效的时间范围：all / 30d / 7d */
  range: string;
  totals: UsageTotals;
  /** 按天，最新在前 */
  byDay: UsageDayBucket[];
  /** 按模型，总量降序 */
  byModel: UsageModelBucket[];
  /** 有 token 记录的会话数 */
  sessions: number;
  /** 计入统计的助手消息数（已按 message.id 去重） */
  messages: number;
  /** 实际扫描的日志文件数 */
  files: number;
  /** 统计时间 */
  scannedAt: string;
}

/* ------------------------------------------------------------------ */
/* 配置变更日志                                                        */
/* ------------------------------------------------------------------ */

/** 单条变更记录（令牌字段均已脱敏） */
export interface ChangeLogEntry {
  /** ISO 时间 */
  at: string;
  /** save = 保存配置，restore = 从历史恢复 */
  action: 'save' | 'restore';
  /** restore 时对应的历史文件名 */
  filename?: string;
  baseUrl: { from: string; to: string };
  authToken: { from: string; to: string };
}
