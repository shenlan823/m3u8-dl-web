// server.js
const express = require("express");
const bodyParser = require("body-parser");
const QueueManager = require("./src/QueueManager");

const app = express();
const PORT = 3000;

app.use(bodyParser.json());
app.use(express.static("public"));

// --- 防崩溃：全局错误捕获 ---
process.on("uncaughtException", (err) => {
  console.error("未捕获的异常 (防止崩溃):", err);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("未处理的 Promise 拒绝 (防止崩溃):", reason);
});

// SSE 客户端
let clients = [];

const broadcast = (data) => {
  clients.forEach((client) => {
    try {
      client.res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (e) {}
  });
};

// 初始化管理器
const queueManager = new QueueManager(broadcast);

// --- API ---

app.post("/api/add", (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).send("URL is required");
  const id = queueManager.addTask(url);
  res.json({ success: true, id });
});

app.post("/api/retry-segment", (req, res) => {
  const { jobId, segmentIndex } = req.body;
  const task = queueManager.getTaskById(jobId);

  if (task) {
    // 关键：修改状态后也要保存，防止重试中途崩溃状态没更新
    task.retrySingleSegment(segmentIndex);
    queueManager.saveState();
    res.json({ success: true });
  } else {
    res.status(404).json({ error: "Job not found" });
  }
});

// 新增：完全重启任务接口
app.post("/api/restart", (req, res) => {
  const { jobId } = req.body;
  const success = queueManager.restartTask(jobId);

  if (success) {
    res.json({ success: true });
  } else {
    res.status(404).json({ error: "Job not found" });
  }
});

app.post("/api/force-merge", (req, res) => {
  const { jobId } = req.body;
  const task = queueManager.getTaskById(jobId);
  if (task) {
    task.forceMerge();
    res.json({ success: true });
  } else {
    res.status(404).json({ error: "Job not found" });
  }
});

app.get("/api/job/:id", (req, res) => {
  const task = queueManager.getTaskById(req.params.id);
  if (task) {
    res.json({
      id: task.id,
      url: task.url,
      status: task.status,
      segments: task.segments,
      encryption: !!task.encryption,
    });
  } else {
    res.status(404).json({ error: "Task not found" });
  }
});

// 新增：删除任务接口
app.delete("/api/job/:id", (req, res) => {
  const result = queueManager.deleteTask(req.params.id);
  if (result.success) {
    res.json({ success: true });
  } else {
    res.status(400).json({ error: result.message });
  }
});

app.get("/api/events", (req, res) => {
  const headers = {
    "Content-Type": "text/event-stream",
    Connection: "keep-alive",
    "Cache-Control": "no-cache",
  };
  res.writeHead(200, headers);
  const clientId = Date.now();
  clients.push({ id: clientId, res });
  req.on("close", () => {
    clients = clients.filter((c) => c.id !== clientId);
  });

  // 立即发送最新状态（包含从文件加载的历史记录）
  setTimeout(() => queueManager.broadcastStatus(), 500);
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
