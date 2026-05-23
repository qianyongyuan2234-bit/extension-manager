// Service worker — polls CLI bridge via chrome.alarms (MV3-safe)
importScripts("shared/sider-page-fns.js");

const BRIDGE_URL = "http://127.0.0.1:8766";
const SIDER_URL = "https://sider.ai/";

let running = false;

// Wake up every 3 seconds to check for commands
chrome.alarms.create("poll-bridge", { periodInMinutes: 3 / 60 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "poll-bridge") return;
  if (running) return;

  try {
    const resp = await fetch(`${BRIDGE_URL}/command?_=${Date.now()}`, { cache: "no-store" });
    if (!resp.ok) return;
    const cmd = await resp.json();
    if (cmd.status !== "pending") return;

    running = true;
    await executeCommand(cmd);
    running = false;
  } catch {
    // bridge not running — ok
  }
});

async function executeCommand(cmd) {
  const question = cmd.question;
  const results = [];

  try {
    const tab = await findOrCreateSiderTab();
    await waitForTabReady(tab.id);
    await sleep(2000);

    const models = await detectModels(tab.id);
    const modelList = models.options.length > 0 ? models.options : ["__default__"];

    for (let i = 0; i < modelList.length; i++) {
      const model = modelList[i];
      if (model !== "__default__") {
        await switchModel(tab.id, model);
        await sleep(2000);
      }

      await injectAndSubmit(tab.id, question);
      const answer = await pollForResponse(tab.id, question);
      results.push({ model, answer });
    }
  } catch (err) {
    results.push({ model: "__error__", answer: err.message });
  }

  try {
    await fetch(`${BRIDGE_URL}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, results }),
    });
  } catch {
    chrome.storage.local.set({ lastBridgeResult: { question, results } });
  }
}

// ---- Tab management ----
async function findOrCreateSiderTab() {
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find(t => t.url && t.url.startsWith(SIDER_URL));
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    return existing;
  }
  return chrome.tabs.create({ url: SIDER_URL, active: true });
}

function waitForTabReady(tabId) {
  return new Promise((resolve) => {
    const check = () => {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) { resolve(); return; }
        if (tab.status === "complete") { setTimeout(resolve, 600); return; }
        setTimeout(check, 300);
      });
    };
    check();
  });
}

// ---- Injected operations ----
async function detectModels(tabId) {
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: detectModels });
    return r?.result || { options: [], current: "" };
  } catch { return { options: [], current: "" }; }
}

async function switchModel(tabId, modelName) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: switchModel, args: [modelName] });
  } catch {}
}

async function injectAndSubmit(tabId, text) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: injectAndSubmit, args: [text] });
  } catch (e) { throw new Error("Inject failed: " + e.message); }
}

async function pollForResponse(tabId, sentText) {
  const maxWait = 180000;
  const start = Date.now();
  let lastText = "";
  let stableCount = 0;

  while (Date.now() - start < maxWait) {
    await sleep(1500);
    try {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId },
        func: extractResponse,
        args: [sentText],
      });
      const text = r?.result?.text || "";
      if (text && text === lastText) {
        stableCount++;
        if (stableCount >= 4) return text;
      } else if (text) {
        lastText = text;
        stableCount = 0;
      }
    } catch { return lastText || "[poll error]"; }
  }
  return lastText || "[timeout]";
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
