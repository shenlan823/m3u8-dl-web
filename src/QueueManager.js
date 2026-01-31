// src/QueueManager.js
const fs = require("fs");
const path = require("path");
const M3U8Task = require("./M3U8Task");

const DATA_FILE = path.join(__dirname, "../data.json");

class QueueManager {
  constructor(sseBroadcast) {
    this.queue = [];
    this.activeTask = null;
    this.history = [];
    this.sseBroadcast = sseBroadcast;

    // 初始化时加载数据
    this.loadState();
  }

  // --- 持久化逻辑 ---

  saveState() {
    try {
      const data = {
        queue: this.queue,
        // 只需要保存 activeTask 的数据部分
        activeTask: this.activeTask
          ? this._serializeTask(this.activeTask)
          : null,
        history: this.history.map((t) => this._serializeTask(t)),
      };
      fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
      console.error("保存状态失败:", e);
    }
  }

  loadState() {
    if (!fs.existsSync(DATA_FILE)) return;
    try {
      const raw = fs.readFileSync(DATA_FILE, "utf8");
      const data = JSON.parse(raw);

      this.queue = data.queue || [];

      // 恢复历史记录
      if (data.history && Array.isArray(data.history)) {
        this.history = data.history.map((item) => {
          // 使用 fromJSON 复活对象，并挂载日志回调
          return M3U8Task.fromJSON(item, (logData) =>
            this._logWrapper(logData),
          );
        });
      }

      // 注意：如果崩溃前有正在运行的任务，重启后我们把它移入历史记录作为"待重试/异常停止"
      // 因为进程已经断了，无法继续之前的内存状态
      if (data.activeTask) {
        const crashedTask = M3U8Task.fromJSON(data.activeTask, (logData) =>
          this._logWrapper(logData),
        );
        crashedTask.status = "waiting_retry"; // 标记为等待重试
        crashedTask.log("error", "服务器异常重启，任务被中断");
        this.history.unshift(crashedTask);
        this.activeTask = null;
      }
    } catch (e) {
      console.error("加载状态失败:", e);
    }
  }

  _serializeTask(task) {
    // 提取需要保存的字段
    return {
      id: task.id,
      url: task.url,
      options: task.options,
      segments: task.segments,
      encryption: task.encryption,
      status: task.status,
    };
  }

  _logWrapper(logData) {
    this.sseBroadcast({
      event: "log",
      payload: logData,
    });
  }

  // --- 新增：重启/重置任务 ---
  restartTask(jobId) {
    // 1. 先在历史记录里找
    const historyIndex = this.history.findIndex((t) => t.id === jobId);
    let task = null;

    if (historyIndex !== -1) {
      // 从历史移除
      task = this.history.splice(historyIndex, 1)[0];
    } else if (this.activeTask && this.activeTask.id === jobId) {
      // 如果正在运行，强制停止（放入临时变量）
      task = this.activeTask;
      this.activeTask = null;
    }

    if (task) {
      // 【新增步骤】: 物理清空该任务的下载目录，确保从零开始
      const dirPath = path.join(__dirname, "../downloads", jobId);
      if (fs.existsSync(dirPath)) {
        try {
          // 删除整个文件夹
          fs.rmSync(dirPath, { recursive: true, force: true });
          // 重新创建空文件夹（可选，因为 M3U8Task.start 也会创建）
          fs.mkdirSync(dirPath, { recursive: true });
          console.log(`[Restart] 已清空目录: ${dirPath}`);
        } catch (e) {
          console.error(`[Restart] 清空目录失败: ${e.message}`);
        }
      }

      // 2. 重置任务状态
      task.status = "queued";
      task.segments = []; // 清空分片列表，重新解析
      task.encryption = null;
      task.log("info", "用户请求重新下载，任务已重置...");

      // 3. 重新加入队列头部
      this.queue.unshift({
        id: task.id,
        url: task.url,
        status: "queued",
        createdAt: Date.now(),
      });

      this.saveState();
      this.broadcastStatus();
      this.processQueue();
      return true;
    }
    return false;
  }

  addTask(url) {
    const id = Date.now().toString();
    const taskInfo = { id, url, status: "queued", createdAt: Date.now() };
    this.queue.push(taskInfo);

    this.saveState(); // 保存
    this.broadcastStatus();
    this.processQueue();
    return id;
  }

  // --- 新增：删除任务 ---
  deleteTask(jobId) {
    let taskToDelete = null;
    let fromQueue = false;

    // 1. 检查是否在等待队列
    const qIndex = this.queue.findIndex((t) => t.id === jobId);
    if (qIndex !== -1) {
      taskToDelete = this.queue[qIndex]; // 这里只是 info 对象
      this.queue.splice(qIndex, 1);
      fromQueue = true;
    }

    // 2. 检查是否是历史记录
    if (!taskToDelete) {
      const hIndex = this.history.findIndex((t) => t.id === jobId);
      if (hIndex !== -1) {
        taskToDelete = this.history[hIndex];
        this.history.splice(hIndex, 1);
      }
    }

    // 3. 检查是否是正在运行 (Active)
    if (!taskToDelete && this.activeTask && this.activeTask.id === jobId) {
      // 正在运行的任务不能直接硬删除，先标记停止，但这需要 M3U8Task 支持中止
      // 简单处理：暂不支持删除正在运行的任务，或者强制停止
      // 这里我们选择：只允许删除非 Active 任务，或者强制置空
      // 如果要强制删除 Active：
      // this.activeTask = null;
      // 但这样会导致 Promise 悬挂。
      // 建议：前端限制正在运行的任务不能删除，或者后端返回错误。
      return {
        success: false,
        message: "无法删除正在运行的任务，请等待完成或重启服务",
      };
    }

    if (taskToDelete) {
      // 4. 删除物理文件
      const dirPath = path.join(__dirname, "../downloads", jobId);
      if (fs.existsSync(dirPath)) {
        try {
          fs.rmSync(dirPath, { recursive: true, force: true });
          console.log(`已物理删除目录: ${dirPath}`);
        } catch (e) {
          console.error(`删除目录失败: ${e.message}`);
        }
      }

      // 5. 保存状态并广播
      this.saveState();
      this.broadcastStatus();
      return { success: true };
    }

    return { success: false, message: "找不到该任务" };
  }

  async processQueue() {
    if (this.activeTask) return;
    if (this.queue.length === 0) return;

    const nextTaskInfo = this.queue.shift();

    // 创建新任务
    this.activeTask = new M3U8Task(
      nextTaskInfo.url,
      { id: nextTaskInfo.id },
      (logData) => this._logWrapper(logData),
    );

    this.saveState(); // 保存状态：队列少了，active有了
    this.broadcastStatus();

    this.sseBroadcast({
      type: "job-start",
      data: { id: nextTaskInfo.id, url: nextTaskInfo.url },
    });

    try {
      await this.activeTask.start();
    } catch (e) {
      console.error("Task failed unexpectedly:", e);
    }

    this.finishTask();
  }

  finishTask() {
    if (!this.activeTask) return;

    this.history.unshift(this.activeTask);
    if (this.history.length > 50) this.history.pop(); // 保留最近50条

    this.activeTask = null;

    this.saveState(); // 保存状态：active没了，history多了
    this.broadcastStatus();
    setTimeout(() => this.processQueue(), 1000);
  }

  getTaskById(jobId) {
    if (this.activeTask && this.activeTask.id === jobId) {
      return this.activeTask;
    }
    // 查找历史记录时，它已经是完整的 Task 实例了（在 loadState 中被复活了）
    return this.history.find((task) => task.id === jobId);
  }

  broadcastStatus() {
    const historySummary = this.history.map((t) => ({
      id: t.id,
      url: t.url,
      status: t.status,
      successCount: t.segments
        ? t.segments.filter((s) => s.status === "success").length
        : 0,
      totalCount: t.segments ? t.segments.length : 0,
      outputFile: t.options.outputDir,
    }));

    this.sseBroadcast({
      type: "queue-update",
      data: {
        queue: this.queue,
        activeId: this.activeTask ? this.activeTask.id : null,
        history: historySummary,
      },
    });
  }
  // 补全缺失的辅助方法（防止你没复制全）
  saveState() {
    try {
      const data = {
        queue: this.queue,
        activeTask: this.activeTask
          ? this._serializeTask(this.activeTask)
          : null,
        history: this.history.map((t) => this._serializeTask(t)),
      };
      fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
      console.error("Save failed:", e);
    }
  }
}

module.exports = QueueManager;
