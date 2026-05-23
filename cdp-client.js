#!/usr/bin/env node
// CDP Automation — Sider multi-model via Chrome DevTools Protocol
// Usage: node cdp-client.js "your question"
const http = require("http");

const CDP = "http://localhost:9223";

// Parse args: --models a,b,c  or  just the question
let filterModels = [];
let question = "";
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--models" && args[i + 1]) {
    filterModels = args[i + 1].split(",").map(s => s.trim());
    i++;
  } else {
    question += (question ? " " : "") + args[i];
  }
}
question = question.trim();

if (!question) {
  console.log('用法: node cdp-client.js [--models "GPT-5.5,Claude Sonnet"] "你的问题"');
  process.exit(1);
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });

async function main() {
  // 1. Find Sider tab
  console.log("🔍 查找 Sider 标签页...");
  const targets = await fetch(`${CDP}/json/list`).then(r => r.json());
  let siderTab = targets.find(t => t.url && t.url.includes("sider.ai") && t.type === "page");

  if (!siderTab) {
    console.log("   未找到，正在创建...");
    siderTab = await fetch(`${CDP}/json/new?${encodeURIComponent("https://sider.ai/")}`).then(r => r.json());
    await sleep(5000);
  }
  console.log(`   标签页: ${siderTab.id.slice(0, 8)}...`);

  // 2. Connect CDP
  const client = await CDPClient.connect(siderTab.webSocketDebuggerUrl);
  await client.send("Runtime.enable");
  await client.send("Page.enable");
  console.log("✅ CDP 已连接\n");

  // 3. Wait for page ready
  await waitForReady(client);

  // 4. Detect models
  console.log("🤖 检测可选模型...");
  const models = await detectModels(client);
  console.log(`   当前选中: ${models.current || "(未知)"}`);
  console.log(`   可选: ${models.options.join(", ") || "(未检测到)"}\n`);

  if (!models.options.length) {
    console.log("⚠ 未检测到模型选择器，使用默认模型");
    const answer = await askAndGetResponse(client, question);
    console.log(`\n📋 默认模型回复:\n${"=".repeat(50)}\n${answer}\n${"=".repeat(50)}`);
    client.close();
    return;
  }

  // Apply model filter if specified
  if (filterModels.length) {
    const filtered = models.options.filter(o => filterModels.some(f => o.toLowerCase().includes(f.toLowerCase())));
    if (filtered.length) {
      console.log(`🎯 筛选模型: ${filtered.join(", ")}\n`);
      models.options = filtered;
    } else {
      console.log(`⚠ 未匹配到指定模型，使用全部\n`);
    }
  }

  // 5. Ask each model
  const results = [];
  for (let i = 0; i < models.options.length; i++) {
    const model = models.options[i];
    console.log(`🔄 [${i + 1}/${models.options.length}] ${model}`);

    // Switch if current model doesn't match (handles first iteration too)
    if (i > 0 || models.current !== model) {
      await switchModel(client, model);
      await sleep(2000);
    }

    process.stdout.write("   ⏳ 等待回复");
    const answer = await askAndGetResponse(client, question, () => process.stdout.write("."));
    process.stdout.write("\n");
    results.push({ model, answer });
    console.log(`   ✅ ${answer.length} 字`);
  }

  // 6. Analyze, compare, and save
  const fs = require("fs");
  const outFile = "/tmp/cdp-results.json";
  fs.writeFileSync(outFile, JSON.stringify({ question, results, timestamp: new Date().toISOString() }, null, 2), "utf-8");

  printComparisonTable(question, results);
  console.log(`\n💾 结果已保存: ${outFile}`);
  client.close();
}

// ============================================================
// Comparison / Table rendering
// ============================================================
function printComparisonTable(question, results) {
  const n = results.length;
  if (n === 0) return;

  // Split answers into labeled sections
  const parseSections = (text) => {
    const sections = [];
    // Split by lines first
    const lines = text.split(/\n/).map(l => l.trim()).filter(l => l.length > 3);
    for (const line of lines) {
      // Try to extract "label：content" or "label: content" pattern
      const m = line.match(/^([^：:\n]{2,30})[：:]\s*(.+)/);
      if (m) {
        sections.push({ label: m[1].trim(), content: m[2].trim() });
      } else {
        sections.push({ label: null, content: line });
      }
    }
    // If no labeled sections found, treat whole answer as one block
    if (!sections.some(s => s.label)) {
      return [{ label: "回复", content: text }];
    }
    return sections;
  };

  const allSections = results.map(r => ({ model: r.model, sections: parseSections(r.answer) }));
  const maxSections = Math.max(...allSections.map(r => r.sections.length), 1);

  // Determine column count and widths
  const termWidth = process.stdout.columns || 120;
  const labelW = 20;
  const modelW = Math.max(25, Math.floor((termWidth - labelW - 3 * (n + 1)) / n));

  // Header
  const sep = "=".repeat(labelW + (modelW + 3) * n + 3);
  console.log(`\n${sep}`);
  console.log(`📋 模型对比汇总 — "${question}"`);
  console.log(sep);

  // Column headers
  const pad = (s, w) => {
    let visual = 0;
    for (const ch of s) {
      visual += /[一-鿿　-〿＀-￯]/.test(ch) ? 2 : 1;
    }
    const padding = Math.max(0, w - visual);
    return s + " ".repeat(padding);
  };
  const hdr = pad("维度", labelW) + " | " + allSections.map(r => pad(r.model, modelW)).join(" | ");
  console.log(hdr);
  console.log("-".repeat(hdr.length));

  // Collect labels across models for alignment
  const rowLabels = [];
  for (let i = 0; i < maxSections; i++) {
    const labels = allSections.map(r => r.sections[i]?.label).filter(Boolean);
    // Pick the most common label, or first one
    const bestLabel = labels[0] || `要点${i + 1}`;
    rowLabels.push(bestLabel);
  }

  // Print rows
  for (let i = 0; i < maxSections; i++) {
    const cells = [pad(rowLabels[i], labelW)];
    for (const r of allSections) {
      const s = r.sections[i];
      cells.push(pad(s ? s.content : "—", modelW));
    }
    console.log(cells.join(" | "));
  }

  // Consensus analysis
  console.log(`\n${"-".repeat(hdr.length)}`);
  if (n >= 2) {
    const similarity = calcSimilarity(results);
    if (similarity >= 70) {
      console.log(`🔗 共识度: ${similarity}% — 各模型高度一致，结论可靠`);
    } else if (similarity >= 40) {
      console.log(`🔗 共识度: ${similarity}% — 基本一致，侧重不同`);
    } else {
      console.log(`🔗 共识度: ${similarity}% — 观点有差异，可交叉参考`);
    }
  }
}

function calcSimilarity(results) {
  if (results.length < 2) return 100;
  const a = results[0].answer, b = results[1].answer;
  if (a === b) return 100;
  if (!a || !b) return 0;
  // Word-level Jaccard with CJK bigram fallback
  const tokenize = (s) => {
    const tokens = new Set();
    // Extract meaningful words (2+ CJK chars, or alphabetic words)
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

  close() { this.ws.close(); }

  static connect(wsUrl) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.onopen = () => resolve(new CDPClient(ws));
      ws.onerror = reject;
    });
  }
}

// ============================================================
// Operations
// ============================================================
async function waitForReady(client) {
  for (let i = 0; i < 30; i++) {
    const r = await client.send("Runtime.evaluate", {
      expression: "document.readyState",
      returnByValue: true,
    });
    if (r.result?.value === "complete") return;
    await sleep(500);
  }
}

async function detectModels(client) {
  // Open dropdown (handles toggle-safety internally)
  await client.send("Runtime.evaluate", {
    expression: `(${openDropdownFn.toString()})()`,
    returnByValue: true,
  });
  await sleep(800);
  // Read
  const r = await client.send("Runtime.evaluate", {
    expression: `(${readDropdownModelsFn.toString()})()`,
    returnByValue: true,
  });
  // Close
  await client.send("Runtime.evaluate", {
    expression: `document.body.click();`,
    returnByValue: true,
  });
  return r.result?.value || { options: [], current: "" };
}

async function switchModel(client, modelName) {
  // Open dropdown (handles toggle-safety internally)
  await client.send("Runtime.evaluate", {
    expression: `(${openDropdownFn.toString()})()`,
    returnByValue: true,
  });
  await sleep(600);
  // Click target
  await client.send("Runtime.evaluate", {
    expression: `(${clickModelFn.toString()})(${JSON.stringify(modelName)})`,
    returnByValue: true,
  });
}

async function askAndGetResponse(client, question, onTick) {
  const r = await client.send("Runtime.evaluate", {
    expression: `(${injectAndSubmitFn.toString()})(${JSON.stringify(question)})`,
    returnByValue: true,
  });
  if (!r.result?.value?.success) {
    return `[发送失败: ${r.result?.value?.error || "未知错误"}]`;
  }

  // Poll for response
  let lastText = "";
  let stable = 0;
  for (let i = 0; i < 120; i++) {
    await sleep(1500);
    const resp = await client.send("Runtime.evaluate", {
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
    if (onTick) onTick();
  }
  return lastText || "[超时]";
}

// ============================================================
// Page-injected functions
// ============================================================
const openDropdownFn = () => {
  // If already open, close first (toggle safety)
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
  // Sider-specific: look for the most recent answer in .answer-markdown-box
  const answerBoxes = document.querySelectorAll('.answer-markdown-box');
  if (answerBoxes.length) {
    const last = answerBoxes[answerBoxes.length - 1];
    const text = (last.textContent || '').trim();
    if (text.length > 5) return { text };
  }

  // Generic AI response selectors
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
