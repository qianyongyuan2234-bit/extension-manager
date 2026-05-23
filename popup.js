// popup.js — 入口：初始化 + 共享状态 + UI 工具

const SELF_ID = chrome.runtime.id;
let allExtensions = [];
let profiles = {};
let autoPollTimer = null;

// ---- tab switching ----
function switchTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.getElementById("panel-extensions").classList.toggle("hidden", name !== "extensions");
  document.getElementById("panel-sider").classList.toggle("hidden", name !== "sider");
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

// ---- utils ----
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---- init ----
document.addEventListener("DOMContentLoaded", async () => {
  await loadProfiles();
  await refreshList();
  renderProfileSelect();
  loadSiderSettings();

  checkBridge();

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });

  document.getElementById("search").addEventListener("input", renderList);
  document.getElementById("profile-btn").addEventListener("click", toggleProfileBar);
  document.getElementById("profile-apply").addEventListener("click", applyProfile);
  document.getElementById("profile-save").addEventListener("click", openSaveModal);
  document.getElementById("profile-cancel").addEventListener("click", closeSaveModal);
  document.getElementById("profile-confirm").addEventListener("click", saveProfile);

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

  chrome.management.onEnabled.addListener(refreshList);
  chrome.management.onDisabled.addListener(refreshList);
  chrome.management.onInstalled.addListener(refreshList);
  chrome.management.onUninstalled.addListener(refreshList);

  const cached = await chrome.storage.local.get("lastResponse");
  if (cached.lastResponse) {
    showResponse(cached.lastResponse);
  }
});
