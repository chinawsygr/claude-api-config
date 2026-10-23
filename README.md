# claude-api-config

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)

CloudCLI 插件：可视化管理 `~/.claude/settings.json` 中的 `ANTHROPIC_BASE_URL` 与 `ANTHROPIC_AUTH_TOKEN`，支持历史版本记录与一键恢复，并附带 **Token 用量统计** 与 **配置变更日志**。

## 功能

| 区块 | 说明 |
| --- | --- |
| 配置编辑 | 读写 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`，保留 settings.json 其他所有字段 |
| 历史记录 | 每次保存/恢复前自动备份，最多 20 份，一键回滚 |
| Token 用量 | 汇总 `~/.claude/projects/**/*.jsonl` 的 usage，按天/按模型统计，支持 全部 / 30 天 / 7 天 |
| 变更日志 | 记录每次保存与恢复的前后值（令牌脱敏为 `sk-****abcd`），最多 500 条 |

## 定位（重要）

这是一个**配置文件编辑器**，不是运行时 API 路由。

- 只负责读写 `~/.claude/settings.json`
- 不拦截、不代理任何 API 请求
- 不控制 Claude Code 进程生命周期
- 保存或恢复后，**已运行的 Claude Code 会话不会热切换**，需新建会话或重启 Claude Code 进程才生效

## 安装

**方式一：从 Git 安装（推荐）**

CloudCLI → **Settings → Plugins** → 粘贴仓库地址 → **Install**

```
https://github.com/chinawsygr/claude-api-config
```

宿主会自动 `git clone` → 校验 manifest → `npm install --ignore-scripts` → `npm run build` → 启动后端，然后在 tab 栏出现「Claude API 配置」。仓库无需提交 `dist/`，编译产物在安装时生成。

**方式二：手动安装**

```bash
git clone https://github.com/chinawsygr/claude-api-config.git ~/.claude-code-ui/plugins/claude-api-config
cd ~/.claude-code-ui/plugins/claude-api-config
npm install && npm run build
```

随后在 **Settings → Plugins** 中启用插件并打开其 tab。

> 仓库若为私有，宿主无法匿名 clone，请改为公开，或走方式二。

## 目录结构

```
claude-api-config/
├── manifest.json      # 插件清单：type/module、slot: tab、entry、server
├── package.json
├── tsconfig.json      # ES2022 / NodeNext / strict
└── src/
    ├── types.ts       # PluginContext / PluginAPI / 各接口返回类型
    ├── index.ts       # 前端入口，导出 mount / unmount
    └── server.ts      # 后端 Node.js 服务（仅内置模块）
```

## 开发

```bash
npm install
npm run build      # tsc -> dist/
npm run watch      # 监听编译
```

构建产物 `dist/index.js`（前端）与 `dist/server.js`（后端）由 `manifest.json` 引用。

## 运行方式

- 前端：宿主调用 `mount(container, api)` 挂载（每次切到该 tab 都会重新调用），关闭时调用 `unmount(container)`；通过 `api.rpc(method, path, body?)` 访问后端
- 后端：宿主以 `node dist/server.js` 拉起，监听 `127.0.0.1` 随机端口，启动后向 stdout 输出单行 `{"ready":true,"port":<端口>}`（10 秒内未输出会被杀掉）
- 宿主只向插件进程透传 `PATH` / `HOME` / `NODE_ENV` / `PLUGIN_NAME`，因此主目录按 `HOME → USERPROFILE → os.homedir()` 回退解析

## 存储路径

| 用途 | 路径 |
| --- | --- |
| 目标配置 | `~/.claude/settings.json` |
| 插件数据 | `~/.claude-code-ui/plugins/claude-api-config/data` |
| 历史备份 | 上述 `data/history/settings-{ISO时间戳}.json`（最多 20 份，超出删最旧） |
| 变更日志 | 上述 `data/changelog.jsonl`（最多 500 条） |
| 用量来源 | `~/.claude/projects/**/*.jsonl`（只读） |

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/config` | 返回 `{ baseUrl, authToken, exists }` |
| POST | `/api/config` | 入参 `{ baseUrl, authToken }`，校验后备份并写回，保留其他所有字段 |
| GET | `/api/history` | 返回 `[{ filename, timestamp, baseUrl }]`，按文件名倒序 |
| POST | `/api/restore` | 入参 `{ filename }`，先备份当前配置，再把历史内容原样写回 |
| GET | `/api/usage?range=all\|30d\|7d` | 返回 token 用量聚合：`totals` / `byDay` / `byModel` / `sessions` / `messages` / `files` |
| GET | `/api/changelog?limit=50` | 返回变更日志，最新在前（最多 500 条） |

宿主把 `api.rpc('GET', '/api/config')` 原样转发到插件服务器，因此上述路径可直接使用；同时兼容不带 `/api` 前缀的 `/config`、`/history`、`/restore`、`/usage`、`/changelog`。

### Token 用量统计口径

- 数据来源：`~/.claude/projects/<project>/<session>.jsonl` 中 `type === "assistant"` 记录的 `message.usage`
- 同一条助手消息在日志里可能被拆成多行、每行重复完整 usage，因此**按 `message.id` 去重**
- 四类计数：`input_tokens`、`output_tokens`、`cache_creation_input_tokens`、`cache_read_input_tokens`；合计为四者之和
- `<synthetic>` 等零用量记录被忽略
- 结果在内存缓存 30 秒；`7d` / `30d` 会先用文件 mtime 做快速过滤

### 变更日志脱敏

只保留令牌首 3 位与末 4 位（`sk-****abcd`），完整令牌永不写入日志；日志落在 `data/changelog.jsonl`。

## 边界处理

| 情况 | 行为 |
| --- | --- |
| `settings.json` 不存在 | `GET /api/config` 返回空值与 `exists: false`；保存时自动创建目录与文件；跳过备份 |
| `settings.json` JSON 异常 | `GET /api/config` 返回 500「settings.json 格式异常，无法解析」；保存/恢复拒绝执行，不覆盖损坏文件 |
| `baseUrl` / `authToken` 为空或 URL 非法 | 400 + 具体错误信息 |
| 历史目录不存在 | `GET /api/history` 返回 `[]` |
| 恢复时文件不存在 | 404 |
| 恢复文件名含路径穿越 | 400 |

## 技术约束

- TypeScript 严格模式，前端不引入 UI 框架（原生 DOM + 行内样式）
- 配色跟随 `api.context.theme`，在 `dark` / `light` 两套调色板间实时切换
- 后端只使用 Node.js 内置模块：`http`、`fs/promises`、`path`、`os`，无运行时依赖
- 代码中不含任何硬编码 API Key 或令牌

## License

[Apache-2.0](./LICENSE)
