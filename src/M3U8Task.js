// src/M3U8Task.js
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const crypto = require("crypto");
const { URL } = require("url");

class M3U8Task {
  constructor(url, options = {}, logCallback) {
    this.url = url;
    this.id = options.id;
    this.options = {
      outputDir: path.join("./downloads", options.id),
      concurrentDownloads: 5,
      timeout: 30000,
      retryCount: 3,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36",
        Referer: "https://delipu.cc/",
        ...options.headers,
      },
      ...options,
    };

    // 如果 logCallback 没传，给一个空函数防止报错
    this.logCallback = logCallback || (() => {});
    this.segments = [];
    this.encryption = null;
    this.status = "pending";

    // if (!fs.existsSync(this.options.outputDir)) {
    //   fs.mkdirSync(this.options.outputDir, { recursive: true });
    // }
  }

  // --- 新增：用于从 JSON 数据恢复任务实例 ---
  static fromJSON(data, logCallback) {
    const task = new M3U8Task(
      data.url,
      { id: data.id, ...data.options },
      logCallback,
    );
    task.segments = data.segments || [];
    task.encryption = data.encryption || null;
    task.status = data.status;
    // 如果状态是 downloading，重启后应该重置为 waiting_retry，因为进程已经断了
    if (task.status === "downloading" || task.status === "parsing") {
      task.status = "waiting_retry";
    }
    return task;
  }

  log(type, data) {
    this.logCallback({
      jobId: this.id,
      type: type,
      timestamp: Date.now(),
      data: data,
    });
  }

  async start() {
    try {
      // 【新增】将创建目录逻辑移到这里
      if (!fs.existsSync(this.options.outputDir)) {
        fs.mkdirSync(this.options.outputDir, { recursive: true });
      }

      this.status = "parsing";
      this.log("info", `开始解析 URL: ${this.url}`);

      const m3u8Content = await this.fetch(this.url);
      this.parseM3U8(m3u8Content.toString(), this.url);
      this.log("init-segments", this.segments);

      if (this.encryption && this.encryption.URI) {
        this.log("info", "检测到加密，正在下载密钥...");
        await this.downloadKey();
      }

      this.status = "downloading";
      await this.downloadSegmentsLoop();
    } catch (error) {
      this.status = "error";
      this.log("error", `任务发生致命错误: ${error.message}`);
    }
  }

  async downloadSegmentsLoop() {
    const pendingSegments = this.segments.filter(
      (s) => s.status === "pending" || s.status === "retry",
    );
    if (pendingSegments.length === 0) {
      return this.checkAndMerge();
    }

    this.log("info", `开始下载，剩余分片: ${pendingSegments.length}`);

    for (
      let i = 0;
      i < this.segments.length;
      i += this.options.concurrentDownloads
    ) {
      if (this.status === "stopped") break;

      const batch = this.segments.slice(
        i,
        i + this.options.concurrentDownloads,
      );
      const promises = batch.map((seg) => {
        if (seg.status !== "success") {
          return this.downloadSegmentWithRetry(seg);
        }
        return Promise.resolve();
      });

      await Promise.all(promises);
      this.reportProgress();
    }

    this.checkAndMerge();
  }

  async retrySingleSegment(index) {
    const segment = this.segments.find((s) => s.index === index);
    if (!segment) return;

    this.log("info", `手动重试分片 #${index}`);
    segment.status = "pending";
    segment.retryCount = 0;
    this.log("segment-update", segment);

    try {
      await this.downloadSegmentWithRetry(segment);
      this.reportProgress();
      const allSuccess = this.segments.every((s) => s.status === "success");
      if (allSuccess) this.checkAndMerge();
    } catch (e) {}
  }

  async forceMerge() {
    this.log("info", "用户触发强制合并...");
    await this.mergeSegments(true);
  }

  async checkAndMerge() {
    const failed = this.segments.filter((s) => s.status === "failed").length;
    const success = this.segments.filter((s) => s.status === "success").length;

    if (failed === 0 && success === this.segments.length) {
      this.status = "merging";
      await this.mergeSegments();
    } else {
      this.log(
        "info",
        `下载循环结束。成功: ${success}, 失败: ${failed}。等待用户操作。`,
      );
      this.status = failed > 0 ? "waiting_retry" : "completed";
      if (failed === 0)
        this.log("done", {
          outputFile: path.join(this.options.outputDir, "output.mp4"),
        });
    }
  }

  parseM3U8(content, baseUrl) {
    const lines = content.split("\n");
    const baseUrlObj = new URL(baseUrl);
    let segmentIndex = 0;

    lines.forEach((line) => {
      line = line.trim();
      if (!line) return;

      if (line.startsWith("#EXT-X-KEY:")) {
        const keyUriMatch =
          line.match(/URI="([^"]+)"/) || line.match(/URI=([^,]+)/);
        const ivMatch = line.match(/IV=0x([0-9a-fA-F]+)/);
        if (keyUriMatch) {
          this.encryption = {
            URI: keyUriMatch[1],
            IV: ivMatch ? ivMatch[1] : null,
          };
        }
      } else if (line.startsWith("http") || line.match(/\.(ts|m4s|mp4)$/)) {
        let url = line;
        if (!line.startsWith("http")) {
          url = new URL(line, baseUrlObj.origin + baseUrlObj.pathname).href;
        }

        this.segments.push({
          index: segmentIndex++,
          url: url,
          filename: `seg_${segmentIndex.toString().padStart(5, "0")}.ts`,
          status: "pending",
          retryCount: 0,
        });
      }
    });
  }

  async downloadKey() {
    if (!this.encryption) return;
    try {
      const keyData = await this.fetch(this.encryption.URI);
      this.encryption.key = keyData;
      this.log("info", "密钥下载成功");
      fs.writeFileSync(
        path.join(this.options.outputDir, "encryption.key"),
        keyData,
      );
    } catch (e) {
      this.log("error", "密钥下载失败");
    }
  }

  async downloadSegmentWithRetry(segment) {
    if (segment.status === "success") return;

    segment.status = "downloading";
    this.log("segment-update", segment);

    try {
      let data = await this.fetch(segment.url);

      if (this.encryption && this.encryption.key) {
        const iv = this.encryption.IV
          ? Buffer.from(this.encryption.IV, "hex")
          : Buffer.alloc(16);
        if (!this.encryption.IV) iv.writeUInt32BE(segment.index, 12);

        const decipher = crypto.createDecipheriv(
          "aes-128-cbc",
          this.encryption.key,
          iv,
        );
        data = Buffer.concat([decipher.update(data), decipher.final()]);
      }

      fs.writeFileSync(
        path.join(this.options.outputDir, segment.filename),
        data,
      );
      segment.status = "success";
      this.log("segment-update", segment);
    } catch (error) {
      segment.retryCount++;
      if (segment.retryCount <= this.options.retryCount) {
        this.log(
          "info",
          `分片 #${segment.index} 下载失败 (${segment.retryCount})`,
        );
        await new Promise((r) => setTimeout(r, 1000 * segment.retryCount));
        return this.downloadSegmentWithRetry(segment);
      } else {
        segment.status = "failed";
        this.log("segment-update", segment);
        this.log("error", `分片 #${segment.index} 最终失败`);
      }
    }
  }

  async mergeSegments(force = false) {
    this.log("info", "开始合并分片(流式)...");
    const outputPath = path.join(this.options.outputDir, "output.mp4");
    const writeStream = fs.createWriteStream(outputPath);

    const segmentsToMerge = this.segments.filter(
      (s) =>
        s.status === "success" ||
        (force && fs.existsSync(path.join(this.options.outputDir, s.filename))),
    );

    return new Promise((resolve, reject) => {
      writeStream.on("error", (err) => {
        this.log("error", `合并写入出错: ${err.message}`);
        writeStream.end();
        reject(err);
      });

      writeStream.on("finish", () => {
        this.status = "completed";
        this.log("info", `合并完成: ${outputPath}`);
        this.cleanup();
        this.log("done", { outputFile: outputPath });
        resolve();
      });

      const mergeNext = (index) => {
        if (index >= segmentsToMerge.length) {
          writeStream.end();
          return;
        }
        const seg = segmentsToMerge[index];
        const segPath = path.join(this.options.outputDir, seg.filename);

        if (!fs.existsSync(segPath)) {
          mergeNext(index + 1);
          return;
        }

        const readStream = fs.createReadStream(segPath);
        readStream.on("error", (err) => {
          readStream.destroy();
          mergeNext(index + 1);
        });
        readStream.pipe(writeStream, { end: false });
        readStream.on("end", () => mergeNext(index + 1));
      };
      mergeNext(0);
    });
  }

  cleanup() {
    this.log("info", "清理临时文件...");
    this.segments.forEach((seg) => {
      const filePath = path.join(this.options.outputDir, seg.filename);
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (e) {}
      }
    });
    try {
      const keyPath = path.join(this.options.outputDir, "encryption.key");
      if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
    } catch (e) {}
  }

  reportProgress() {
    const success = this.segments.filter((s) => s.status === "success").length;
    const progress = this.segments.length
      ? ((success / this.segments.length) * 100).toFixed(1)
      : 0;
    this.log("progress", {
      percent: progress,
      success,
      total: this.segments.length,
    });
  }

  fetch(url) {
    return new Promise((resolve, reject) => {
      const client = url.startsWith("https") ? https : http;
      const req = client.get(
        url,
        { headers: this.options.headers, timeout: this.options.timeout },
        (res) => {
          if (res.statusCode !== 200) {
            return reject(new Error(`Status ${res.statusCode}`));
          }
          const data = [];
          res.on("data", (chunk) => data.push(chunk));
          res.on("end", () => resolve(Buffer.concat(data)));
        },
      );

      // 关键：确保这里捕获所有网络错误，防止崩溃
      req.on("error", (err) => reject(new Error(`网络错误: ${err.message}`)));
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("请求超时"));
      });
    });
  }
}

module.exports = M3U8Task;
