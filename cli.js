#!/usr/bin/env node
// CLI → Sider multi-model via AppleScript + HTTP bridge
// Usage: node cli.js "your question here"
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const PORT = 8766;
const question = process.argv.slice(2).join(" ").trim();

if (!question) {
  console.log('用法: node cli.js "你的问题"');
  console.log("");
  console.log("前提: Sider 网页版已打开并登录 (https://sider.ai/)");
  process.exit(1);
}

// Shared state
let state = { status: "pending", question };
let resultData = null;

// Read the worker script (injected into Sider page)
const workerScript = fs.readFileSync(path.join(__dirname, "worker.js"), "utf8");

// Start HTTP bridge
const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // Serve worker script
  if (req.method === "GET" && req.url === "/worker.js") {
    res.writeHead(200, { "Content-Type": "application/javascript" });
    res.end(workerScript);
    return;
  }

  // Command endpoint
  if (req.method === "GET" && req.url === "/command") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(state));
    return;
  }

  // Result endpoint
  if (req.method === "POST" && req.url === "/result") {
    let body = "";
    req.on("data", d => body += d);
    req.on("end", () => {
      try {
        resultData = JSON.parse(body);
        state.status = "done";
        res.writeHead(200, res.end(JSON.stringify({ ok: true })));
      } catch (e) {
        res.writeHead(400, res.end(JSON.stringify({ error: e.message })));
      }
    });
    return;
  }

  if (req.method === "GET" && req.url === "/ping") {
    res.writeHead(200, res.end("pong"));
    return;
  }

  res.writeHead(404); res.end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`🚀 桥接服务 localhost:${PORT}`);
  console.log(`❓ "${question}"`);
  console.log("⏳ 等待扩展 service worker 拾取命令...\n");
  console.log("（如超时请刷新扩展: chrome://extensions → 扩展管理器 → ↻）\n");
});

// ---- AppleScript injection ----
function injectIntoChrome() {
  // Minimal bootstrap: fetch worker.js from bridge, then eval via new Function
  // This avoids complex string escaping in AppleScript
  const bootstrap = `
(function(){
  fetch("http://127.0.0.1:${PORT}/worker.js")
    .then(function(r){ return r.text(); })
    .then(function(code){ new Function(code)(); })
    .catch(function(e){ console.error("Worker load failed:", e); });
})();
`;

  const as = `
tell application "Google Chrome"
  set siderTab to missing value
  repeat with w in windows
    repeat with t in tabs of w
      if URL of t starts with "https://sider.ai" then
        set siderTab to t
        exit repeat
      end if
    end repeat
    if siderTab is not missing value then exit repeat
  end repeat

  if siderTab is missing value then
    tell window 1
      set siderTab to make new tab with properties {URL:"https://sider.ai/"}
    end tell
    delay 3
    -- re-fetch tab reference
    repeat with w in windows
      repeat with t in tabs of w
        if URL of t starts with "https://sider.ai" then
          set siderTab to t
          exit repeat
        end if
      end repeat
      if siderTab is not missing value then exit repeat
    end repeat
  end if

  execute siderTab javascript "${bootstrap.replace(/"/g, '\\"').replace(/\\n/g, '\\n')}"
end tell
`;

  execFile("osascript", ["-e", as], (err, stdout, stderr) => {
    if (err) {
      const errMsg = (stderr || err.message);
      if (errMsg.includes("已关闭") || errMsg.includes("12")) {
        console.log("⚠ 请先在 Chrome 中开启：");
        console.log("  菜单栏 → 显示 → 开发者 → 允许 Apple 事件中的 JavaScript");
        console.log("  (View → Developer → Allow JavaScript from Apple Events)");
      } else {
        console.log("⚠ AppleScript 注入失败:", errMsg.slice(0, 200));
        console.log("请确认:");
        console.log("  1. Chrome 正在运行");
        console.log("  2. Sider 标签页已打开并登录 (https://sider.ai/)");
      }
      return;
    }
    console.log("✅ 注入成功，等待模型回复...\n");
  });
}

// ---- Poll for result ----
const MAX_WAIT = 600000; // 10 min
const start = Date.now();
let dots = 0;

const poll = setInterval(() => {
  if (resultData) {
    clearInterval(poll);
    printResults(resultData);
    server.close();
    process.exit(0);
  }

  if (Date.now() - start > MAX_WAIT) {
    clearInterval(poll);
    console.log("\n⏰ 超时（10 分钟）");
    console.log("请检查: Sider 页面是否登录、控制台是否有报错");
    server.close();
    process.exit(1);
  }

  process.stdout.write(".");
  dots++;
  if (dots % 50 === 0) process.stdout.write("  " + Math.floor((Date.now() - start) / 1000) + "s\n");
}, 1000);

function printResults(data) {
  console.log(`\n\n${"=".repeat(60)}`);
  console.log("📋 汇总结果");
  console.log("=".repeat(60));
  console.log(`❓ "${data.question}"\n`);

  for (const r of data.results || []) {
    console.log("-".repeat(40));
    console.log(`🤖 ${r.model}`);
    console.log("-".repeat(40));
    console.log(r.answer);
    console.log();
  }

  console.log("=".repeat(60));
  console.log(`✅ 共 ${data.results?.length || 0} 个模型回复`);
}
