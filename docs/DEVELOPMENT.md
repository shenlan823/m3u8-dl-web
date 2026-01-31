# M3U8 Web 下载器 - 开发文档

本文档面向参与项目开发的开发者，说明项目架构、目录结构、扩展方式与调试建议。

---

## 1. 架构概览

### 1.1 整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        浏览器 (Vue 3)                              │
│  - 输入 M3U8 URL、添加任务                                          │
│  - 任务列表、详情面板（分片网格、进度、日志）                           │
│  - 重试分片、强制合并、重启任务、删除任务                              │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTP API + SSE
┌──────────────────────────▼──────────────────────────────────────┐
│                    Express (server.js)                            │
│  - REST API: /api/add, /api/job/:id, /api/retry-segment, ...     │
│  - SSE: /api/events                                               │
│  - 静态资源: public/                                               │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│                  QueueManager (src/QueueManager.js)               │
│  - 队列 queue、当前任务 activeTask、历史 history                   │
│  - 持久化 data.json、加载/保存状态                                  │
│  - 添加/删除/重启任务、processQueue 调度                            │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│                   M3U8Task (src/M3U8Task.js)                      │
│  - 解析 M3U8、下载分片、AES-128 解密、合并 MP4                      │
│  - 通过 logCallback 上报日志与分片状态                              │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 数据流

- **添加任务**：`POST /api/add` → `QueueManager.addTask()` → 写入 `data.json`，广播 `queue-update`，若空闲则 `processQueue()` 创建 `M3U8Task` 并 `start()`。
- **实时更新**：前端连接 `GET /api/events`（SSE）；后端在队列变化、任务开始、任务日志时通过 `sseBroadcast` 推送 `queue-update`、`job-start`、`log` 等事件。
- **任务执行**：`M3U8Task.start()` → 拉取 M3U8 → 解析分片 → 下载密钥（若有加密）→ 分批下载分片 → 全部成功则合并，否则进入 `waiting_retry`；完成后 `QueueManager.finishTask()` 将任务移入 history 并处理下一任务。

---

## 2. 目录与文件说明

### 2.1 根目录

| 文件/目录 | 说明 |
|-----------|------|
| `server.js` | Express 入口：注册 API、SSE、静态目录，初始化 `QueueManager`，监听端口 3000 |
| `public/` | 前端静态资源，仅 `index.html`（内嵌 Vue 3 + Tailwind） |
| `src/` | 核心业务：`M3U8Task.js`、`QueueManager.js` |
| `downloads/` | 各任务输出目录，按任务 ID 建子目录，内含分片与 `output.mp4` |
| `data.json` | 由程序生成：队列、当前任务快照、历史任务快照，用于重启恢复 |
| `package.json` | 依赖：express、uuid；脚本：`npm start` → nodemon |
| `nodemon.json` | nodemon 配置：忽略 `.git`、`node_modules`、`data.json`、`downloads/**`，监听 js/json/html |

### 2.2 src/

| 文件 | 职责 |
|------|------|
| **M3U8Task.js** | 单任务生命周期：构造/fromJSON、解析 M3U8、下载密钥、分片下载（含重试与解密）、合并、清理；通过 `logCallback` 上报日志与分片状态 |
| **QueueManager.js** | 队列与持久化：`queue`、`activeTask`、`history`；`addTask`、`deleteTask`、`restartTask`、`processQueue`、`finishTask`；`saveState`/`loadState` 读写 `data.json`，`broadcastStatus` 推送队列状态 |

### 2.3 docs/

| 文件 | 说明 |
|------|------|
| `DEVELOPMENT.md` | 开发文档（本文件） |
| `TECHNICAL.md` | 技术文档：API、SSE 协议、M3U8 解析与加密 |
| `USER_MANUAL.md` | 使用手册：操作步骤与常见问题 |

---

## 3. 核心模块说明

### 3.1 M3U8Task

- **构造函数**：`new M3U8Task(url, options, logCallback)`，`options.id` 必填，用于输出目录与日志关联；可选 `outputDir`、`concurrentDownloads`、`timeout`、`retryCount`、`headers`。
- **静态方法**：`M3U8Task.fromJSON(data, logCallback)` 用于从 `data.json` 恢复任务实例（含 segments、encryption、status）；若 status 为 `downloading`/`parsing` 会置为 `waiting_retry`。
- **状态**：`pending` → `parsing` → `downloading` → `merging` / `waiting_retry` / `error` → `completed`。
- **分片状态**：`pending`、`retry`、`downloading`、`success`、`failed`。
- **日志类型**：`info`、`error`、`init-segments`、`segment-update`、`progress`、`done`。

### 3.2 QueueManager

- **构造**：`new QueueManager(sseBroadcast)`，`sseBroadcast(data)` 用于向所有 SSE 客户端推送 JSON；构造时调用 `loadState()` 从 `data.json` 恢复 queue/history，若有 activeTask 会恢复为历史并标记 `waiting_retry`。
- **持久化**：`_serializeTask(task)` 提取 id、url、options、segments、encryption、status；`saveState()` 在队列变化、任务开始/结束、重启/删除后写入 `data.json`。
- **调度**：`processQueue()` 在无 `activeTask` 且 queue 非空时取队首，创建 `M3U8Task` 并 `start()`，完成后 `finishTask()` 将任务移入 history（最多 50 条）并延迟 1 秒再调 `processQueue()`。

---

## 4. 扩展与二次开发

### 4.1 增加并发数

在 `M3U8Task` 构造 options 中传入 `concurrentDownloads`（默认 5），或在 `QueueManager` 创建任务时传入：

```js
this.activeTask = new M3U8Task(nextTaskInfo.url, {
  id: nextTaskInfo.id,
  concurrentDownloads: 10,
}, ...);
```

### 4.2 自定义请求头 / 代理

- 在 `M3U8Task` 的 `options.headers` 中增加或覆盖 Header。
- 若需 HTTP 代理，需在 `fetch()` 内使用支持 proxy 的库（如 `https-proxy-agent`）替换当前 `http.get`/`https.get`。

### 4.3 支持 SAMPLE-AES 或其他加密

- 当前仅实现 AES-128-CBC（`#EXT-X-KEY` METHOD=AES-128）。
- 若需 SAMPLE-AES 或其它方式，需在 `parseM3U8` 中解析对应 tag，在 `downloadSegmentWithRetry` 中按不同 METHOD 分支解密逻辑。

### 4.4 多任务并行

- 当前设计为单任务串行（一个 `activeTask`）。
- 若要并行：可将 `activeTask` 改为数组或 Map，在 `processQueue` 中根据“最大并行数”创建多个 `M3U8Task`，并在各自 `start()` 完成时从“当前运行集”移除并调用 `finishTask` 逻辑，再 `processQueue()` 补充新任务。

### 4.5 前端改造

- 前端为单文件 `public/index.html`，Vue 3 与 Tailwind 均通过 CDN 引入。
- 若改为 Vue CLI / Vite 工程：将现有 `data`、`computed`、`methods` 迁移到 SFC 或组合式 API，并保留对 `/api/*` 与 `/api/events` 的调用方式即可，后端无需改动。

---

## 5. 调试与排错

### 5.1 日志

- 服务端：`console.log`/`console.error` 在终端输出；`QueueManager` 在重启任务时会打印 `[Restart] 已清空目录`，删除任务时会打印 `已物理删除目录`。
- 前端：任务详情下方有日志区域，仅显示当前查看任务的日志；SSE 消息中 `event: 'log'` 且 `payload.jobId` 与当前查看任务一致时才会展示。

### 5.2 常见问题

- **任务一直“等待解析”**：检查 M3U8 URL 是否可访问（浏览器或 curl），是否被目标站限流或需 Cookie/Referer。
- **分片大量失败**：检查目标是否对 IP/User-Agent/Referer 做限制；可适当增大 `timeout`、`retryCount`。
- **合并后无法播放**：部分站点 TS 并非标准 AVC+AAC，合并为 MP4 可能需 ffmpeg 重封装；当前为直接 TS 顺序拼接，若需可后续接 ffmpeg。
- **data.json 损坏**：若 JSON 解析失败，`loadState` 会 catch 并只打日志，此时 queue/history 为空，可手动修复或删除 `data.json` 重新开始。

### 5.3 开发时注意

- nodemon 会忽略 `data.json` 和 `downloads/**`，修改代码重启不会清空队列与下载；若需干净环境可手动删除 `data.json` 和 `downloads` 下子目录。
- 修改 `QueueManager` 的序列化字段时，需同步考虑 `M3U8Task.fromJSON` 与 `_serializeTask`，避免旧数据无法恢复。

---

## 6. 测试建议

- **接口**：可用 Postman 或 curl 测试 `POST /api/add`、`GET /api/job/:id`、`POST /api/retry-segment`、`POST /api/restart`、`POST /api/force-merge`、`DELETE /api/job/:id`。
- **SSE**：浏览器控制台或脚本连接 `EventSource('/api/events')`，观察 `queue-update`、`job-start`、`log` 等消息。
- **持久化**：添加任务后结束进程，重启后检查队列与历史是否从 `data.json` 恢复；再触发一次下载，确认状态是否继续正确保存。

---

以上为开发文档核心内容，API 与协议细节见 [TECHNICAL.md](TECHNICAL.md)，用户操作见 [USER_MANUAL.md](USER_MANUAL.md)。
