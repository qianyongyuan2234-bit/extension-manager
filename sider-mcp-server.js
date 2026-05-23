#!/usr/bin/env node
// Sider MCP Server — expose Sider multi-model as MCP tools for Claude Code
// Usage: claude mcp add sider node /path/to/sider-mcp-server.js

const CDP = "http://localhost:9223";
let siderSession = null;

// ============================================================
// MCP JSON-RPC 2.0 Transport over stdio
// ============================================================
let stdinBuffer = "";

process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  stdinBuffer += chunk;
  // Process complete lines
  let newlineIdx;
  while ((newlineIdx = stdinBuffer.indexOf("\n")) >= 0) {
    const line = stdinBuffer.slice(0, newlineIdx).trim();
    stdinBuffer = stdinBuffer.slice(newlineIdx + 1);
    if (!line) continue;

    // Handle Content-Length prefixed format (legacy MCP)
    if (/^\d+$/.test(line)) {
      const contentLength = parseInt(line, 10);
      const content = stdinBuffer.slice(0, contentLength);
      stdinBuffer = stdinBuffer.slice(contentLength);
      try { handleMessage(JSON.parse(content)); } catch (e) { log(`Parse error: ${e.message}`); }
      continue;
    }

    try {
      handleMessage(JSON.parse(line));
    } catch (e) {
      log(`Parse error: ${e.message} for: ${line.slice(0, 100)}`);
    }
  }
});

function send(msg) {
  const raw = JSON.stringify(msg);
  process.stdout.write(raw + "\n");
}

// ============================================================
// Message handlers
// ============================================================
async function handleMessage(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case "initialize": {
      send({
        jsonrpc: "2.0", id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "sider-mcp", version: "1.0.0" },
        },
      });
      break;
    }

    case "notifications/initialized": {
      // Client is ready — connect to Sider
      log("MCP client initialized, connecting to Sider...");
      try {
        siderSession = await SiderSession.connect(CDP);
        log(`Connected. Models: ${siderSession.models.join(", ")}`);
      } catch (e) {
        log(`Sider connect failed: ${e.message}. Will retry on first tool call.`);
        siderSession = null;
      }
      break;
    }

    case "tools/list": {
      send({
        jsonrpc: "2.0", id,
        result: {
          tools: [
            {
              name: "sider_list_models",
              description: "列出 Sider 当前所有可用的 AI 模型",
              inputSchema: { type: "object", properties: {}, required: [] },
            },
            {
              name: "sider_ask",
              description: "向 Sider 的一个或多个 AI 模型提问，返回每个模型的回复和共识度对比",
              inputSchema: {
                type: "object",
                properties: {
                  question: { type: "string", description: "要问的问题" },
                  models: { type: "string", description: "逗号分隔的模型名称，如 'GPT-5.5,Claude Sonnet'。不填则使用所有模型" },
                },
                required: ["question"],
              },
            },
            {
              name: "sider_switch",
              description: "切换到指定 AI 模型（用于后续手动操作）",
              inputSchema: {
                type: "object",
                properties: {
                  model: { type: "string", description: "模型名称，如 'GPT-5.5' 或 'Claude Sonnet 4.6'" },
                },
                required: ["model"],
              },
            },
          ],
        },
      });
      break;
    }

    case "tools/call": {
      const { name, arguments: args } = params;
      try {
        const result = await handleToolCall(name, args || {});
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: result }] } });
      } catch (e) {
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true } });
      }
      break;
    }

    case "ping": {
      send({ jsonrpc: "2.0", id, result: {} });
      break;
    }

    default: {
      // Unknown — could be a notification, ignore
      if (id) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method: ${method}` } });
    }
  }
}

// ============================================================
// Tool implementations
// ============================================================
async function handleToolCall(name, args) {
  // Lazy connect
  if (!siderSession) {
    log("Reconnecting to Sider...");
    siderSession = await SiderSession.connect(CDP);
  }

  switch (name) {
    case "sider_list_models": {
      await siderSession.refreshModels();
      const models = siderSession.models;
      return `Sider 当前可用模型 (${models.length} 个):\n${models.map((m, i) => `  ${i + 1}. ${m}`).join("\n")}\n\n当前选中: ${siderSession.currentModel}`;
    }

    case "sider_ask": {
      return await siderSession.askModels(args.question, args.models);
    }

    case "sider_switch": {
      await siderSession.switchToModel(args.model);
      return `已切换到: ${args.model}`;
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ============================================================
// SiderSession — CDP-backed session manager
// ============================================================
class SiderSession {
  constructor(client, ws) {
    this.client = client;
    this.ws = ws;
    this.models = [];
    this.currentModel = "";
    this._lock = Promise.resolve(); // serial queue
  }

  static async connect(cdpUrl) {
    const targets = await fetch(`${cdpUrl}/json/list`).then(r => r.json());
    let siderTab = targets.find(t => t.url && t.url.includes("sider.ai") && t.type === "page");
    if (!siderTab) {
      siderTab = await fetch(`${cdpUrl}/json/new?${encodeURIComponent("https://sider.ai/")}`).then(r => r.json());
      await sleep(5000);
    }

    const { WebSocket } = require("http");
    // Node 22 built-in WebSocket
    const globalWs = globalThis.WebSocket || (await import("ws").catch(() => null))?.WebSocket;
    const ws = new (globalThis.WebSocket)(siderTab.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });

    const client = new CDPClient(ws);
    await client.send("Runtime.enable");
    await client.send("Page.enable");

    // Wait for page ready
    for (let i = 0; i < 30; i++) {
      const r = await client.send("Runtime.evaluate", {
        expression: "document.readyState",
        returnByValue: true,
      });
      if (r.result?.value === "complete") break;
      await sleep(500);
    }

    const session = new SiderSession(client, ws);
    await session.refreshModels();
    return session;
  }

  async refreshModels() {
    // Open dropdown
    await this.client.send("Runtime.evaluate", {
      expression: `(${openDropdownFn.toString()})()`,
      returnByValue: true,
    });
    await sleep(800);

    const r = await this.client.send("Runtime.evaluate", {
      expression: `(${readDropdownModelsFn.toString()})()`,
      returnByValue: true,
    });

    // Close
    await this.client.send("Runtime.evaluate", {
      expression: "document.body.click();",
      returnByValue: true,
    });

    const data = r.result?.value || {};
    this.models = data.options || [];
    this.currentModel = data.current || "";
  }

  async switchToModel(modelName) {
    await this.client.send("Runtime.evaluate", {
      expression: `(${openDropdownFn.toString()})()`,
      returnByValue: true,
    });
    await sleep(600);
    await this.client.send("Runtime.evaluate", {
      expression: `(${clickModelFn.toString()})(${JSON.stringify(modelName)})`,
      returnByValue: true,
    });
    this.currentModel = modelName;
    await sleep(1500);
  }

  async askModels(question, modelsFilter) {
    // Serialize to avoid concurrent dom manipulation
    return new Promise((resolve, reject) => {
      this._lock = this._lock.then(async () => {
        try {
          const result = await this._askModelsUnsafe(question, modelsFilter);
          resolve(result);
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  async _askModelsUnsafe(question, modelsFilter) {
    await this.refreshModels();

    let targets = this.models;
    if (modelsFilter) {
      const filterList = modelsFilter.split(",").map(s => s.trim().toLowerCase());
      targets = targets.filter(m => filterList.some(f => m.toLowerCase().includes(f)));
    }

    if (!targets.length) {
      // Fall back to single model
      const answer = await this._askOne(question);
      return `[默认模型] ${this.currentModel}\n\n${answer}`;
    }

    const results = [];
    for (let i = 0; i < targets.length; i++) {
      const model = targets[i];
      if (i > 0 || this.currentModel !== model) {
        await this.switchToModel(model);
      }
      const answer = await this._askOne(question);
      results.push({ model, answer });
    }

    return this._formatComparison(question, results);
  }

  async _askOne(question) {
    const r = await this.client.send("Runtime.evaluate", {
      expression: `(${injectAndSubmitFn.toString()})(${JSON.stringify(question)})`,
      returnByValue: true,
    });
    if (!r.result?.value?.success) {
      return `[发送失败: ${r.result?.value?.error || "未知错误"}]`;
    }

    let lastText = "";
    let stable = 0;
    for (let i = 0; i < 120; i++) {
      await sleep(1500);
      const resp = await this.client.send("Runtime.evaluate", {
        expression: `(${checkResponseFn.toString()})(${JSON.stringify(question)})`,
        returnByValue: true,
      });
      const text = resp.result?.value?.text || "";
      if (text && text === lastText) {
        stable++;
        if (stable >= 4) return text;
      } else if (text) {
        lastText = text;
        stable = 0;
      }
    }
    return lastText || "[超时]";
  }

  _formatComparison(question, results) {
    const lines = [];
    lines.push(`📋 "${question}"`);
    lines.push("");

    for (const r of results) {
      lines.push(`### ${r.model} (${r.answer.length} 字)`);
      lines.push(r.answer);
      lines.push("");
    }

    if (results.length >= 2) {
      const similarity = calcSimilarity(results);
      if (similarity >= 70) {
        lines.push(`🔗 共识度: ${similarity}% — 高度一致`);
      } else if (similarity >= 40) {
        lines.push(`🔗 共识度: ${similarity}% — 基本一致，侧重不同`);
      } else {
        lines.push(`🔗 共识度: ${similarity}% — 观点有差异`);
      }
    }

    return lines.join("\n");
  }

  close() {
    this.ws.close();
  }
}

// ============================================================
// CDP Client
// ============================================================
class CDPClient {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg.result || msg.error);
        this.pending.delete(msg.id);
      }
    };
  }

  send(method, params = {}) {
    return new Promise((resolve) => {
      const id = ++this.id;
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

// ============================================================
// Page-injected functions (synchronous — same as cdp-client.js)
// ============================================================
const openDropdownFn = () => {
  if (document.querySelector('.model-title')) {
    document.body.click();
  }
  const btns = document.querySelectorAll('.model-btn');
  for (const b of btns) {
    const t = (b.textContent || '').trim();
    if (t.length > 0 && t.length < 20) { b.click(); return; }
  }
  if (btns.length) btns[0].click();
};

const readDropdownModelsFn = () => {
  const currentBtn = document.querySelector('.model-btn');
  const current = (currentBtn?.textContent || '').trim();
  const seen = new Set();
  const options = [];
  const items = document.querySelectorAll('.model-title');
  for (const el of items) {
    const text = (el.textContent || '').trim();
    if (text.length >= 2 && !seen.has(text)) {
      seen.add(text);
      options.push(text);
    }
  }
  return { options: [...options], current };
};

const clickModelFn = (name) => {
  const items = document.querySelectorAll('.model-title');
  for (const el of items) {
    if ((el.textContent || '').trim() === name) {
      el.click();
      return;
    }
  }
};

const injectAndSubmitFn = (text) => {
  let input = null;
  const candidates = ["textarea", "[contenteditable='true']", ".ProseMirror", '[role="textbox"]', "#prompt-textarea", "div[data-placeholder]", "form textarea", ".chat-input textarea"];
  for (const sel of candidates) { input = document.querySelector(sel); if (input && input.offsetParent !== null) break; input = null; }
  if (!input) { const allTA = document.querySelectorAll("textarea"); for (const ta of allTA) { if (ta.offsetParent !== null) { input = ta; break; } } }
  if (!input) return { success: false, error: "找不到输入框" };

  const isCE = input.getAttribute("contenteditable") === "true" || input.classList.contains("ProseMirror") || input.getAttribute("role") === "textbox";
  if (isCE) {
    input.focus(); input.textContent = text;
    input.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    const proto = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    const tracker = input._valueTracker; if (tracker) { tracker.setValue(""); tracker.setValue(text); }
    input.focus();
  }

  const btnCandidates = ["button[type='submit']", "button[aria-label*='send' i]", "button[aria-label*='Send']", "form button", "form [type='submit']", ".send-btn", "#send-button", "#submit-button"];
  let sendBtn = null;
  for (const sel of btnCandidates) { sendBtn = document.querySelector(sel); if (sendBtn && sendBtn.offsetParent !== null) break; sendBtn = null; }
  if (sendBtn) { sendBtn.click(); } else {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
  }
  return { success: true };
};

const checkResponseFn = (sentText) => {
  const answerBoxes = document.querySelectorAll('.answer-markdown-box');
  if (answerBoxes.length) {
    const last = answerBoxes[answerBoxes.length - 1];
    const text = (last.textContent || '').trim();
    if (text.length > 5) return { text };
  }

  const aiSelectors = [
    ".ai-response", ".assistant-message", ".bot-message", ".response-text",
    '[class*="assistant"]', '[class*="response"]', '[class*="answer"]',
    '[class*="bot"]', '[class*="ai-"]', ".markdown-body", ".prose",
    '[data-role="assistant"]', '[data-message-role="assistant"]',
    ".message.assistant", ".message.ai", ".chat-message.assistant",
  ];

  let respEl = null;
  for (const sel of aiSelectors) {
    const els = document.querySelectorAll(sel);
    if (els.length) respEl = els[els.length - 1];
    if (respEl) break;
  }

  if (!respEl) {
    const mainSel = ["main", ".chat-content", ".conversation", ".messages", '[role="log"]', '[role="list"]'];
    let main = null;
    for (const s of mainSel) { main = document.querySelector(s); if (main) break; }
    if (!main) main = document.body;

    const all = main.querySelectorAll("p, div, li, pre, code, h1, h2, h3, h4, h5, h6, span");
    let best = "";
    for (const el of all) {
      const t = (el.textContent || "").trim();
      if (t.length > best.length && t.length > 50 &&
          t !== sentText.trim() &&
          !el.closest("form, [role='form'], .input-area, .composer, .send-box, textarea, .prompt-box, nav, header, footer, [class*='sidebar'], [class*='toolbar']")) {
        best = t;
      }
    }
    return { text: best };
  }

  const text = (respEl.textContent || "").trim();
  return { text };
};

// ============================================================
// Utils
// ============================================================
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function calcSimilarity(results) {
  if (results.length < 2) return 100;
  const a = results[0].answer, b = results[1].answer;
  if (a === b) return 100;
  if (!a || !b) return 0;
  const tokenize = (s) => {
    const tokens = new Set();
    const cjkBigrams = s.match(/[一-鿿]{2,}/g) || [];
    for (const w of cjkBigrams) {
      for (let i = 0; i <= w.length - 2; i++) tokens.add(w.slice(i, i + 2));
    }
    const alphaWords = s.match(/[a-zA-Z]+/g) || [];
    for (const w of alphaWords) tokens.add(w.toLowerCase());
    return tokens;
  };
  const sa = tokenize(a), sb = tokenize(b);
  const intersect = new Set([...sa].filter(x => sb.has(x)));
  const union = new Set([...sa, ...sb]);
  return union.size ? Math.round((intersect.size / union.size) * 100) : 0;
}

function log(msg) {
  process.stderr.write(`[sider-mcp] ${msg}\n`);
}

// ============================================================
// Entry
// ============================================================
log("Sider MCP Server starting...");
