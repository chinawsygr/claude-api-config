# claude-api-config

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)

CloudCLI 插件：可视化管理 `~/.claude/settings.json` 中的 `ANTHROPIC_BASE_URL` 与 `ANTHROPIC_AUTH_TOKEN`，支持历史版本记录与一键恢复。

## 定位（重要）

这是一个**配置文件编辑器**，不是运行时 API 路由。

- 只负责读写 `~/.claude/settings.json`
- 不拦截、不代理任何 API 请求
- 不控制 Claude Code 进程生命周期
- 保存或恢复后，**已运行的 Claude Code 会话不会热切换**，需新建会话或重启 Claude Code 进程才生效

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

- 前端：宿主调用 `mount(container, api)` 挂载，通过 `api.rpc(method, path, body?)` 访问后端
- 后端：监听 `127.0.0.1` 随机端口，启动后向 stdout 输出 `{"ready":true,"port":<端口>}`

## 存储路径

| 用途 | 路径 |
| --- | --- |
| 目标配置 | `~/.claude/settings.json` |
| 插件数据 | `~/.claude-code-ui/plugins/claude-api-config/data` |
| 历史备份 | 上述 `data/history/settings-{ISO时间戳}.json`（最多 20 份，超出删最旧） |

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/config` | 返回 `{ baseUrl, authToken, exists }` |
| POST | `/api/config` | 入参 `{ baseUrl, authToken }`，校验后备份并写回，保留其他所有字段 |
| GET | `/api/history` | 返回 `[{ filename, timestamp, baseUrl }]`，按文件名倒序 |
| POST | `/api/restore` | 入参 `{ filename }`，先备份当前配置，再把历史内容原样写回 |

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

- TypeScript 严格模式，前端不引入 UI 框架（原生 DOM + 行内样式，优先取宿主 CSS 变量以适配深色主题）
- 后端只使用 Node.js 内置模块：`http`、`fs/promises`、`path`、`os`
- 代码中不含任何硬编码 API Key 或令牌

## License

[Apache-2.0](./LICENSE)
