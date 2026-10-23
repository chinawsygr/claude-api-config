/**
 * claude-api-config — 类型定义
 *
 * 插件定位（重要）：
 * 这是一个配置文件编辑器，不是运行时 API 路由。
 * - 只负责读写 `~/.claude/settings.json` 中的 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`
 * - 不拦截、不代理任何 API 请求
 * - 不控制 Claude Code 进程生命周期
 * - 保存或恢复后，已运行的 Claude Code 会话不会热切换，需要新建会话或重启进程才生效
 */

/** 插件宿主注入的上下文。字段按宿主实际提供为准，此处仅声明本插件可能读取的部分。 */
export interface PluginContext {
  /** 当前主题，用于适配深色/浅色 */
  readonly theme?: 'light' | 'dark';
  /** 当前语言 */
  readonly locale?: string;
  /** 当前工作区路径（本插件不依赖，仅保留） */
  readonly workspacePath?: string;
  /** 宿主可能扩展的其他字段 */
  readonly [key: string]: unknown;
}

/** 宿主通过 mount(container, api) 注入的前端 API。 */
export interface PluginAPI {
  /** 当前上下文（只读） */
  readonly context: PluginContext;
  /** 订阅上下文变化，返回取消订阅函数 */
  onContextChange(listener: (context: PluginContext) => void): () => void;
  /** 调用本插件后端接口，method 为大写 HTTP 方法（GET/POST…），path 以 `/api/` 开头 */
  rpc<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
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
