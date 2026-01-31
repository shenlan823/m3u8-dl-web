# M3U8 Web 下载器

基于 Web 的 M3U8 流媒体下载工具，支持 SSE 实时推送、队列管理、断点续传与 AES-128 解密。

## 功能特性

- **Web 控制台**：Vue 3 + Tailwind CSS 单页界面，输入 M3U8 链接即可添加任务
- **队列管理**：多任务排队，一次只能运行一个任务，其余进入等待队列
- **实时进度**：通过 Server-Sent Events (SSE) 推送队列状态、任务进度与日志
- **分片可视化**：每个分片以小块显示（灰/蓝/绿/红），点击失败分片可重试
- **AES-128 解密**：自动解析 `#EXT-X-KEY` 并下载密钥，支持 IV 或无 IV 的 CBC 解密
- **持久化**：队列与任务状态写入 `data.json`，重启服务后可恢复历史与待重试任务
- **强制合并**：部分分片失败时，可将已下载分片强制合并为 MP4
- **重启/删除**：支持任务重新下载（清空进度）与删除任务及本地文件

## 快速开始

### 环境要求

- Node.js 14+
- npm 或 yarn

### 安装与运行

```bash
# 克隆或进入项目目录
cd m3u8-web

# 安装依赖
npm install

# 启动服务（开发模式，使用 nodemon 热重载）
npm start
```

浏览器访问：**http://localhost:3000**

### 使用步骤

1. 在顶部输入框粘贴 M3U8 链接，点击「添加任务」或按回车
2. 任务进入等待队列，当前无运行任务时会自动开始
3. 在右侧「任务列表」中点击任务查看详情：分片网格、进度条、日志
4. 若有分片失败（红色），点击该分片可重试；或使用「强制合并」合并已成功分片
5. 完成后视频保存在 `downloads/<任务ID>/output.mp4`

## 项目结构

```
m3u8-web/
├── server.js           # Express 入口，API 与 SSE
├── public/
│   └── index.html      # 前端单页（Vue 3 + Tailwind）
├── src/
│   ├── M3U8Task.js      # 单任务：解析、下载、解密、合并
│   └── QueueManager.js  # 队列与持久化
├── downloads/           # 各任务输出目录（按任务 ID）
├── data.json            # 队列与任务状态（自动生成）
├── docs/                # 文档
│   ├── DEVELOPMENT.md   # 开发文档
│   ├── TECHNICAL.md     # 技术文档
│   └── USER_MANUAL.md   # 使用手册
├── package.json
└── nodemon.json
```

## 文档索引

| 文档                                       | 说明                                   |
| ------------------------------------------ | -------------------------------------- |
| [README.md](README.md)                     | 项目概览与快速开始（本文件）           |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | 开发文档：架构、目录说明、扩展与调试   |
| [docs/TECHNICAL.md](docs/TECHNICAL.md)     | 技术文档：API、数据流、M3U8 解析与加密 |
| [docs/USER_MANUAL.md](docs/USER_MANUAL.md) | 使用手册：操作步骤与常见问题           |

## 技术栈

- **后端**：Node.js、Express、原生 http/https
- **前端**：Vue 3（CDN）、Tailwind CSS（CDN）
- **实时通信**：Server-Sent Events (SSE)
- **持久化**：JSON 文件（`data.json`）

## 注意事项

- 仅支持 **HTTP/HTTPS** 的 M3U8 与分片链接
- 加密仅支持 **AES-128-CBC**（常见 HLS 加密方式）
- 同时只运行一个下载任务，多任务需排队
- 请遵守目标网站的使用条款与版权规定，勿用于未授权下载

> **所有文档使用AI生成，仅供参考**
