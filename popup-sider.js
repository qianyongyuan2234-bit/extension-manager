// popup-sider.js — Sider 多模型桥接面板

// ---- bridge polling ----
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

    setBridgeBar("executing", "执行中: " + cmd.question.slice(0, 40));
    switchTab("sider");
    showStatus("检测到 CLI 命令: " + cmd.question.slice(0, 50), "info");
    document.getElementById("sider-input").value = cmd.question;

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

  const tab = await ensureSiderTab(siderUrl, true);
  if (!tab) {
    showStatus("无法打开 Sider 页面", "error");
    setBridgeButtonsEnabled(true);
    return;
  }
  await waitForTabLoad(tab.id);
  await sleep(1500);

  if (modelList.length === 0) {
    try {
      const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: detectModels });
      modelList = r?.result?.options || ["__default__"];
    } catch { modelList = ["__default__"]; }
    if (modelList.length === 0) modelList = ["__default__"];
  }

  const results = [];
  for (let i = 0; i < modelList.length; i++) {
    const model = modelList[i];
    showProgress(true, `[${i + 1}/${modelList.length}] 切换到: ${model}`);

    if (model !== "__default__") {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: switchModel, args: [model] });
        await sleep(2000);
      } catch {}
    }

    showProgress(true, `[${i + 1}/${modelList.length}] 等待 ${model} 回复...`);
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: injectAndSubmit,
        args: [question, inputSel, sendBtnSel],
      });
    } catch (e) { results.push({ model, answer: "[发送失败: " + e.message + "]" }); continue; }

    const answer = await pollForResponseFromTab(tab.id, question);
    results.push({ model, answer });
    showProgress(true, `[${i + 1}/${modelList.length}] ${model} 完成`);
  }

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
        func: extractResponse,
        args: [sentText],
      });
      const text = r?.result?.text || "";
      if (text && text === lastText) { stableCount++; if (stableCount >= 4) return text; }
      else if (text) { lastText = text; stableCount = 0; }
    } catch { return lastText || "[poll error]"; }
  }
  return lastText || "[timeout]";
}

// ---- sider send ----
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

async function sendAndWaitForReply() {
  const text = document.getElementById("sider-input").value.trim();
  if (!text) { showStatus("请先输入要发送的内容", "error"); return; }

  const siderUrl = getSiderUrl();
  const inputSel = getSiderSelector();
  const sendBtnSel = document.getElementById("sider-send-btn-sel").value.trim();

  if (autoPollTimer) { clearInterval(autoPollTimer); autoPollTimer = null; }

  showProgress(true, "正在打开 Sider...");
  hideResponse();

  const tab = await ensureSiderTab(siderUrl, true);
  if (!tab) { showStatus("无法打开 Sider 页面", "error"); showProgress(false); return; }

  await waitForTabLoad(tab.id);
  showProgress(true, "正在注入问题...");

  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: injectAndSubmit,
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

  let pollCount = 0;
  const MAX_POLLS = 120;
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
  const baseUrl = url.replace(/\/$/, "");
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((t) => t.url && t.url.startsWith(baseUrl));
  if (existing) {
    if (activate) await chrome.tabs.update(existing.id, { active: true });
    return existing;
  }
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

// ---- auto-detect ----
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
