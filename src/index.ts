/**
 * claude-api-config — 前端入口
 *
 * 插件定位（重要）：
 * 这是一个配置文件编辑器，不是运行时 API 路由。
 * - 只负责读写 `~/.claude/settings.json` 中的 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`
 * - 不拦截、不代理任何 API 请求
 * - 不控制 Claude Code 进程生命周期
 * - 保存或恢复后，已运行的 Claude Code 会话不会热切换，需要新建会话或重启进程才生效
 *
 * 实现约束：不引入 UI 框架，全部使用原生 DOM + 行内样式。
 */

import type {
  ConfigResponse,
  ErrorResponse,
  HistoryItem,
  PluginAPI,
  RestoreResponse,
  SaveConfigResponse,
} from './types.js';

/* ------------------------------------------------------------------ */
/* 主题                                                                */
/* ------------------------------------------------------------------ */

/**
 * 深色主题优先的可读配色。
 * 优先使用宿主提供的 CSS 变量（若存在），否则回退到深色主题下可读的固定色值。
 */
const COLOR = {
  fg: 'var(--cli-foreground, #e4e4e7)',
  muted: 'var(--cli-muted-foreground, #a1a1aa)',
  border: 'var(--cli-border, #3f3f46)',
  inputBg: 'var(--cli-input-background, rgba(255, 255, 255, 0.06))',
  panelBg: 'var(--cli-panel-background, rgba(255, 255, 255, 0.03))',
  accent: 'var(--cli-accent, #3b82f6)',
  accentFg: 'var(--cli-accent-foreground, #ffffff)',
  successBg: 'rgba(22, 163, 74, 0.18)',
  successBorder: 'rgba(34, 197, 94, 0.55)',
  successFg: '#4ade80',
  errorBg: 'rgba(220, 38, 38, 0.18)',
  errorBorder: 'rgba(248, 113, 113, 0.55)',
  errorFg: '#f87171',
} as const;

const FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif';

const MONO =
  'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

const NOTICE =
  '本插件仅编辑 ~/.claude/settings.json 中的 ANTHROPIC_BASE_URL 与 ANTHROPIC_AUTH_TOKEN：不拦截、不代理任何 API 请求，也不控制 Claude Code 进程。修改后需新建 Claude Code 会话生效。';

/* ------------------------------------------------------------------ */
/* DOM 工具                                                            */
/* ------------------------------------------------------------------ */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  style: Partial<CSSStyleDeclaration>,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node.style, style);
  if (text !== undefined) node.textContent = text;
  return node;
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'error' in err) {
    const message = (err as ErrorResponse).error;
    if (typeof message === 'string' && message !== '') return message;
  }
  if (typeof err === 'string' && err !== '') return err;
  return '未知错误';
}

/* ------------------------------------------------------------------ */
/* 挂载状态                                                            */
/* ------------------------------------------------------------------ */

interface MountedView {
  root: HTMLDivElement;
  destroy: () => void;
}

let mounted: MountedView | null = null;

/* ------------------------------------------------------------------ */
/* 挂载 / 卸载                                                         */
/* ------------------------------------------------------------------ */

export function mount(container: HTMLElement, api: PluginAPI): void {
  unmount();

  const root = el('div', {
    fontFamily: FONT,
    fontSize: '13px',
    lineHeight: '1.6',
    color: COLOR.fg,
    padding: '20px',
    boxSizing: 'border-box',
    maxWidth: '820px',
    textAlign: 'left',
  });

  /* ---------- 标题 ---------- */
  const title = el(
    'h2',
    { margin: '0 0 6px', fontSize: '17px', fontWeight: '600', color: COLOR.fg },
    'Claude API 配置',
  );

  const subtitle = el(
    'p',
    { margin: '0 0 16px', fontSize: '12px', lineHeight: '1.6', color: COLOR.muted },
    NOTICE,
  );

  /* ---------- 状态提示条 ---------- */
  const status = el('div', {
    display: 'none',
    margin: '0 0 14px',
    padding: '8px 12px',
    borderRadius: '6px',
    border: '1px solid transparent',
    fontSize: '12px',
    lineHeight: '1.5',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  });

  function showStatus(kind: 'success' | 'error', message: string): void {
    status.textContent = message;
    status.style.display = 'block';
    if (kind === 'success') {
      status.style.background = COLOR.successBg;
      status.style.borderColor = COLOR.successBorder;
      status.style.color = COLOR.successFg;
    } else {
      status.style.background = COLOR.errorBg;
      status.style.borderColor = COLOR.errorBorder;
      status.style.color = COLOR.errorFg;
    }
  }

  function hideStatus(): void {
    status.style.display = 'none';
    status.textContent = '';
  }

  /* ---------- 表单 ---------- */
  const baseUrlInput = el('input', {
    display: 'block',
    width: '100%',
    boxSizing: 'border-box',
    padding: '8px 10px',
    fontSize: '13px',
    fontFamily: MONO,
    color: COLOR.fg,
    background: COLOR.inputBg,
    border: `1px solid ${COLOR.border}`,
    borderRadius: '6px',
    outline: 'none',
    caretColor: COLOR.fg,
  });
  baseUrlInput.type = 'text';
  baseUrlInput.placeholder = 'https://api.deepseek.com/anthropic';
  baseUrlInput.spellcheck = false;
  baseUrlInput.autocomplete = 'off';

  const authTokenInput = el('input', {
    display: 'block',
    width: '100%',
    boxSizing: 'border-box',
    padding: '8px 10px',
    fontSize: '13px',
    fontFamily: MONO,
    color: COLOR.fg,
    background: COLOR.inputBg,
    border: `1px solid ${COLOR.border}`,
    borderRadius: '6px',
    outline: 'none',
    caretColor: COLOR.fg,
  });
  authTokenInput.type = 'password';
  authTokenInput.placeholder = 'sk-...';
  authTokenInput.spellcheck = false;
  authTokenInput.autocomplete = 'off';

  function field(labelText: string, input: HTMLElement): HTMLDivElement {
    const wrap = el('div', { marginBottom: '14px' });
    const label = el(
      'label',
      {
        display: 'block',
        marginBottom: '6px',
        fontSize: '12px',
        fontFamily: MONO,
        color: COLOR.muted,
      },
      labelText,
    );
    wrap.append(label, input);
    return wrap;
  }

  const baseUrlField = field('ANTHROPIC_BASE_URL', baseUrlInput);
  const authTokenField = field('ANTHROPIC_AUTH_TOKEN', authTokenInput);

  const saveButton = el(
    'button',
    {
      padding: '8px 18px',
      fontSize: '13px',
      fontWeight: '500',
      color: COLOR.accentFg,
      background: COLOR.accent,
      border: '1px solid transparent',
      borderRadius: '6px',
      cursor: 'pointer',
      transition: 'opacity 120ms ease',
    },
    '保存',
  );
  saveButton.type = 'button';

  /* ---------- 历史记录 ---------- */
  const divider = el('hr', {
    margin: '20px 0 16px',
    border: 'none',
    borderTop: `1px solid ${COLOR.border}`,
  });

  const historyTitle = el(
    'h3',
    { margin: '0 0 10px', fontSize: '14px', fontWeight: '600', color: COLOR.fg },
    '历史记录',
  );

  const historyList = el('div', {
    border: `1px solid ${COLOR.border}`,
    borderRadius: '8px',
    background: COLOR.panelBg,
    overflow: 'hidden',
  });

  root.append(
    title,
    subtitle,
    status,
    baseUrlField,
    authTokenField,
    saveButton,
    divider,
    historyTitle,
    historyList,
  );
  container.appendChild(root);

  /* ---------- 数据加载 ---------- */
  async function loadConfig(): Promise<void> {
    const result = await api.rpc<ConfigResponse>('GET', '/api/config');
    baseUrlInput.value = typeof result.baseUrl === 'string' ? result.baseUrl : '';
    authTokenInput.value = typeof result.authToken === 'string' ? result.authToken : '';
  }

  function renderHistory(items: HistoryItem[]): void {
    historyList.replaceChildren();

    if (items.length === 0) {
      const empty = el(
        'div',
        { padding: '14px', fontSize: '12px', color: COLOR.muted },
        '暂无历史记录',
      );
      historyList.appendChild(empty);
      return;
    }

    items.forEach((item, index) => {
      const row = el('div', {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px',
        padding: '9px 12px',
        borderTop: index === 0 ? 'none' : `1px solid ${COLOR.border}`,
      });

      const info = el('div', { minWidth: '0', flex: '1 1 auto' });

      const time = el(
        'div',
        { fontSize: '12px', color: COLOR.fg, whiteSpace: 'nowrap' },
        item.timestamp,
      );

      const url = el(
        'div',
        {
          fontSize: '11px',
          fontFamily: MONO,
          color: COLOR.muted,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        },
        item.baseUrl !== '' ? item.baseUrl : '(BASE_URL 为空)',
      );
      url.title = item.baseUrl;

      info.append(time, url);

      const restoreButton = el(
        'button',
        {
          flex: '0 0 auto',
          padding: '5px 12px',
          fontSize: '12px',
          color: COLOR.fg,
          background: 'transparent',
          border: `1px solid ${COLOR.border}`,
          borderRadius: '6px',
          cursor: 'pointer',
        },
        '恢复',
      );
      restoreButton.type = 'button';
      restoreButton.addEventListener('click', () => {
        void onRestore(item, restoreButton);
      });

      row.append(info, restoreButton);
      historyList.appendChild(row);
    });
  }

  async function loadHistory(): Promise<void> {
    const items = await api.rpc<HistoryItem[]>('GET', '/api/history');
    renderHistory(Array.isArray(items) ? items : []);
  }

  async function reloadAll(): Promise<void> {
    await Promise.all([loadConfig(), loadHistory()]);
  }

  /* ---------- 交互 ---------- */
  async function onSave(): Promise<void> {
    const baseUrl = baseUrlInput.value.trim();
    const authToken = authTokenInput.value.trim();

    if (baseUrl === '') {
      showStatus('error', 'ANTHROPIC_BASE_URL 不能为空。');
      baseUrlInput.focus();
      return;
    }
    if (authToken === '') {
      showStatus('error', 'ANTHROPIC_AUTH_TOKEN 不能为空。');
      authTokenInput.focus();
      return;
    }

    saveButton.disabled = true;
    saveButton.style.opacity = '0.6';
    saveButton.style.cursor = 'default';
    saveButton.textContent = '保存中…';

    try {
      await api.rpc<SaveConfigResponse>('POST', '/api/config', { baseUrl, authToken });
      try {
        await reloadAll();
      } catch (err) {
        showStatus('error', `保存成功，但刷新界面失败：${errMessage(err)}`);
        return;
      }
      showStatus('success', '保存成功。请新建 Claude Code 会话以生效。');
    } catch (err) {
      showStatus('error', errMessage(err));
    } finally {
      saveButton.disabled = false;
      saveButton.style.opacity = '1';
      saveButton.style.cursor = 'pointer';
      saveButton.textContent = '保存';
    }
  }

  async function onRestore(item: HistoryItem, button: HTMLButtonElement): Promise<void> {
    const confirmed = window.confirm(
      `确认恢复到该历史版本？\n\n时间：${item.timestamp}\nBASE_URL：${item.baseUrl || '(空)'}\n\n当前配置会先被自动备份。`,
    );
    if (!confirmed) return;

    button.disabled = true;
    button.style.opacity = '0.6';

    try {
      await api.rpc<RestoreResponse>('POST', '/api/restore', { filename: item.filename });
      try {
        await reloadAll();
      } catch (err) {
        showStatus('error', `恢复成功，但刷新界面失败：${errMessage(err)}`);
        return;
      }
      showStatus('success', '恢复成功。请新建 Claude Code 会话以生效。');
    } catch (err) {
      showStatus('error', errMessage(err));
    } finally {
      button.disabled = false;
      button.style.opacity = '1';
    }
  }

  const onSaveClick = (): void => {
    void onSave();
  };
  saveButton.addEventListener('click', onSaveClick);

  const onEnter = (event: KeyboardEvent): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void onSave();
    }
  };
  baseUrlInput.addEventListener('keydown', onEnter);
  authTokenInput.addEventListener('keydown', onEnter);

  const onBaseUrlInput = (): void => hideStatus();
  baseUrlInput.addEventListener('input', onBaseUrlInput);
  authTokenInput.addEventListener('input', onBaseUrlInput);

  /* ---------- 上下文订阅 ---------- */
  // 本插件不依赖上下文内容，仅保留订阅以便宿主切换主题/工作区时卸载时不残留监听
  const unsubscribe = api.onContextChange(() => {
    /* 无需响应，界面样式全部使用宿主 CSS 变量自动跟随主题 */
  });

  /* ---------- 首次加载 ---------- */
  hideStatus();
  void reloadAll().catch((err: unknown) => {
    showStatus('error', errMessage(err));
  });

  mounted = {
    root,
    destroy: () => {
      unsubscribe();
      saveButton.removeEventListener('click', onSaveClick);
      baseUrlInput.removeEventListener('keydown', onEnter);
      authTokenInput.removeEventListener('keydown', onEnter);
      baseUrlInput.removeEventListener('input', onBaseUrlInput);
      authTokenInput.removeEventListener('input', onBaseUrlInput);
      root.remove();
    },
  };
}

export function unmount(): void {
  if (mounted === null) return;
  mounted.destroy();
  mounted = null;
}
