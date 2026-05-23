// Service worker — polls CLI bridge via chrome.alarms (MV3-safe)
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
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const modelNames = ["GPT-4", "Claude", "Gemini", "Llama", "Mistral", "Grok", "DeepSeek", "o1", "o3", "opus", "sonnet", "haiku"];
        const all = document.querySelectorAll("button, [role='option'], [role='button'], select option, .item, .option, [class*='model'], [class*='Model'], li");
        const seen = new Set();
        const options = [];
        let current = "";
        for (const el of all) {
          const text = (el.textContent || "").trim();
          if (text.length < 2 || text.length > 40 || seen.has(text)) continue;
          for (const name of modelNames) {
            if (text.toLowerCase().includes(name.toLowerCase())) {
              seen.add(text);
              options.push(text);
              if (el.selected || el.getAttribute("aria-selected") === "true" || el.classList.contains("active") || el.classList.contains("selected")) {
                current = text;
              }
              break;
            }
          }
        }
        return { options: [...options], current };
      },
    });
    return r?.result || { options: [], current: "" };
  } catch { return { options: [], current: "" }; }
}

async function switchModel(tabId, modelName) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (name) => {
        const all = document.querySelectorAll("button, [role='option'], [role='button'], li, .item, .option, [class*='model'], [class*='Model']");
        for (const el of all) {
          if ((el.textContent || "").trim() === name) {
            if (el.tagName === "OPTION") {
              el.selected = true;
              el.parentElement.dispatchEvent(new Event("change", { bubbles: true }));
              return;
            }
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
      args: [modelName],
    });
  } catch {}
}

async function injectAndSubmit(tabId, text) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (msg) => {
        let input = null;
        const candidates = ["textarea", "[contenteditable='true']", ".ProseMirror", '[role="textbox"]', "#prompt-textarea", "div[data-placeholder]", "form textarea", ".chat-input textarea"];
        for (const sel of candidates) { input = document.querySelector(sel); if (input && input.offsetParent !== null) break; input = null; }
        if (!input) { const allTA = document.querySelectorAll("textarea"); for (const ta of allTA) { if (ta.offsetParent !== null) { input = ta; break; } } }
        if (!input) throw new Error("no input");

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
          const tracker = input._valueTracker;
          if (tracker) { tracker.setValue(""); tracker.setValue(msg); }
          input.focus();
        }

        const btnCandidates = ["button[type='submit']", "button[aria-label*='send' i]", "button[aria-label*='Send']", "form button", "form [type='submit']", ".send-btn", "#send-button", "#submit-button"];
        let sendBtn = null;
        for (const sel of btnCandidates) { sendBtn = document.querySelector(sel); if (sendBtn && sendBtn.offsetParent !== null) break; sendBtn = null; }
        if (sendBtn) { sendBtn.click(); } else {
          input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
        }
      },
      args: [text],
    });
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
            for (let i = 0; i < unique.length; i++) {
              if (unique[i].includes(t)) { subset = true; break; }
              if (t.includes(unique[i])) { unique[i] = t; subset = true; break; }
            }
            if (!subset) unique.push(t);
          }
          return unique.join("\n\n");
        },
        args: [sentText],
      });
      const text = r?.result || "";
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
