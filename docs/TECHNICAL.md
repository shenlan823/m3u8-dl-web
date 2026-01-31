# M3U8 Web 下载器 - 技术文档

本文档描述后端 API、SSE 协议、M3U8 解析与加密实现，供集成与二次开发参考。

---

## 1. HTTP API

基础 URL：`http://localhost:3000`（或实际部署域名）。除 `GET /api/events` 为 SSE 流外，其余为 JSON 请求/响应。

### 1.1 添加任务

```http
POST /api/add
Content-Type: application/json

{"url": "https://example.com/playlist.m3u8"}
```

- **成功**：`200`，`{"success": true, "id": "<任务ID>"}`。任务 ID 为服务端生成的字符串（当前实现为时间戳）。
- **失败**：`400`，`"URL is required"`（未传或空 `url`）。

### 1.2 查询任务详情

```http
GET /api/job/:id
```

- **成功**：`200`，Body 示例：
  ```json
  {
    "id": "1738xxx",
    "url": "https://example.com/playlist.m3u8",
    "status": "downloading",
    "segments": [
      {"index": 0, "url": "...", "filename": "seg_00001.ts", "status": "success", "retryCount": 0}
    ],
    "encryption": true
  }
  ```
  - `status`：任务状态（见下文“任务状态”）。
  - `segments`：分片列表，每项含 `index`、`url`、`filename`、`status`、`retryCount`。
  - `encryption`：布尔，表示是否检测到加密。
- **失败**：`404`，`{"error": "Task not found"}`。

### 1.3 重试单个分片

```http
POST /api/retry-segment
Content-Type: application/json

{"jobId": "<任务ID>", "segmentIndex": 0}
```

- **成功**：`200`，`{"success": true}`。
- **失败**：`404`，`{"error": "Job not found"}`。

### 1.4 重启任务（清空进度重新下载）

```http
POST /api/restart
Content-Type: application/json

{"jobId": "<任务ID>"}
```

- **成功**：`200`，`{"success": true}`。服务端会清空该任务在 `downloads/<jobId>` 下的文件，将任务重置并重新加入队列头部。
- **失败**：`404`，`{"error": "Job not found"}`。

### 1.5 强制合并

```http
POST /api/force-merge
Content-Type: application/json

{"jobId": "<任务ID>"}
```

- **成功**：`200`，`{"success": true}`。将当前已成功下载的分片（以及磁盘上存在但状态可能未标成功的文件）合并为 `output.mp4`，不要求全部分片成功。
- **失败**：`404`，`{"error": "Job not found"}`。

### 1.6 删除任务

```http
DELETE /api/job/:id
```

- **成功**：`200`，`{"success": true}`。同时删除 `downloads/<id>` 目录及 `data.json` 中该任务记录。
- **失败**：`400`，`{"error": "无法删除正在运行的任务，请等待完成或重启服务"}` 或 `{"error": "找不到该任务"}`。

### 1.7 SSE 事件流

```http
GET /api/events
Accept: text/event-stream
```

- 保持长连接，服务端推送事件，每条格式为：`data: <JSON>\n\n`。
- 客户端应使用 `EventSource` 或按 SSE 规范解析；收到数据后 `JSON.parse(event.data)` 得到对象，根据 `type` 或 `event` 区分类型。

---

## 2. SSE 事件类型

所有推送均为 JSON 对象，常见字段如下。

### 2.1 队列与状态更新（queue-update）

```json
{
  "type": "queue-update",
  "data": {
    "queue": [
      {"id": "xxx", "url": "https://...", "status": "queued", "createdAt": 1738xxx}
    ],
    "activeId": "当前运行任务ID或null",
    "history": [
      {
        "id": "xxx",
        "url": "https://...",
        "status": "completed",
        "successCount": 100,
        "totalCount": 100,
        "outputFile": "./downloads/xxx"
      }
    ]
  }
}
```

- 在添加/删除/重启任务、任务开始/结束时都会推送，前端用于同步等待队列与任务列表。

### 2.2 新任务开始（job-start）

```json
{
  "type": "job-start",
  "data": {"id": "<任务ID>", "url": "https://..."}
}
```

- 某个任务从队列中取出并开始执行时推送一次。

### 2.3 任务日志（log）

```json
{
  "event": "log",
  "payload": {
    "jobId": "<任务ID>",
    "type": "info|error|init-segments|segment-update|progress|done",
    "timestamp": 1738xxx,
    "data": "<类型相关数据>"
  }
}
```

- **type = info / error**：`data` 为字符串，日志内容。
- **type = init-segments**：`data` 为分片数组，任务解析完 M3U8 后首次推送，前端用于渲染网格。
- **type = segment-update**：`data` 为单个分片对象（含 index、status 等），用于更新对应格子状态。
- **type = progress**：`data` 为 `{ percent, success, total }`。
- **type = done**：`data` 为 `{ outputFile }`，合并完成。

前端一般只处理 `payload.jobId === 当前查看任务ID` 的 log，避免混入其他任务日志。

---

## 3. 任务与分片状态

### 3.1 任务状态（status）

| 状态 | 说明 |
|------|------|
| `pending` | 未使用（任务创建后多为 queued） |
| `queued` | 在等待队列中 |
| `parsing` | 正在拉取并解析 M3U8 |
| `downloading` | 正在下载分片 |
| `merging` | 正在合并为 MP4 |
| `waiting_retry` | 存在失败分片，等待用户重试或强制合并 |
| `error` | 解析或执行过程发生致命错误 |
| `completed` | 合并完成 |

### 3.2 分片状态（segments[].status）

| 状态 | 说明 |
|------|------|
| `pending` | 待下载 |
| `retry` | 标记为待重试（与 pending 一样会被下载逻辑处理） |
| `downloading` | 正在下载 |
| `success` | 已成功写入磁盘 |
| `failed` | 重试次数用尽仍失败 |

---

## 4. M3U8 解析与存储

### 4.1 解析逻辑（parseM3U8）

- 输入：M3U8 文本内容、baseUrl（用于解析相对路径）。
- 行为：
  - **#EXT-X-KEY**：解析 `URI="..."` 或 `URI=...`，以及可选的 `IV=0x...`，写入 `this.encryption = { URI, IV }`。当前仅考虑 AES-128 的 KEY。
  - **分片行**：以 `http` 开头或匹配 `.(ts|m4s|mp4)$` 的行视为分片 URL；若为相对路径则用 `new URL(line, baseUrl)` 解析为绝对 URL。每个分片生成对象：`{ index, url, filename: seg_00001.ts 形式, status: 'pending', retryCount: 0 }`。
- 不支持：多码率主列表（只处理单层 m3u8）、`#EXT-X-MAP`、非 AES-128 加密。

### 4.2 密钥下载与解密

- **密钥**：从 `encryption.URI` 拉取二进制，存到 `this.encryption.key`，并写入 `downloads/<id>/encryption.key`（便于排查）。
- **解密**：AES-128-CBC。IV 来源：若 M3U8 中有 `IV=0x...` 则使用该 16 字节；否则使用全 0 Buffer 并在末尾 4 字节写入 `segment.index` 的 big-endian（常见 HLS 做法）。解密后覆盖原 `data` 再写入分片文件。

### 4.3 分片下载与合并

- **并发**：按 `concurrentDownloads`（默认 5）分批，逐批 `Promise.all` 下载，每批内可重试（见下文）。
- **重试**：单分片失败后 `retryCount++`，若未超过 `retryCount` 配置则延迟 `1000 * retryCount` 毫秒后再次下载该分片；超过则标记为 `failed`。
- **合并**：仅当全部分片为 `success` 时自动合并；或用户调用「强制合并」。合并时按 `segments` 顺序，将已存在磁盘的分片文件依次 `createReadStream().pipe(writeStream, { end: false })` 写入 `output.mp4`，不重新编码。合并完成后执行 `cleanup()` 删除分片与密钥文件。

---

## 5. 持久化（data.json）

- **路径**：项目根目录 `data.json`（由 `QueueManager` 的 `DATA_FILE` 决定）。
- **结构**：
  ```json
  {
    "queue": [{"id", "url", "status", "createdAt"}],
    "activeTask": { "id", "url", "options", "segments", "encryption", "status" } | null,
    "history": [ 同 activeTask 结构 ]
  }
  ```
- **写入时机**：添加任务、删除任务、重启任务、开始/结束任务、重试分片后等，均会调用 `saveState()`。
- **读取时机**：`QueueManager` 构造时 `loadState()`。若存在 `activeTask`，会将其恢复为 `M3U8Task` 实例并移入 `history`，状态设为 `waiting_retry`（因进程已断，无法继续原内存状态）。

---

## 6. 错误处理与安全

- **全局**：`process.on('uncaughtException')` 与 `unhandledRejection` 仅打日志，避免进程因未捕获异常退出。
- **请求**：`fetch`/http 请求失败或非 200 会 reject，由 `M3U8Task` 内 catch 并转为任务/分片状态与日志，不向 API 直接暴露堆栈。
- **文件**：删除目录使用 `fs.rmSync(..., { recursive: true, force: true })`；写入前由 `M3U8Task.start()` 确保 `outputDir` 存在。
- **SSE**：向客户端 write 时 try/catch 忽略单客户端错误，避免影响其他连接。

---

以上为技术文档核心内容；开发流程与扩展见 [DEVELOPMENT.md](DEVELOPMENT.md)，用户操作见 [USER_MANUAL.md](USER_MANUAL.md)。
