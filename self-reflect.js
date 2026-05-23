#!/usr/bin/env node
// 自我认知提升 — 7 角色多模型参谋
// Usage: node self-reflect.js "我最近在想……"
//        echo "..." | node self-reflect.js
const http = require("http");
const { PROMPTS, PIPELINE_GROUPS } = require("./prompts/self-reflection");

const CDP = "http://localhost:9223";

// Parse args
let userInput = process.argv.slice(2).join(" ").trim();

if (!process.stdin.isTTY) {
  let stdinData = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("readable", () => {
    let chunk;
    while ((chunk = process.stdin.read()) !== null) stdinData += chunk;
  });
  process.stdin.on("end", () => {
    userInput = userInput || stdinData.trim();
    if (!userInput) { usage(); return; }
    main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
  });
} else {
  if (!userInput) { usage(); process.exit(1); }
  main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
}

function usage() {
  console.log('用法: node self-reflect.js "你的困惑或想法"');
  console.log("     echo '...' | node self-reflect.js");
}

async function main() {
  console.log("🧠 自我认知参谋 — 7 角色多模型分析");
  console.log("=".repeat(60));
  console.log("定位：想清楚的脚手架，不是自我认知的裁判");
  console.log("=".repeat(60));
  console.log(`📝 你的输入: ${userInput.slice(0, 80)}${userInput.length > 80 ? "..." : ""}\n`);

  // 1. Connect to Sider
  process.stdout.write("🔍 连接 Sider...");
  const targets = await fetch(`${CDP}/json/list`).then((r) => r.json());
  let siderTab = targets.find((t) => t.url && t.url.includes("sider.ai") && t.type === "page");
  if (!siderTab) {
    siderTab = await fetch(`${CDP}/json/new?${encodeURIComponent("https://sider.ai/")}`).then((r) => r.json());
    await sleep(5000);
  }
  console.log(" 已连接\n");

  const client = await CDPClient.connect(siderTab.webSocketDebuggerUrl);
  await client.send("Runtime.enable");
  await client.send("Page.enable");
  for (let i = 0; i < 30; i++) {
    const r = await client.send("Runtime.evaluate", {
      expression: "document.readyState", returnByValue: true,
    });
    if (r.result?.value === "complete") break;
    await sleep(500);
  }

  // 2. Run pipeline by groups
  const allResults = {};   // key -> { role, model, answer }
  const totalStart = Date.now();

  for (let gi = 0; gi < PIPELINE_GROUPS.length; gi++) {
    const group = PIPELINE_GROUPS[gi];
    const isParallel = group.length > 1;

    if (isParallel) {
      console.log(`┌─ 第 ${gi + 1} 组 (并行) ──────────────────────────────────────────┐`);
      const groupLabel = group.map((k) => PROMPTS[k].role).join(" ∥ ");
      console.log(`│ ${groupLabel}`);
      console.log(`│`);

      // Run all in parallel
      const promises = group.map(async (key) => {
        const cfg = PROMPTS[key];
        const prompt = buildPrompt(key, userInput, allResults);
        const result = await askModel(client, cfg.model, prompt, key);
        return { key, cfg, answer: result.answer, actualModel: result.actualModel };
      });

      const groupResults = await Promise.all(promises);
      for (const { key, cfg, answer, actualModel } of groupResults) {
        allResults[key] = { role: cfg.role, model: actualModel, answer };
        const modelTag = actualModel !== cfg.model ? ` (实际:${actualModel})` : "";
        console.log(`│ ✅ ${cfg.role} (${cfg.model}) — ${answer.length} 字`);
        console.log(`│ 🔧 使用模型: ${actualModel}${modelTag}`);
      }

      console.log(`└──────────────────────────────────────────────────────────┘\n`);
    } else {
      const key = group[0];
      const cfg = PROMPTS[key];
      console.log(`┌─ 第 ${gi + 1} 步: ${cfg.role} (${cfg.model}) ───────────────────────────┐`);

      const prompt = buildPrompt(key, userInput, allResults);
      process.stdout.write(`│ ⏳ 等待回复`);
      const { answer, actualModel } = await askModel(client, cfg.model, prompt, key);
      const modelTag = actualModel !== cfg.model ? ` (实际:${actualModel})` : "";
      console.log(`\n│ ✅ ${answer.length} 字`);

      allResults[key] = { role: cfg.role, model: actualModel, answer };
      console.log(`│ 🔧 使用模型: ${actualModel}${modelTag}`);
      console.log(`└──────────────────────────────────────────────────────────┘\n`);
    }
  }

  const totalEnd = Date.now();

  // 3. Print full report
  console.log("\n" + "=".repeat(60));
  console.log("📋 完整分析报告");
  console.log("=".repeat(60));

  const flatOrder = PIPELINE_GROUPS.flat();
  for (const key of flatOrder) {
    const r = allResults[key];
    console.log(`\n## ${r.role} (${r.model})`);
    console.log("-".repeat(40));
    console.log(r.answer);
  }

  // 4. Save
  const fs = require("fs");
  const outDir = "/tmp/self-reflection";
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = `${outDir}/session-${ts}.json`;
  fs.writeFileSync(outFile, JSON.stringify({
    input: userInput,
    timestamp: new Date().toISOString(),
    duration_seconds: Math.round((totalEnd - totalStart) / 1000),
    results: flatOrder.map((k) => allResults[k]),
  }, null, 2), "utf-8");

  console.log(`\n${"=".repeat(60)}`);
  console.log(`⏱  总耗时: ${Math.round((totalEnd - totalStart) / 1000)} 秒`);
  console.log(`💾 已保存: ${outFile}`);
  console.log(`\n💡 建议: 过两三周回来重读这份报告，看看自己的认知有没有变化。`);
  console.log(`   记下"我当时是怎么看这件事的"，然后问自己：现在还这么想吗？`);
  console.log(`   哪个角色的视角后来被证明最有用？`);
  client.close();
}

// ============================================================
// Build context-aware prompt for each role
// ============================================================
function buildPrompt(key, userInput, allResults) {
  const cfg = PROMPTS[key];
  let prompt = cfg.system;

  // Determine which previous results this role should see
  const prevKeys = getPreviousKeys(key);

  if (prevKeys.length > 0) {
    prompt += `\n\n下面是对方的原始困惑：\n"""\n${userInput}\n"""\n\n`;
    prompt += `前面角色的分析如下，请在此基础上完成你的角色任务：\n\n`;
    for (const pk of prevKeys) {
      if (allResults[pk]) {
        prompt += `### ${allResults[pk].role}的回应:\n${allResults[pk].answer}\n\n`;
      }
    }
  } else {
    prompt += `\n\n对方的困惑如下，请按你的角色任务回应：\n"""\n${userInput}\n"""`;
  }

  return prompt;
}

function getPreviousKeys(targetKey) {
  const flat = PIPELINE_GROUPS.flat();
  const idx = flat.indexOf(targetKey);
  if (idx <= 0) return [];
  return flat.slice(0, idx);
}

// ============================================================
// Ask a specific model (each call starts a fresh chat)
// ============================================================
async function askModel(client, modelName, prompt, label) {
  let actualModel = modelName; // Track actual model used (may differ if switch fails)

  // 1. Navigate to Sider fresh (more reliable than Page.reload for SPAs)
  await client.send("Page.navigate", { url: "https://sider.ai/" });
  // Wait for page to settle
  await sleep(4000);
  for (let i = 0; i < 30; i++) {
    const r = await client.send("Runtime.evaluate", {
      expression: "document.readyState", returnByValue: true,
    });
    if (r.result?.value === "complete") break;
    await sleep(500);
  }
  // Wait for SPA hydration — poll for textarea to appear
  for (let i = 0; i < 20; i++) {
    const ok = await client.send("Runtime.evaluate", {
      expression: `(${findInputFn})()`, returnByValue: true,
    });
    if (ok.result?.value) break;
    await sleep(800);
  }

  // 2. Detect available models from the dropdown
  await client.send("Runtime.evaluate", {
    expression: `(${openDropdownFn})()`, returnByValue: true,
  });
  await sleep(800);
  const m = await client.send("Runtime.evaluate", {
    expression: `(${readDropdownFn})()`, returnByValue: true,
  });
  await client.send("Runtime.evaluate", {
    expression: "document.body.click();", returnByValue: true,
  });

  let availableModels = m.result?.value?.options || [];

  // Search function (used for retry with scrolling)
  function findModel(models, name) {
    for (const avail of models) {
      if (avail.toLowerCase().includes(name.toLowerCase())) return avail;
    }
    const parts = name.toLowerCase().split(/[\s.]+/);
    for (const avail of models) {
      if (parts.every((p) => avail.toLowerCase().includes(p))) return avail;
    }
    return null;
  }

  let targetModel = findModel(availableModels, modelName);

  // If not found, scroll the dropdown to reveal more models (virtual scroll page 2)
  if (!targetModel) {
    await client.send("Runtime.evaluate", {
      expression: `(${openDropdownFn})()`, returnByValue: true,
    });
    await sleep(600);
    // Scroll dropdown to bottom to load page 2
    await client.send("Runtime.evaluate", {
      expression: `(${scrollDropdownFn})()`, returnByValue: true,
    });
    await sleep(1200);
    // Re-read
    const m2 = await client.send("Runtime.evaluate", {
      expression: `(${readDropdownFn})()`, returnByValue: true,
    });
    await client.send("Runtime.evaluate", {
      expression: "document.body.click();", returnByValue: true,
    });
    const moreModels = m2.result?.value?.options || [];
    // Only use new unique models
    const seen = new Set(availableModels);
    for (const mm of moreModels) {
      if (!seen.has(mm)) {
        seen.add(mm);
        availableModels.push(mm);
      }
    }
    targetModel = findModel(availableModels, modelName);
  }

  if (targetModel) {
    // Try up to 3 times to switch model (sometimes the dropdown click doesn't register)
    let switched = false;
    let currentModel = "";
    for (let attempt = 0; attempt < 3 && !switched; attempt++) {
      // Always close first (dropdown might still be open from scanning)
      await client.send("Runtime.evaluate", {
        expression: "document.body.click();", returnByValue: true,
      });
      await sleep(400);

      await client.send("Runtime.evaluate", {
        expression: `(${openDropdownFn})()`, returnByValue: true,
      });
      await sleep(600);

      // Click with both native .click() and dispatchEvent to ensure Sider sees it
      await client.send("Runtime.evaluate", {
        expression: `(${clickModelFn})(${JSON.stringify(targetModel)})`,
        returnByValue: true,
      });
      await sleep(1200);

      // Verify the model actually switched
      const verify = await client.send("Runtime.evaluate", {
        expression: `(function() {
          var btn = document.querySelector(".model-btn");
          var current = btn ? (btn.textContent || "").trim() : "";
          return current;
        })()`,
        returnByValue: true,
      });
      currentModel = verify.result?.value || "";

      // Check if switched (exact or fuzzy match)
      if (currentModel === targetModel) {
        switched = true;
      } else if (currentModel && targetModel) {
        // Fuzzy: check if the key parts of target model appear in current
        const targetParts = targetModel.toLowerCase().split(/[\s.]+/).filter(p => p.length > 1);
        const matchCount = targetParts.filter(p => currentModel.toLowerCase().includes(p)).length;
        if (matchCount >= targetParts.length * 0.7) switched = true;
      }

      if (!switched && attempt < 2) {
        process.stdout.write(`[重试切换: ${currentModel} → ${targetModel}]`);
      }
    }

    if (!switched) {
      actualModel = currentModel || modelName;
      process.stdout.write(`[⚠ 模型切换未确认,继续用当前模型]`);
    } else {
      actualModel = currentModel || targetModel;
    }
  }

  // Wait for input to appear (SPA hydration after model switch)
  for (let i = 0; i < 20; i++) {
    const check = await client.send("Runtime.evaluate", {
      expression: `(${findInputFn})()`,
      returnByValue: true,
    });
    if (check.result?.value) break;
    await sleep(500);
  }

  // Inject and submit
  const r = await client.send("Runtime.evaluate", {
    expression: `(${injectAndSubmitFn})(${JSON.stringify(prompt)})`,
    returnByValue: true,
  });
  if (!r.result?.value?.success) {
    return { answer: `[发送失败: ${r.result?.value?.error || "未知错误"}]`, actualModel };
  }

  // Wait for response
  let lastText = "";
  let stable = 0;
  for (let i = 0; i < 180; i++) {
    await sleep(2000);
    const resp = await client.send("Runtime.evaluate", {
      expression: `(${extractFn})(${JSON.stringify(prompt)})`,
      returnByValue: true,
    });
    const text = resp.result?.value?.text || "";
    if (text && text === lastText) {
      stable++;
      if (stable >= 3) return { answer: text, actualModel };
    } else if (text) {
      lastText = text;
      stable = 0;
    }
    if (i % 5 === 0) process.stdout.write(".");
  }
  return { answer: lastText || "[超时]", actualModel };
}

// ============================================================
// Page-injected functions (self-contained, serializable)
// ============================================================
const scrollDropdownFn = function scrollModelDropdown() {
  // Scroll the model dropdown to reveal more items (page 2)
  var container = document.querySelector('.custom-scrollbar.custom-scrollbar-float');
  if (container) {
    // Scroll in steps to trigger virtual list rendering
    var step = Math.floor(container.scrollHeight / 3);
    container.scrollTop = step;
    setTimeout(function() { container.scrollTop = step * 2; }, 200);
    setTimeout(function() { container.scrollTop = container.scrollHeight; }, 400);
  }
};

const findInputFn = function findInput() {
  var candidates = [
    "textarea", "[contenteditable='true']", ".ProseMirror",
    '[role="textbox"]', "#prompt-textarea", "div[data-placeholder]",
    "form textarea", ".chat-input textarea",
  ];
  for (var i = 0; i < candidates.length; i++) {
    var el = document.querySelector(candidates[i]);
    if (el && el.offsetParent !== null) return true;
  }
  var allTA = document.querySelectorAll("textarea");
  for (var j = 0; j < allTA.length; j++) {
    if (allTA[j].offsetParent !== null) return true;
  }
  return false;
};

const openDropdownFn = function openModelDropdown() {
  var btns = document.querySelectorAll(".model-btn");
  for (var i = 0; i < btns.length; i++) {
    var t = (btns[i].textContent || "").trim();
    if (t.length > 0 && t.length < 20) { btns[i].click(); return; }
  }
  if (btns.length) btns[0].click();
};

const readDropdownFn = function readModelDropdown() {
  var currentBtn = document.querySelector(".model-btn");
  var current = (currentBtn ? currentBtn.textContent : "").trim();
  var seen = {};
  var options = [];
  var items = document.querySelectorAll(".model-title");
  for (var i = 0; i < items.length; i++) {
    var text = (items[i].textContent || "").trim();
    if (text.length >= 2 && !seen[text]) { seen[text] = true; options.push(text); }
  }
  return { options: options, current: current };
};

const clickModelFn = function clickModel(name) {
  var items = document.querySelectorAll(".model-title");
  for (var i = 0; i < items.length; i++) {
    if ((items[i].textContent || "").trim() === name) {
      var el = items[i];
      // Dispatch full mouse event sequence for framework event delegation
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      // Also native click as fallback
      el.click();
      // Click parent too (some frameworks delegate to wrapper)
      if (el.parentElement) el.parentElement.click();
      return;
    }
  }
};

const injectAndSubmitFn = function injectAndSubmit(text) {
  var input = null;
  var candidates = [
    "textarea", "[contenteditable='true']", ".ProseMirror",
    '[role="textbox"]', "#prompt-textarea", "div[data-placeholder]",
    "form textarea", ".chat-input textarea",
  ];
  for (var i = 0; i < candidates.length; i++) {
    input = document.querySelector(candidates[i]);
    if (input && input.offsetParent !== null) break;
    input = null;
  }
  if (!input) {
    var allTA = document.querySelectorAll("textarea");
    for (var j = 0; j < allTA.length; j++) {
      if (allTA[j].offsetParent !== null) { input = allTA[j]; break; }
    }
  }
  if (!input) return { success: false, error: "找不到输入框" };

  var isCE = input.getAttribute("contenteditable") === "true" ||
    input.classList.contains("ProseMirror") ||
    input.getAttribute("role") === "textbox";
  if (isCE) {
    input.focus();
    input.textContent = text;
    input.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    var proto = input.tagName === "TEXTAREA"
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    var tracker = input._valueTracker;
    if (tracker) { tracker.setValue(""); tracker.setValue(text); }
    input.focus();
  }

  setTimeout(function () {
    var sendBtn = null;
    var btnCandidates = [
      "button[type='submit']", "button[aria-label*='send' i]",
      "button[aria-label*='Send']", "form button", "form [type='submit']",
      ".send-btn", "#send-button", "#submit-button",
    ];
    for (var k = 0; k < btnCandidates.length; k++) {
      sendBtn = document.querySelector(btnCandidates[k]);
      if (sendBtn && sendBtn.offsetParent !== null) break;
      sendBtn = null;
    }
    if (sendBtn) {
      sendBtn.click();
    } else {
      input.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true,
      }));
    }
  }, 400);

  return { success: true };
};

const extractFn = function extractResponse(sentText) {
  var answerBoxes = document.querySelectorAll(".answer-markdown-box");
  if (answerBoxes.length) {
    var last = answerBoxes[answerBoxes.length - 1];
    var text = (last.textContent || "").trim();
    if (text.length > 5) return { text: text };
  }
  var aiSelectors = [
    ".ai-response", ".assistant-message", ".bot-message", ".response-text",
    '[class*="assistant"]', '[class*="response"]', '[class*="answer"]',
    '[class*="bot"]', '[class*="ai-"]', ".markdown-body", ".prose",
    '[data-role="assistant"]', '[data-message-role="assistant"]',
    ".message.assistant", ".message.ai", ".chat-message.assistant",
  ];
  var respEl = null;
  for (var i = 0; i < aiSelectors.length; i++) {
    var els = document.querySelectorAll(aiSelectors[i]);
    if (els.length) respEl = els[els.length - 1];
    if (respEl) break;
  }
  if (respEl) return { text: (respEl.textContent || "").trim() };

  var mainSel = ["main", ".chat-content", ".conversation", ".messages", '[role="log"]', '[role="list"]'];
  var main = null;
  for (var j = 0; j < mainSel.length; j++) {
    main = document.querySelector(mainSel[j]);
    if (main) break;
  }
  if (!main) main = document.body;
  var all = main.querySelectorAll("p, div, li, pre, code, h1, h2, h3, h4, h5, h6, span");
  var best = "";
  for (var k = 0; k < all.length; k++) {
    var t2 = (all[k].textContent || "").trim();
    if (t2.length > best.length && t2.length > 50 &&
        t2 !== (sentText || "").trim() &&
        !all[k].closest("form, [role='form'], .input-area, .composer, .send-box, textarea, .prompt-box, nav, header, footer, [class*='sidebar'], [class*='toolbar']")) {
      best = t2;
    }
  }
  return { text: best };
};

// ============================================================
// CDP Client
// ============================================================
class CDPClient {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this._connected = true;
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg.result || msg.error);
        this.pending.delete(msg.id);
      }
    };
    ws.onclose = () => {
      this._connected = false;
      for (const [, reject] of this.pending) reject(new Error("CDP closed"));
      this.pending.clear();
    };
    ws.onerror = () => { this._connected = false; };
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this._connected) return reject(new Error("CDP not connected"));
      const id = ++this.id;
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { this._connected = false; this.ws.close(); }
  static connect(wsUrl) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.onopen = () => resolve(new CDPClient(ws));
      ws.onerror = reject;
    });
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
