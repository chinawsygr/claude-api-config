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
 * 附加能力（只读）：
 * - Token 用量：汇总 `~/.claude/projects/**\/*.jsonl` 中 assistant 消息的 usage 字段
 * - 变更日志：记录本插件每次保存/恢复操作（令牌已脱敏）
 *
 * 实现约束：不引入 UI 框架，全部使用原生 DOM + 行内样式；
 * 配色跟随 `api.context.theme`（CloudCLI 官方提供的 dark / light）。
 */

import type {
  ChangeLogEntry,
  ConfigResponse,
  ErrorResponse,
  HistoryItem,
  PluginAPI,
  PluginContext,
  RestoreResponse,
  SaveConfigResponse,
  UsageReport,
} from './types.js';

/* ------------------------------------------------------------------ */
/* 主题                                                                */
/* ------------------------------------------------------------------ */

type Theme = 'dark' | 'light';

interface Palette {
  fg: string;
  muted: string;
  border: string;
  inputBg: string;
  panelBg: string;
  accent: string;
  accentFg: string;
  successBg: string;
  successBorder: string;
  successFg: string;
  errorBg: string;
  errorBorder: string;
  errorFg: string;
}

const PALETTES: Record<Theme, Palette> = {
  dark: {
    fg: '#e4e4e7',
    muted: '#a1a1aa',
    border: '#3f3f46',
    inputBg: 'rgba(255, 255, 255, 0.06)',
    panelBg: 'rgba(255, 255, 255, 0.03)',
    accent: '#3b82f6',
    accentFg: '#ffffff',
    successBg: 'rgba(22, 163, 74, 0.18)',
    successBorder: 'rgba(34, 197, 94, 0.55)',
    successFg: '#4ade80',
    errorBg: 'rgba(220, 38, 38, 0.18)',
    errorBorder: 'rgba(248, 113, 113, 0.55)',
    errorFg: '#f87171',
  },
  light: {
    fg: '#1f2328',
    muted: '#656d76',
    border: '#d0d7de',
    inputBg: '#ffffff',
    panelBg: '#f6f8fa',
    accent: '#0969da',
    accentFg: '#ffffff',
    successBg: '#dafbe1',
    successBorder: '#4ac26b',
    successFg: '#1a7f37',
    errorBg: '#ffebe9',
    errorBorder: '#ff8182',
    errorFg: '#cf222e',
  },
};

const FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif';

const MONO =
  'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

const NOTICE =
  '本插件仅编辑 ~/.claude/settings.json 中的 ANTHROPIC_BASE_URL 与 ANTHROPIC_AUTH_TOKEN：不拦截、不代理任何 API 请求，也不控制 Claude Code 进程。修改后需新建 Claude Code 会话生效。';

/* ------------------------------------------------------------------ */
/* 工具                                                                */
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
  if (err instanceof Error && err.message !== '') return err.message;
  if (typeof err === 'object' && err !== null && 'error' in err) {
    const message = (err as ErrorResponse).error;
    if (typeof message === 'string' && message !== '') return message;
  }
  if (typeof err === 'string' && err !== '') return err;
  return '未知错误';
}

/** token 数量的紧凑显示 */
function fmtNum(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e4) return `${(value / 1e3).toFixed(1)}k`;
  return value.toLocaleString('zh-CN');
}

function fmtTime(iso: string): string {
  if (iso === '') return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('zh-CN', { hour12: false });
}

type Range = 'all' | '30d' | '7d';

const RANGE_LABELS: Record<Range, string> = { all: '全部', '30d': '30 天', '7d': '7 天' };

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
  // 宿主每次切到该 tab 都会调用 mount，先清掉上一次的 DOM 与监听
  unmount();

  let theme: Theme = api.context.theme === 'light' ? 'light' : 'dark';
  let palette: Palette = PALETTES[theme];

  /* ---------- 结构 ---------- */
  const root = el('div', {
    fontFamily: FONT,
    fontSize: '13px',
    lineHeight: '1.6',
    padding: '20px',
    boxSizing: 'border-box',
    maxWidth: '900px',
    textAlign: 'left',
  });

  const title = el('h2', { margin: '0 0 6px', fontSize: '17px', fontWeight: '600' }, 'Claude API 配置');
  const subtitle = el('p', { margin: '0 0 16px', fontSize: '12px', lineHeight: '1.6' }, NOTICE);

  const status = el('div', {
    display: 'none',
    margin: '0 0 14px',
    padding: '8px 12px',
    borderRadius: '6px',
    borderWidth: '1px',
    borderStyle: 'solid',
    fontSize: '12px',
    lineHeight: '1.5',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  });

  const inputBase: Partial<CSSStyleDeclaration> = {
    display: 'block',
    width: '100%',
    boxSizing: 'border-box',
    padding: '8px 10px',
    fontSize: '13px',
    fontFamily: MONO,
    borderRadius: '6px',
    borderWidth: '1px',
    borderStyle: 'solid',
    outline: 'none',
  };

  const baseUrlInput = el('input', inputBase);
  baseUrlInput.type = 'text';
  baseUrlInput.placeholder = 'https://api.deepseek.com/anthropic';
  baseUrlInput.spellcheck = false;
  baseUrlInput.autocomplete = 'off';

  const authTokenInput = el('input', inputBase);
  authTokenInput.type = 'password';
  authTokenInput.placeholder = 'sk-...';
  authTokenInput.spellcheck = false;
  authTokenInput.autocomplete = 'off';

  const labelBase: Partial<CSSStyleDeclaration> = {
    display: 'block',
    marginBottom: '6px',
    fontSize: '12px',
    fontFamily: MONO,
  };
  const baseUrlLabel = el('label', labelBase, 'ANTHROPIC_BASE_URL');
  const authTokenLabel = el('label', labelBase, 'ANTHROPIC_AUTH_TOKEN');

  const baseUrlField = el('div', { marginBottom: '14px' });
  baseUrlField.append(baseUrlLabel, baseUrlInput);
  const authTokenField = el('div', { marginBottom: '14px' });
  authTokenField.append(authTokenLabel, authTokenInput);

  const saveButton = el(
    'button',
    {
      padding: '8px 18px',
      fontSize: '13px',
      fontWeight: '500',
      borderWidth: '1px',
      borderStyle: 'solid',
      borderColor: 'transparent',
      borderRadius: '6px',
      cursor: 'pointer',
      transition: 'opacity 120ms ease',
    },
    '保存',
  );
  saveButton.type = 'button';

  const divider1 = el('hr', { margin: '20px 0 16px', border: 'none', borderTopWidth: '1px', borderTopStyle: 'solid' });
  const historyTitle = el('h3', { margin: '0 0 10px', fontSize: '14px', fontWeight: '600' }, '历史记录');
  const historyList = el('div', { borderWidth: '1px', borderStyle: 'solid', borderRadius: '8px', overflow: 'hidden' });

  const divider2 = el('hr', { margin: '20px 0 16px', border: 'none', borderTopWidth: '1px', borderTopStyle: 'solid' });
  const usageHeader = el('div', {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
    margin: '0 0 10px',
    flexWrap: 'wrap',
  });
  const usageTitle = el('h3', { margin: '0', fontSize: '14px', fontWeight: '600' }, 'Token 用量');
  const rangeGroup = el('div', { display: 'flex', gap: '6px' });
  const usageHint = el(
    'div',
    { margin: '0 0 10px', fontSize: '11px', fontFamily: MONO },
    '数据来源：~/.claude/projects/**/*.jsonl 中 assistant 消息的 usage（按 message.id 去重）',
  );
  const usageBody = el('div', {});

  const divider3 = el('hr', { margin: '20px 0 16px', border: 'none', borderTopWidth: '1px', borderTopStyle: 'solid' });
  const changeLogTitle = el('h3', { margin: '0 0 10px', fontSize: '14px', fontWeight: '600' }, '变更日志');
  const changeLogBody = el('div', {});

  usageHeader.append(usageTitle, rangeGroup);

  root.append(
    title,
    subtitle,
    status,
    baseUrlField,
    authTokenField,
    saveButton,
    divider1,
    historyTitle,
    historyList,
    divider2,
    usageHeader,
    usageHint,
    usageBody,
    divider3,
    changeLogTitle,
    changeLogBody,
  );
  container.appendChild(root);

  /* ---------- 状态提示 ---------- */
  let statusKind: 'success' | 'error' | null = null;
  let statusText = '';

  function paintStatus(): void {
    if (statusKind === null) {
      status.style.display = 'none';
      status.textContent = '';
      return;
    }
    status.textContent = statusText;
    status.style.display = 'block';
    if (statusKind === 'success') {
      status.style.background = palette.successBg;
      status.style.borderColor = palette.successBorder;
      status.style.color = palette.successFg;
    } else {
      status.style.background = palette.errorBg;
      status.style.borderColor = palette.errorBorder;
      status.style.color = palette.errorFg;
    }
  }

  function showStatus(kind: 'success' | 'error', message: string): void {
    statusKind = kind;
    statusText = message;
    paintStatus();
  }

  function hideStatus(): void {
    statusKind = null;
    statusText = '';
    paintStatus();
  }

  /* ---------- 通用小部件 ---------- */
  function panel(): HTMLDivElement {
    return el('div', {
      borderWidth: '1px',
      borderStyle: 'solid',
      borderColor: palette.border,
      borderRadius: '8px',
      background: palette.panelBg,
      overflow: 'hidden',
    });
  }

  function hintText(text: string): HTMLDivElement {
    return el('div', { padding: '14px', fontSize: '12px', color: palette.muted }, text);
  }

  function buildTable(headers: string[], rows: string[][], numericFrom: number): HTMLTableElement {
    const table = el('table', {
      width: '100%',
      borderCollapse: 'collapse',
      fontSize: '12px',
      fontFamily: MONO,
    });

    const thead = el('thead', {});
    const headRow = el('tr', {});
    headers.forEach((header, index) => {
      const th = el(
        'th',
        {
          padding: '6px 10px',
          fontSize: '11px',
          fontWeight: '500',
          color: palette.muted,
          textAlign: index >= numericFrom ? 'right' : 'left',
          whiteSpace: 'nowrap',
          borderBottomWidth: '1px',
          borderBottomStyle: 'solid',
          borderBottomColor: palette.border,
        },
        header,
      );
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = el('tbody', {});
    rows.forEach((cells, rowIndex) => {
      const tr = el('tr', {});
      cells.forEach((cell, index) => {
        const td = el(
          'td',
          {
            padding: '5px 10px',
            color: index === 0 ? palette.fg : palette.muted,
            textAlign: index >= numericFrom ? 'right' : 'left',
            whiteSpace: 'nowrap',
            borderTopWidth: rowIndex === 0 ? '0' : '1px',
            borderTopStyle: 'solid',
            borderTopColor: palette.border,
          },
          cell,
        );
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
  }

  function statCard(label: string, value: string): HTMLDivElement {
    const card = el('div', {
      flex: '1 1 92px',
      minWidth: '92px',
      boxSizing: 'border-box',
      padding: '8px 10px',
      borderWidth: '1px',
      borderStyle: 'solid',
      borderColor: palette.border,
      borderRadius: '6px',
      background: palette.panelBg,
    });
    card.append(
      el('div', { fontSize: '11px', color: palette.muted }, label),
      el('div', { fontSize: '15px', fontWeight: '600', fontFamily: MONO, color: palette.fg }, value),
    );
    return card;
  }

  /* ---------- 历史列表 ---------- */
  let historyItems: HistoryItem[] = [];

  function renderHistory(items: HistoryItem[]): void {
    historyItems = items;
    historyList.replaceChildren();
    historyList.style.borderColor = palette.border;
    historyList.style.background = palette.panelBg;

    if (items.length === 0) {
      historyList.appendChild(hintText('暂无历史记录'));
      return;
    }

    items.forEach((item, index) => {
      const row = el('div', {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px',
        padding: '9px 12px',
        borderTopWidth: index === 0 ? '0' : '1px',
        borderTopStyle: 'solid',
        borderTopColor: palette.border,
      });

      const info = el('div', { minWidth: '0', flex: '1 1 auto' });
      const time = el('div', { fontSize: '12px', color: palette.fg, whiteSpace: 'nowrap' }, item.timestamp);
      const url = el(
        'div',
        {
          fontSize: '11px',
          fontFamily: MONO,
          color: palette.muted,
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
          color: palette.fg,
          background: 'transparent',
          borderWidth: '1px',
          borderStyle: 'solid',
          borderColor: palette.border,
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

  /* ---------- Token 用量 ---------- */
  let range: Range = 'all';
  let usageReport: UsageReport | null = null;
  let usageLoading = false;
  let usageError: string | null = null;

  function renderRangeButtons(): void {
    rangeGroup.replaceChildren();
    (['all', '30d', '7d'] as Range[]).forEach((value) => {
      const active = value === range;
      const button = el(
        'button',
        {
          padding: '4px 10px',
          fontSize: '12px',
          borderRadius: '6px',
          cursor: 'pointer',
          borderWidth: '1px',
          borderStyle: 'solid',
          borderColor: active ? palette.accent : palette.border,
          background: active ? palette.accent : 'transparent',
          color: active ? palette.accentFg : palette.fg,
        },
        RANGE_LABELS[value],
      );
      button.type = 'button';
      button.disabled = usageLoading;
      button.addEventListener('click', () => {
        if (range === value) return;
        range = value;
        renderRangeButtons();
        void loadUsage();
      });
      rangeGroup.appendChild(button);
    });
  }

  function renderUsage(): void {
    usageBody.replaceChildren();
    usageBody.style.borderColor = palette.border;

    if (usageLoading) {
      usageBody.appendChild(hintText('统计中…'));
      return;
    }
    if (usageError !== null) {
      usageBody.appendChild(el('div', { padding: '14px', fontSize: '12px', color: palette.errorFg }, usageError));
      return;
    }
    if (usageReport === null) {
      usageBody.appendChild(hintText('暂无数据'));
      return;
    }

    const { totals, byDay, byModel, sessions, messages, files, scannedAt } = usageReport;
    if (totals.total === 0 && byDay.length === 0) {
      usageBody.appendChild(
        hintText(`未找到 token 用量记录（已扫描 ${files} 个会话文件）。可能本机还没有 Claude Code 会话日志。`),
      );
      return;
    }

    const cards = el('div', { display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '10px' });
    cards.append(
      statCard('总 Tokens', fmtNum(totals.total)),
      statCard('输入', fmtNum(totals.input)),
      statCard('输出', fmtNum(totals.output)),
      statCard('缓存读取', fmtNum(totals.cacheRead)),
      statCard('缓存写入', fmtNum(totals.cacheCreate)),
      statCard('消息数', fmtNum(messages)),
      statCard('会话数', fmtNum(sessions)),
    );
    usageBody.appendChild(cards);

    // 按天（最多 14 行）
    const dayPanel = panel();
    dayPanel.appendChild(
      el('div', { padding: '8px 10px', fontSize: '12px', color: palette.fg, fontWeight: '600' }, '按天'),
    );
    dayPanel.appendChild(
      buildTable(
        ['日期', '输入', '输出', '缓存读', '缓存写', '合计'],
        byDay.slice(0, 14).map((day) => [
          day.date,
          fmtNum(day.input),
          fmtNum(day.output),
          fmtNum(day.cacheRead),
          fmtNum(day.cacheCreate),
          fmtNum(day.total),
        ]),
        1,
      ),
    );
    usageBody.appendChild(dayPanel);

    // 按模型
    const modelPanel = panel();
    modelPanel.style.marginTop = '10px';
    modelPanel.appendChild(
      el('div', { padding: '8px 10px', fontSize: '12px', color: palette.fg, fontWeight: '600' }, '按模型'),
    );
    modelPanel.appendChild(
      buildTable(
        ['模型', '输入', '输出', '缓存读', '缓存写', '合计'],
        byModel.slice(0, 10).map((item) => [
          item.model,
          fmtNum(item.input),
          fmtNum(item.output),
          fmtNum(item.cacheRead),
          fmtNum(item.cacheCreate),
          fmtNum(item.total),
        ]),
        1,
      ),
    );
    usageBody.appendChild(modelPanel);

    usageBody.appendChild(
      el(
        'div',
        { marginTop: '8px', fontSize: '11px', color: palette.muted },
        `扫描 ${files} 个会话文件 · 统计于 ${fmtTime(scannedAt)} · 同一条消息的多行记录已按 message.id 去重`,
      ),
    );
  }

  async function loadUsage(): Promise<void> {
    usageLoading = true;
    usageError = null;
    renderUsage();
    renderRangeButtons();
    try {
      const report = await api.rpc<UsageReport>('GET', `/api/usage?range=${range}`);
      usageReport = report;
    } catch (err) {
      usageError = `加载用量失败：${errMessage(err)}`;
    } finally {
      usageLoading = false;
      renderUsage();
      renderRangeButtons();
    }
  }

  /* ---------- 变更日志 ---------- */
  let changeLog: ChangeLogEntry[] | null = null;
  let changeLogError: string | null = null;

  function renderChangeLog(): void {
    changeLogBody.replaceChildren();
    changeLogBody.style.borderColor = palette.border;

    if (changeLogError !== null) {
      changeLogBody.appendChild(el('div', { padding: '14px', fontSize: '12px', color: palette.errorFg }, changeLogError));
      return;
    }
    if (changeLog === null) {
      changeLogBody.appendChild(hintText('暂无变更记录'));
      return;
    }
    if (changeLog.length === 0) {
      changeLogBody.appendChild(hintText('暂无变更记录'));
      return;
    }

    const wrapper = panel();
    wrapper.appendChild(
      buildTable(
        ['时间', '操作', 'BASE_URL', 'TOKEN'],
        changeLog.map((entry) => [
          fmtTime(entry.at),
          entry.action === 'save' ? '保存' : '恢复',
          `${entry.baseUrl.from || '(空)'} → ${entry.baseUrl.to || '(空)'}`,
          `${entry.authToken.from || '(空)'} → ${entry.authToken.to || '(空)'}`,
        ]),
        4,
      ),
    );
    changeLogBody.appendChild(wrapper);
    changeLogBody.appendChild(
      el('div', { marginTop: '8px', fontSize: '11px', color: palette.muted }, '令牌仅保留首 3 位与末 4 位，完整值不会写入日志。'),
    );
  }

  async function loadChangeLog(): Promise<void> {
    try {
      const entries = await api.rpc<ChangeLogEntry[]>('GET', '/api/changelog?limit=50');
      changeLog = Array.isArray(entries) ? entries : [];
      changeLogError = null;
    } catch (err) {
      changeLog = null;
      changeLogError = `加载变更日志失败：${errMessage(err)}`;
    }
    renderChangeLog();
  }

  /* ---------- 主题应用 ---------- */
  function applyTheme(): void {
    root.style.color = palette.fg;
    title.style.color = palette.fg;
    subtitle.style.color = palette.muted;

    baseUrlLabel.style.color = palette.muted;
    authTokenLabel.style.color = palette.muted;

    for (const input of [baseUrlInput, authTokenInput]) {
      input.style.color = palette.fg;
      input.style.background = palette.inputBg;
      input.style.borderColor = palette.border;
      input.style.caretColor = palette.fg;
    }

    saveButton.style.background = palette.accent;
    saveButton.style.color = palette.accentFg;

    divider1.style.borderTopColor = palette.border;
    divider2.style.borderTopColor = palette.border;
    divider3.style.borderTopColor = palette.border;

    historyTitle.style.color = palette.fg;
    usageTitle.style.color = palette.fg;
    usageHint.style.color = palette.muted;
    changeLogTitle.style.color = palette.fg;

    paintStatus();
    renderHistory(historyItems);
    renderRangeButtons();
    renderUsage();
    renderChangeLog();
  }

  applyTheme();

  /* ---------- 数据加载 ---------- */
  async function loadConfig(): Promise<void> {
    const result = await api.rpc<ConfigResponse>('GET', '/api/config');
    baseUrlInput.value = typeof result.baseUrl === 'string' ? result.baseUrl : '';
    authTokenInput.value = typeof result.authToken === 'string' ? result.authToken : '';
  }

  async function loadHistory(): Promise<void> {
    const items = await api.rpc<HistoryItem[]>('GET', '/api/history');
    renderHistory(Array.isArray(items) ? items : []);
  }

  async function reloadAll(): Promise<void> {
    await Promise.all([loadConfig(), loadHistory(), loadUsage(), loadChangeLog()]);
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
        await Promise.all([loadConfig(), loadHistory(), loadChangeLog()]);
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
        await Promise.all([loadConfig(), loadHistory(), loadChangeLog()]);
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
  const onEnter = (event: KeyboardEvent): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void onSave();
    }
  };
  const onInput = (): void => hideStatus();

  saveButton.addEventListener('click', onSaveClick);
  baseUrlInput.addEventListener('keydown', onEnter);
  authTokenInput.addEventListener('keydown', onEnter);
  baseUrlInput.addEventListener('input', onInput);
  authTokenInput.addEventListener('input', onInput);

  /* ---------- 上下文订阅（主题切换时重新着色） ---------- */
  const unsubscribe = api.onContextChange((context: PluginContext) => {
    const next: Theme = context.theme === 'light' ? 'light' : 'dark';
    if (next === theme) return;
    theme = next;
    palette = PALETTES[theme];
    applyTheme();
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
      baseUrlInput.removeEventListener('input', onInput);
      authTokenInput.removeEventListener('input', onInput);
      root.remove();
    },
  };
}

/**
 * 宿主在 tab 关闭 / 插件禁用 / 组件卸载时调用，并传入同一个 container。
 * 参数可省略，便于本地调试。
 */
export function unmount(_container?: HTMLElement): void {
  if (mounted === null) return;
  mounted.destroy();
  mounted = null;
}
