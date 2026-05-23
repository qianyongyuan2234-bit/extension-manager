const SELF_ID = chrome.runtime.id;

// ---- state ----
let allExtensions = [];
let profiles = {};
let autoPollTimer = null;

// ---- bridge polling: check if CLI has a pending command ----
function setBridgeBar(state, text) {
  const bar = document.getElementById("bridge-bar");
  const span = document.getElementById("bridge-text");
  bar.className = "bridge-bar " + state;
  bar.classList.remove("hidden");
  span.textContent = text;
}

async function checkBridge() {
  try {
    const resp = await fetch("http://127.0.0.1:8766/command?_=" + Date.now(), { cache: "no-store" });
    if (!resp.ok) { setBridgeBar("disconnected", "桥接无响应 (HTTP " + resp.status + ")"); return; }
    const cmd = await resp.json();
    if (cmd.status !== "pending") { setBridgeBar("connected", "桥接已连接，无待执行命令"); return; }

    // Got a command — auto-execute
    setBridgeBar("executing", "执行中: " + cmd.question.slice(0, 40));
    switchTab("sider");
    showStatus("检测到 CLI 命令: " + cmd.question.slice(0, 50), "info");
    document.getElementById("sider-input").value = cmd.question;

    // Run multi-model flow
    await executeBridgeCommand(cmd.question, cmd.models || []);
    setBridgeBar("connected", "桥接已连接，执行完毕");
  } catch (e) {
    setBridgeBar("disconnected", "桥接未连接 (CLI 未启动)");
  }
}

async function executeBridgeCommand(question, modelList) {
  const siderUrl = getSiderUrl();
  const inputSel = getSiderSelector();
  const sendBtnSel = document.getElementById("sider-send-btn-sel").value.trim();

  hideResponse();
  setBridgeButtonsEnabled(false);

  // Ensure Sider tab exists and is ready
  const tab = await ensureSiderTab(siderUrl, true);
  if (!tab) {
    showStatus("无法打开 Sider 页面", "error");
    setBridgeButtonsEnabled(true);
    return;
  }
  await waitForTabLoad(tab.id);
  await sleep(1500);

  // Detect models if none specified
  if (modelList.length === 0) {
    try {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const modelNames = ["GPT-4", "Claude", "Gemini", "Llama", "Mistral", "Grok", "DeepSeek", "o1", "o3", "opus", "sonnet", "haiku"];
          const all = document.querySelectorAll("button, [role='option'], [role='button'], select option, .item, .option, [class*='model'], [class*='Model'], li");
          const seen = new Set();
          const options = [];
          for (const el of all) {
            const text = (el.textContent || "").trim();
            if (text.length < 2 || text.length > 40 || seen.has(text)) continue;
            for (const name of modelNames) {
              if (text.toLowerCase().includes(name.toLowerCase())) { seen.add(text); options.push(text); break; }
            }
          }
          return [...options];
        },
      });
      modelList = r?.result || ["__default__"];
    } catch { modelList = ["__default__"]; }
    if (modelList.length === 0) modelList = ["__default__"];
  }

  const results = [];
  for (let i = 0; i < modelList.length; i++) {
    const model = modelList[i];
    showProgress(true, `[${i + 1}/${modelList.length}] 切换到: ${model}`);

    if (model !== "__default__") {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (name) => {
            const all = document.querySelectorAll("button, [role='option'], [role='button'], li, .item, .option, [class*='model'], [class*='Model']");
            for (const el of all) {
              if ((el.textContent || "").trim() === name) {
                if (el.tagName === "OPTION") { el.selected = true; el.parentElement.dispatchEvent(new Event("change", { bubbles: true })); return; }
                if (el.offsetParent !== null) { el.click(); return; }
              }
            }
            const triggers = document.querySelectorAll("[class*='model-select'], [class*='ModelSelect'], [class*='model-switch'], [class*='model-picker']");
            for (const t of triggers) { if (t.offsetParent !== null) { t.click(); break; } }
            setTimeout(() => {
              const items = document.querySelectorAll("button, [role='option'], li, .item");
              for (const item of items) { if ((item.textContent || "").trim() === name) { item.click(); break; } }
            }, 600);
          },
          args: [model],
        });
        await sleep(2000);
      } catch {}
    }

    showProgress(true, `[${i + 1}/${modelList.length}] 等待 ${model} 回复...`);
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: injectAndSubmitFn,
        args: [question, inputSel, sendBtnSel],
      });
    } catch (e) { results.push({ model, answer: "[发送失败: " + e.message + "]" }); continue; }

    const answer = await pollForResponseFromTab(tab.id, question);
    results.push({ model, answer });
    showProgress(true, `[${i + 1}/${modelList.length}] ${model} 完成`);
  }

  // Post results to bridge
  showProgress(false);
  showResponse(results.map(r => `🤖 ${r.model}\n${r.answer}`).join("\n\n---\n\n"));
  showStatus("已完成 " + results.length + " 个模型", "success");

  try {
    await fetch("http://127.0.0.1:8766/result", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, results }),
    });
  } catch {}

  setBridgeButtonsEnabled(true);
}

function setBridgeButtonsEnabled(enabled) {
  const b = document.getElementById("sider-auto");
  if (b) b.disabled = !enabled;
}

async function pollForResponseFromTab(tabId, sentText) {
  let lastText = "";
  let stableCount = 0;
  for (let i = 0; i < 120; i++) {
    await sleep(1500);
    try {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (sent) => {
          const areaSel = [".chat-content", ".conversation", ".messages", ".chat-messages", '[role="log"]', '[role="list"]', "main", ".response", ".ai-response", ".assistant-message", ".markdown-body", ".prose", ".chat-area"];
          let area = null;
          for (const s of areaSel) { area = document.querySelector(s); if (area) break; }
          if (!area) area = document.body;
          const blocks = area.querySelectorAll("p, div, span, li, pre, code, h1, h2, h3, h4, h5, h6, td, th");
          const texts = [];
          for (const b of blocks) {
            const t = (b.textContent || "").trim();
            if (t && t.length > 20) {
              if (b.closest("form, [role='form'], .input-area, .composer, .send-box, textarea, .prompt-box")) continue;
              if (t.trim() === sent.trim()) continue;
              texts.push(t);
            }
          }
          const unique = [];
          for (const t of texts) {
            let subset = false;
            for (let j = 0; j < unique.length; j++) {
              if (unique[j].includes(t)) { subset = true; break; }
              if (t.includes(unique[j])) { unique[j] = t; subset = true; break; }
            }
            if (!subset) unique.push(t);
          }
          return unique.join("\n\n");
        },
        args: [sentText],
      });
      const text = r?.result || "";
      if (text && text === lastText) { stableCount++; if (stableCount >= 4) return text; }
      else if (text) { lastText = text; stableCount = 0; }
    } catch { return lastText || "[poll error]"; }
  }
  return lastText || "[timeout]";
}

const injectAndSubmitFn = (msg, inputSelector, sendBtnSelector) => {
  let input = null;
  if (inputSelector) input = document.querySelector(inputSelector);
  if (!input) {
    const candidates = ["textarea", "[contenteditable='true']", ".ProseMirror", '[role="textbox"]', "#prompt-textarea", "div[data-placeholder]", "form textarea", ".chat-input textarea"];
    for (const sel of candidates) { input = document.querySelector(sel); if (input && input.offsetParent !== null) break; input = null; }
    if (!input) { const allTA = document.querySelectorAll("textarea"); for (const ta of allTA) { if (ta.offsetParent !== null) { input = ta; break; } } }
  }
  if (!input) return;

  const isCE = input.getAttribute("contenteditable") === "true" || input.classList.contains("ProseMirror") || input.getAttribute("role") === "textbox";
  if (isCE) {
    input.focus(); input.textContent = msg;
    input.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    const proto = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(input, msg);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    const tracker = input._valueTracker; if (tracker) { tracker.setValue(""); tracker.setValue(msg); }
    input.focus();
  }

  setTimeout(() => {
    const btnCandidates = ["button[type='submit']", "button[aria-label*='send' i]", "button[aria-label*='Send']", "form button", "form [type='submit']", ".send-btn", "#send-button", "#submit-button"];
    let btn = null;
    for (const sel of btnCandidates) { btn = document.querySelector(sel); if (btn && btn.offsetParent !== null) break; btn = null; }
    if (btn) { btn.click(); } else {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
    }
  }, 400);
};

// ---- init ----
document.addEventListener("DOMContentLoaded", async () => {
  await loadProfiles();
  await refreshList();
  renderProfileSelect();
  loadSiderSettings();

  // Auto-detect CLI bridge command
  checkBridge();

  // tab switching
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });

  // extension panel events
  document.getElementById("search").addEventListener("input", renderList);
  document.getElementById("profile-btn").addEventListener("click", toggleProfileBar);
  document.getElementById("profile-apply").addEventListener("click", applyProfile);
  document.getElementById("profile-save").addEventListener("click", openSaveModal);
  document.getElementById("profile-cancel").addEventListener("click", closeSaveModal);
  document.getElementById("profile-confirm").addEventListener("click", saveProfile);

  // sider panel events
  document.getElementById("sider-send").addEventListener("click", sendToSider);
  document.getElementById("sider-auto").addEventListener("click", sendAndWaitForReply);
  document.getElementById("sider-detect").addEventListener("click", detectSiderInput);
  document.getElementById("sider-detect-send").addEventListener("click", detectSiderSendBtn);
  document.getElementById("sider-copy-resp").addEventListener("click", copyResponse);
  document.getElementById("sider-url").addEventListener("change", saveSiderSettings);
  document.getElementById("sider-selector").addEventListener("change", saveSiderSettings);
  document.getElementById("sider-send-btn-sel").addEventListener("change", saveSiderSettings);
  document.querySelectorAll("[data-fill]").forEach((btn) => {
    btn.addEventListener("click", quickFill);
  });

  // live reload when extensions change
  chrome.management.onEnabled.addListener(refreshList);
  chrome.management.onDisabled.addListener(refreshList);
  chrome.management.onInstalled.addListener(refreshList);
  chrome.management.onUninstalled.addListener(refreshList);

  // restore any cached response
  const cached = await chrome.storage.local.get("lastResponse");
  if (cached.lastResponse) {
    showResponse(cached.lastResponse);
  }
});

function switchTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.getElementById("panel-extensions").classList.toggle("hidden", name !== "extensions");
  document.getElementById("panel-sider").classList.toggle("hidden", name !== "sider");
}

// ---- data ----
async function refreshList() {
  allExtensions = await chrome.management.getAll();
  allExtensions.sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  renderList();
}

function renderList() {
  const query = document.getElementById("search").value.toLowerCase();
  const filtered = allExtensions.filter((ext) =>
    ext.name.toLowerCase().includes(query)
  );

  const list = document.getElementById("list");
  document.getElementById("count").textContent = filtered.length;

  list.innerHTML = "";

  filtered.forEach((ext) => {
    const isSelf = ext.id === SELF_ID;
    const item = document.createElement("li");
    item.className = `ext-item${ext.enabled ? "" : " disabled"}`;

    item.innerHTML = `
      <img class="ext-icon" src="${ext.icons?.[0]?.url || getDefaultIcon(ext)}"
           alt="" onerror="this.style.display='none'">
      <div class="ext-info">
        <div class="ext-name">${escapeHtml(ext.name)}</div>
        ${ext.description ? `<div class="ext-desc">${escapeHtml(ext.description)}</div>` : ""}
      </div>
      <div class="ext-actions">
        ${ext.optionsUrl ? `<button data-action="options" data-id="${ext.id}" title="选项">选项</button>` : ""}
        <button data-action="details" data-id="${ext.id}" title="详情">详情</button>
        ${isSelf ? "" : renderToggle(ext)}
      </div>
    `;

    list.appendChild(item);
  });

  list.querySelectorAll("input[type=checkbox]").forEach((cb) => {
    cb.addEventListener("change", onToggle);
  });
  list.querySelectorAll("button[data-action]").forEach((btn) => {
    btn.addEventListener("click", onAction);
  });
}

function renderToggle(ext) {
  return `
    <label class="toggle">
      <input type="checkbox" data-id="${ext.id}" ${ext.enabled ? "checked" : ""}>
      <span class="slider"></span>
    </label>`;
}

function getDefaultIcon(ext) {
  if (ext.type === "theme") return "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%238757b5'/%3E%3Ctext x='16' y='22' text-anchor='middle' font-size='18' fill='white'%3E🎨%3C/text%3E%3C/svg%3E";
  return "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%234a90d9'/%3E%3Ctext x='16' y='22' text-anchor='middle' font-size='18' fill='white'%3E🧩%3C/text%3E%3C/svg%3E";
}

// ---- actions ----
async function onToggle(e) {
  const id = e.target.dataset.id;
  const enabled = e.target.checked;
  try {
    await chrome.management.setEnabled(id, enabled);
  } catch (err) {
    e.target.checked = !enabled;
    console.error("切换失败:", err);
  }
}

function onAction(e) {
  const id = e.target.dataset.id;
  const ext = allExtensions.find((x) => x.id === id);
  if (!ext) return;

  if (e.target.dataset.action === "options" && ext.optionsUrl) {
    chrome.tabs.create({ url: ext.optionsUrl });
  } else if (e.target.dataset.action === "details") {
    chrome.tabs.create({ url: `chrome://extensions/?id=${id}` });
  }
}

// ---- profiles ----
async function loadProfiles() {
  const data = await chrome.storage.sync.get("profiles");
  profiles = data.profiles || {};
}

async function saveProfiles() {
  await chrome.storage.sync.set({ profiles });
}

function renderProfileSelect() {
  const sel = document.getElementById("profile-select");
  sel.innerHTML = '<option value="">-- 选择场景 --</option>';
  Object.keys(profiles).forEach((name) => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  });
}

async function applyProfile() {
  const name = document.getElementById("profile-select").value;
  if (!name || !profiles[name]) return;

  const states = profiles[name];
  const batch = Object.entries(states).map(([id, enabled]) => {
    if (id === SELF_ID) return Promise.resolve();
    return chrome.management.setEnabled(id, enabled).catch(() => {});
  });
  await Promise.all(batch);
  await refreshList();
}

function openSaveModal() {
  document.getElementById("profile-modal").classList.remove("hidden");
  document.getElementById("profile-name").focus();
}

function closeSaveModal() {
  document.getElementById("profile-modal").classList.add("hidden");
  document.getElementById("profile-name").value = "";
}

async function saveProfile() {
  const name = document.getElementById("profile-name").value.trim();
  if (!name) return;

  const states = {};
  allExtensions.forEach((ext) => {
    states[ext.id] = ext.enabled;
  });
  profiles[name] = states;
  await saveProfiles();
  renderProfileSelect();
  closeSaveModal();
}

function toggleProfileBar() {
  document.getElementById("profile-bar").classList.toggle("hidden");
}

// ---- sider settings ----
function loadSiderSettings() {
  chrome.storage.local.get(["siderUrl", "siderSelector", "siderSendBtnSel"], (data) => {
    if (data.siderUrl) document.getElementById("sider-url").value = data.siderUrl;
    if (data.siderSelector) document.getElementById("sider-selector").value = data.siderSelector;
    if (data.siderSendBtnSel) document.getElementById("sider-send-btn-sel").value = data.siderSendBtnSel;
  });
}

function saveSiderSettings() {
  chrome.storage.local.set({
    siderUrl: document.getElementById("sider-url").value,
    siderSelector: document.getElementById("sider-selector").value,
    siderSendBtnSel: document.getElementById("sider-send-btn-sel").value,
  });
}

// ---- quick fill ----
async function quickFill(e) {
  const type = e.target.dataset.fill;
  const textarea = document.getElementById("sider-input");

  if (type === "clipboard") {
    try {
      const text = await navigator.clipboard.readText();
      textarea.value = text;
    } catch {
      showStatus("无法读取剪贴板，请手动粘贴", "error");
    }
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) { showStatus("无法获取当前标签页", "error"); return; }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (action) => {
        if (action === "selected-text") return window.getSelection()?.toString() || "";
        if (action === "current-page") {
          const title = document.title || "";
          const url = location.href;
          const sel = window.getSelection()?.toString() || "";
          const article = document.querySelector("article, main, .content, .post-content, #content");
          const bodyText = (article || document.body).innerText.slice(0, 3000);
          return `页面标题: ${title}\nURL: ${url}${sel ? `\n选中文字: ${sel}` : ""}\n\n内容摘要:\n${bodyText}`;
        }
        return "";
      },
      args: [type],
    });
    if (results?.[0]?.result) {
      textarea.value = results[0].result;
    }
  } catch (err) {
    if (type === "selected-text") {
      try {
        const text = await navigator.clipboard.readText();
        textarea.value = text;
        showStatus("此页面无法直接读取选中文字，已从剪贴板读取", "info");
      } catch {
        showStatus("此页面无脚本权限且剪贴板为空", "error");
      }
    } else {
      const tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
      textarea.value = `页面标题: ${tab.title}\nURL: ${tab.url}`;
    }
  }
}

// ---- sider: send only ----
async function sendToSider() {
  const text = document.getElementById("sider-input").value.trim();
  if (!text) { showStatus("请先输入要发送的内容", "error"); return; }

  const siderUrl = getSiderUrl();
  const selector = getSiderSelector();

  showStatus("正在打开 Sider...", "info");

  const tab = await ensureSiderTab(siderUrl, false);
  if (!tab) { showStatus("无法打开 Sider 页面", "error"); return; }

  await waitForTabLoad(tab.id);

  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: injectTextOnly,
      args: [text, selector],
    });

    if (result?.[0]?.result?.success) {
      showStatus(`已填入 (${result[0].result.method})，请手动发送`, "success");
    } else {
      showStatus(result?.[0]?.result?.error || "填入失败，请手动粘贴并发送", "error");
    }
  } catch (err) {
    showStatus("注入失败: " + err.message, "error");
  }
}

// ---- sider: send and wait for reply ----
async function sendAndWaitForReply() {
  const text = document.getElementById("sider-input").value.trim();
  if (!text) { showStatus("请先输入要发送的内容", "error"); return; }

  const siderUrl = getSiderUrl();
  const inputSel = getSiderSelector();
  const sendBtnSel = document.getElementById("sider-send-btn-sel").value.trim();

  // cancel previous poll
  if (autoPollTimer) { clearInterval(autoPollTimer); autoPollTimer = null; }

  showProgress(true, "正在打开 Sider...");
  hideResponse();

  const tab = await ensureSiderTab(siderUrl, true);
  if (!tab) { showStatus("无法打开 Sider 页面", "error"); showProgress(false); return; }

  await waitForTabLoad(tab.id);
  showProgress(true, "正在注入问题...");

  // step 1: inject text and click send
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: injectTextAndSubmit,
      args: [text, inputSel, sendBtnSel],
    });

    if (!result?.[0]?.result?.success) {
      showStatus(result?.[0]?.result?.error || "发送失败", "error");
      showProgress(false);
      return;
    }

    showStatus("已发送，等待 AI 回复...", "info");
    showProgress(true, "等待 AI 回复中...");
  } catch (err) {
    showStatus("注入失败: " + err.message, "error");
    showProgress(false);
    return;
  }

  // step 2: poll for response
  let pollCount = 0;
  const MAX_POLLS = 120; // 2 minutes at 1s intervals
  let lastText = "";
  let stableCount = 0;

  autoPollTimer = setInterval(async () => {
    pollCount++;

    try {
      const result = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: checkForResponse,
        args: [text],
      });

      const resp = result?.[0]?.result;
      if (resp?.error) {
        clearInterval(autoPollTimer);
        autoPollTimer = null;
        showStatus(resp.error, "error");
        showProgress(false);
        return;
      }

      const currentText = resp?.text || "";

      if (currentText && currentText === lastText) {
        stableCount++;
        // 3 consecutive same readings = done
        if (stableCount >= 3) {
          clearInterval(autoPollTimer);
          autoPollTimer = null;
          showProgress(false);
          showStatus("回复完成", "success");
          showResponse(currentText);
          await chrome.storage.local.set({ lastResponse: currentText });
          return;
        }
      } else if (currentText) {
        stableCount = 0;
        lastText = currentText;
        // show streaming progress
        showProgress(true, `正在接收... (${currentText.length} 字)`);
      }

      if (pollCount >= MAX_POLLS) {
        clearInterval(autoPollTimer);
        autoPollTimer = null;
        showProgress(false);
        if (currentText) {
          showResponse(currentText);
          showStatus("可能仍在生成（已超时），当前内容已显示", "info");
          await chrome.storage.local.set({ lastResponse: currentText });
        } else {
          showStatus("超时，未收到回复", "error");
        }
      }
    } catch (err) {
      clearInterval(autoPollTimer);
      autoPollTimer = null;
      showProgress(false);
      showStatus("轮询中断: " + err.message, "error");
    }
  }, 1000);
}

// ---- sider tab management ----
function getSiderUrl() {
  return document.getElementById("sider-url").value.trim() || "https://sider.ai/";
}

function getSiderSelector() {
  return document.getElementById("sider-selector").value.trim();
}

async function ensureSiderTab(url, activate) {
  // try existing tab first
  const baseUrl = url.replace(/\/$/, "");
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((t) => t.url && t.url.startsWith(baseUrl));
  if (existing) {
    if (activate) await chrome.tabs.update(existing.id, { active: true });
    return existing;
  }
  // create new tab (do NOT activate so popup stays open)
  return chrome.tabs.create({ url, active: activate });
}

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const check = () => {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) { resolve(); return; }
        if (tab.status === "complete") { setTimeout(resolve, 800); return; }
        setTimeout(check, 300);
      });
    };
    check();
  });
}

// ---- sider auto-detect ----
async function detectSiderInput() {
  const siderUrl = getSiderUrl();
  const tabs = await chrome.tabs.query({ url: siderUrl.replace(/\/$/, "") + "/*" });

  if (!tabs.length) {
    showStatus("请先打开 Sider 网页版", "error");
    return;
  }

  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      func: detectInputs,
    });

    if (result?.[0]?.result?.found?.length) {
      const best = result[0].result.found[0];
      document.getElementById("sider-selector").value = best.selector;
      saveSiderSettings();
      showStatus(`检测到: ${best.selector} (共${result[0].result.found.length}个候选)`, "success");
    } else {
      showStatus("未检测到输入框，请手动填写选择器", "error");
    }
  } catch (err) {
    showStatus("检测失败: " + err.message, "error");
  }
}

async function detectSiderSendBtn() {
  const siderUrl = getSiderUrl();
  const tabs = await chrome.tabs.query({ url: siderUrl.replace(/\/$/, "") + "/*" });

  if (!tabs.length) {
    showStatus("请先打开 Sider 网页版", "error");
    return;
  }

  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      func: detectSendButtons,
    });

    if (result?.[0]?.result?.found?.length) {
      const best = result[0].result.found[0];
      document.getElementById("sider-send-btn-sel").value = best.selector;
      saveSiderSettings();
      showStatus(`检测到: ${best.selector} (${best.text || best.tag})`, "success");
    } else {
      showStatus("未检测到发送按钮，将尝试按 Enter 发送", "info");
    }
  } catch (err) {
    showStatus("检测失败: " + err.message, "error");
  }
}

// ---- UI helpers ----
function showProgress(show, text) {
  const el = document.getElementById("sider-progress");
  el.classList.toggle("hidden", !show);
  if (text) document.getElementById("sider-progress-text").textContent = text;
}

function showResponse(text) {
  document.getElementById("sider-response-text").textContent = text;
  document.getElementById("sider-response").classList.remove("hidden");
}

function hideResponse() {
  document.getElementById("sider-response").classList.add("hidden");
  document.getElementById("sider-response-text").textContent = "";
}

async function copyResponse() {
  const text = document.getElementById("sider-response-text").textContent;
  try {
    await navigator.clipboard.writeText(text);
    showStatus("已复制到剪贴板", "success");
  } catch {
    showStatus("复制失败", "error");
  }
}

function showStatus(msg, type) {
  const el = document.getElementById("sider-status");
  el.textContent = msg;
  el.className = `sider-status ${type}`;
  el.classList.remove("hidden");
  if (type !== "info") {
    setTimeout(() => el.classList.add("hidden"), 4000);
  }
}

// ============================================================
// Injected scripts (run in the target page via executeScript)
// ============================================================

function detectInputs() {
  const candidates = [
    "textarea",
    "[contenteditable='true']",
    "div[data-placeholder]",
    ".ProseMirror",
    '[role="textbox"]',
    "#prompt-textarea",
    "textarea[placeholder]",
  ];

  const found = [];
  for (const sel of candidates) {
    try {
      const el = document.querySelector(sel);
      if (el) {
        found.push({
          selector: sel,
          placeholder: el.placeholder || el.getAttribute("data-placeholder") || "",
          tag: el.tagName,
        });
      }
    } catch {}
  }

  const seen = new Set();
  const unique = found.filter((f) => {
    const key = f.selector + f.placeholder;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const priority = ["textarea[placeholder]", "#prompt-textarea", '[role="textbox"]', ".ProseMirror", "[contenteditable='true']", "textarea"];
  unique.sort((a, b) => {
    const ai = priority.indexOf(a.selector);
    const bi = priority.indexOf(b.selector);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return 0;
  });

  return { found: unique };
}

function detectSendButtons() {
  const candidates = [
    "button[type='submit']",
    "button[aria-label*='send' i]",
    "button[aria-label*='Send']",
    "form button",
    "button svg",
    "form [type='submit']",
    "button.send-btn",
    "button.submit",
    "button.chat-submit",
    "#send-button",
    "#submit-button",
  ];

  const found = [];
  for (const sel of candidates) {
    try {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        if (el.offsetParent !== null) { // visible
          found.push({
            selector: sel,
            text: el.textContent?.trim().slice(0, 30) || "",
            tag: el.tagName,
          });
          break;
        }
      }
    } catch {}
  }

  return { found };
}

function injectTextOnly(text, selector) {
  // ---- inline findInput ----
  let input = null;
  if (selector) {
    input = document.querySelector(selector);
  }
  if (!input) {
    const candidates = ["textarea", "[contenteditable='true']", ".ProseMirror", '[role="textbox"]', "#prompt-textarea", "div[data-placeholder]"];
    for (const sel of candidates) {
      input = document.querySelector(sel);
      if (input) break;
    }
  }
  if (!input) return { success: false, error: "未找到输入框" };

  // ---- inline setInputValue ----
  const isCE = input.getAttribute("contenteditable") === "true" ||
    input.classList.contains("ProseMirror") ||
    input.getAttribute("role") === "textbox";

  if (isCE) {
    input.focus();
    input.textContent = text;
    input.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    const proto = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    const tracker = input._valueTracker;
    if (tracker) { tracker.setValue(""); tracker.setValue(text); }
    input.focus();
  }

  return { success: true, method: input.tagName === "TEXTAREA" || input.tagName === "INPUT" ? "textarea/input" : "contenteditable" };
}

function injectTextAndSubmit(text, inputSelector, sendBtnSelector) {
  // ---- inline findInput ----
  let input = null;
  if (inputSelector) {
    input = document.querySelector(inputSelector);
  }
  if (!input) {
    const candidates = ["textarea", "[contenteditable='true']", ".ProseMirror", '[role="textbox"]', "#prompt-textarea", "div[data-placeholder]"];
    for (const sel of candidates) {
      input = document.querySelector(sel);
      if (input) break;
    }
  }
  if (!input) return { success: false, error: "未找到输入框" };

  // ---- inline setInputValue ----
  const isCE = input.getAttribute("contenteditable") === "true" ||
    input.classList.contains("ProseMirror") ||
    input.getAttribute("role") === "textbox";

  if (isCE) {
    input.focus();
    input.textContent = text;
    input.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    const proto = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    const tracker = input._valueTracker;
    if (tracker) { tracker.setValue(""); tracker.setValue(text); }
    input.focus();
  }

  // find and click send button
  let sendBtn = null;
  if (sendBtnSelector) {
    sendBtn = document.querySelector(sendBtnSelector);
  }
  if (!sendBtn) {
    const candidates = document.querySelectorAll("button[type='submit'], form button, button svg, button[aria-label*='send' i], button[aria-label*='Send'], #send-button, #submit-button");
    for (const btn of candidates) {
      if (btn.offsetParent !== null) { sendBtn = btn; break; }
    }
  }

  if (sendBtn) {
    sendBtn.click();
    return { success: true, method: "click" };
  }

  // fallback: send Enter key
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keypress", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
  return { success: true, method: "enter" };
}

function checkForResponse(sentText) {
  // find the main chat/content area
  const areaSelectors = [
    ".chat-content", ".conversation", ".messages", ".chat-messages",
    '[role="log"]', '[role="list"]', "main", ".main-content",
    ".response", ".ai-response", ".assistant-message",
    ".markdown-body", ".prose",
  ];

  let chatArea = null;
  for (const sel of areaSelectors) {
    chatArea = document.querySelector(sel);
    if (chatArea) break;
  }
  if (!chatArea) chatArea = document.body;

  // collect all text-containing blocks
  const blocks = chatArea.querySelectorAll("p, div, span, li, pre, code, h1, h2, h3, h4, h5, h6, td, th");
  const texts = [];
  for (const block of blocks) {
    const t = block.textContent?.trim();
    if (t && t.length > 20) {
      // skip blocks inside input/composer area
      if (block.closest("form, [role='form'], .input-area, .composer, .send-box, textarea, .prompt-box")) continue;
      // skip blocks that are the user's own message (starts with or exactly the sent text)
      if (t.trim() === sentText.trim()) continue;
      texts.push(t);
    }
  }

  // deduplicate: remove texts that are subsets of others
  const unique = [];
  for (const t of texts) {
    let isSubset = false;
    for (let i = 0; i < unique.length; i++) {
      if (unique[i].includes(t)) { isSubset = true; break; }
      if (t.includes(unique[i])) { unique[i] = t; isSubset = true; break; }
    }
    if (!isSubset) unique.push(t);
  }

  return { text: unique.join("\n\n") };
}

// ---- utils ----
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
