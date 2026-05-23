// Shared page-injected functions for Sider.ai automation.
// Loaded by: Chrome extension (popup + service worker), Node.js (cdp-client, mcp-server).
// These functions are serialized and injected into the Sider.ai page via
// chrome.scripting.executeScript or CDP Runtime.evaluate.
(function () {
  "use strict";

  // ============================================================
  // Model dropdown
  // ============================================================

  function openModelDropdown() {
    if (document.querySelector(".model-title")) {
      document.body.click();
    }
    var btns = document.querySelectorAll(".model-btn");
    for (var i = 0; i < btns.length; i++) {
      var t = (btns[i].textContent || "").trim();
      if (t.length > 0 && t.length < 20) {
        btns[i].click();
        return;
      }
    }
    if (btns.length) btns[0].click();
  }

  function readModelDropdown() {
    var currentBtn = document.querySelector(".model-btn");
    var current = (currentBtn ? currentBtn.textContent : "").trim();
    var seen = {};
    var options = [];
    var items = document.querySelectorAll(".model-title");
    for (var i = 0; i < items.length; i++) {
      var text = (items[i].textContent || "").trim();
      if (text.length >= 2 && !seen[text]) {
        seen[text] = true;
        options.push(text);
      }
    }
    return { options: options, current: current };
  }

  function clickModel(name) {
    var items = document.querySelectorAll(".model-title");
    for (var i = 0; i < items.length; i++) {
      if ((items[i].textContent || "").trim() === name) {
        items[i].click();
        return;
      }
    }
  }

  // ============================================================
  // Input detection & injection
  // ============================================================

  function findInput(inputSelector) {
    var input = null;
    if (inputSelector) input = document.querySelector(inputSelector);
    if (!input) {
      var candidates = [
        "textarea",
        "[contenteditable='true']",
        ".ProseMirror",
        '[role="textbox"]',
        "#prompt-textarea",
        "div[data-placeholder]",
        "form textarea",
        ".chat-input textarea",
      ];
      for (var i = 0; i < candidates.length; i++) {
        input = document.querySelector(candidates[i]);
        if (input && input.offsetParent !== null) break;
        input = null;
      }
      if (!input) {
        var allTA = document.querySelectorAll("textarea");
        for (var j = 0; j < allTA.length; j++) {
          if (allTA[j].offsetParent !== null) {
            input = allTA[j];
            break;
          }
        }
      }
    }
    return input;
  }

  function setInputValue(input, text) {
    var isCE =
      input.getAttribute("contenteditable") === "true" ||
      input.classList.contains("ProseMirror") ||
      input.getAttribute("role") === "textbox";

    if (isCE) {
      input.focus();
      input.textContent = text;
      input.dispatchEvent(
        new InputEvent("input", { bubbles: true, composed: true })
      );
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      var proto =
        input.tagName === "TEXTAREA"
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      var tracker = input._valueTracker;
      if (tracker) {
        tracker.setValue("");
        tracker.setValue(text);
      }
      input.focus();
    }
  }

  function findSendButton(sendBtnSelector) {
    var sendBtn = null;
    if (sendBtnSelector) {
      sendBtn = document.querySelector(sendBtnSelector);
      if (sendBtn && sendBtn.offsetParent !== null) return sendBtn;
    }
    var btnCandidates = [
      "button[type='submit']",
      "button[aria-label*='send' i]",
      "button[aria-label*='Send']",
      "form button",
      "form [type='submit']",
      ".send-btn",
      "#send-button",
      "#submit-button",
    ];
    for (var i = 0; i < btnCandidates.length; i++) {
      sendBtn = document.querySelector(btnCandidates[i]);
      if (sendBtn && sendBtn.offsetParent !== null) return sendBtn;
      sendBtn = null;
    }
    return null;
  }

  // ---- composite operations (self-contained for page injection) ----

  function injectTextOnly(text, inputSelector) {
    // inline findInput
    var input = null;
    if (inputSelector) input = document.querySelector(inputSelector);
    if (!input) {
      var candidates = [
        "textarea",
        "[contenteditable='true']",
        ".ProseMirror",
        '[role="textbox"]',
        "#prompt-textarea",
        "div[data-placeholder]",
        "form textarea",
        ".chat-input textarea",
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
    }
    if (!input) return { success: false, error: "找不到输入框" };

    // inline setInputValue
    var isCE =
      input.getAttribute("contenteditable") === "true" ||
      input.classList.contains("ProseMirror") ||
      input.getAttribute("role") === "textbox";
    if (isCE) {
      input.focus();
      input.textContent = text;
      input.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      var proto = input.tagName === "TEXTAREA"
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      var tracker = input._valueTracker;
      if (tracker) { tracker.setValue(""); tracker.setValue(text); }
      input.focus();
    }

    return {
      success: true,
      method:
        input.tagName === "TEXTAREA" || input.tagName === "INPUT"
          ? "textarea/input"
          : "contenteditable",
    };
  }

  function injectAndSubmit(text, inputSelector, sendBtnSelector) {
    // inline findInput
    var input = null;
    if (inputSelector) input = document.querySelector(inputSelector);
    if (!input) {
      var candidates = [
        "textarea",
        "[contenteditable='true']",
        ".ProseMirror",
        '[role="textbox"]',
        "#prompt-textarea",
        "div[data-placeholder]",
        "form textarea",
        ".chat-input textarea",
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
    }
    if (!input) return { success: false, error: "找不到输入框" };

    // inline setInputValue
    var isCE =
      input.getAttribute("contenteditable") === "true" ||
      input.classList.contains("ProseMirror") ||
      input.getAttribute("role") === "textbox";
    if (isCE) {
      input.focus();
      input.textContent = text;
      input.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      var proto =
        input.tagName === "TEXTAREA"
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      var tracker = input._valueTracker;
      if (tracker) { tracker.setValue(""); tracker.setValue(text); }
      input.focus();
    }

    // inline findAndClickSend
    setTimeout(function () {
      var sendBtn = null;
      if (sendBtnSelector) {
        sendBtn = document.querySelector(sendBtnSelector);
        if (!sendBtn || sendBtn.offsetParent === null) sendBtn = null;
      }
      if (!sendBtn) {
        var btnCandidates = [
          "button[type='submit']",
          "button[aria-label*='send' i]",
          "button[aria-label*='Send']",
          "form button",
          "form [type='submit']",
          ".send-btn",
          "#send-button",
          "#submit-button",
        ];
        for (var k = 0; k < btnCandidates.length; k++) {
          sendBtn = document.querySelector(btnCandidates[k]);
          if (sendBtn && sendBtn.offsetParent !== null) break;
          sendBtn = null;
        }
      }
      if (sendBtn) {
        sendBtn.click();
      } else {
        input.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            code: "Enter",
            keyCode: 13,
            which: 13,
            bubbles: true,
          })
        );
      }
    }, 400);

    return { success: true };
  }

  // ============================================================
  // Auto-detection (for popup settings panel)
  // ============================================================

  function detectInputs() {
    var candidates = [
      "textarea",
      "[contenteditable='true']",
      "div[data-placeholder]",
      ".ProseMirror",
      '[role="textbox"]',
      "#prompt-textarea",
      "textarea[placeholder]",
    ];
    var found = [];
    for (var i = 0; i < candidates.length; i++) {
      var el = document.querySelector(candidates[i]);
      if (el) {
        found.push({
          selector: candidates[i],
          placeholder:
            el.placeholder || el.getAttribute("data-placeholder") || "",
          tag: el.tagName,
        });
      }
    }
    var seen = {};
    var unique = [];
    for (var j = 0; j < found.length; j++) {
      var key = found[j].selector + found[j].placeholder;
      if (!seen[key]) {
        seen[key] = true;
        unique.push(found[j]);
      }
    }
    var priority = [
      "textarea[placeholder]",
      "#prompt-textarea",
      '[role="textbox"]',
      ".ProseMirror",
      "[contenteditable='true']",
      "textarea",
    ];
    unique.sort(function (a, b) {
      var ai = priority.indexOf(a.selector);
      var bi = priority.indexOf(b.selector);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return 0;
    });
    return { found: unique };
  }

  function detectSendButtons() {
    var candidates = [
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
    var found = [];
    for (var i = 0; i < candidates.length; i++) {
      var els = document.querySelectorAll(candidates[i]);
      for (var j = 0; j < els.length; j++) {
        if (els[j].offsetParent !== null) {
          found.push({
            selector: candidates[i],
            text: (els[j].textContent || "").trim().slice(0, 30),
            tag: els[j].tagName,
          });
          break;
        }
      }
    }
    return { found: found };
  }

  // ============================================================
  // Response extraction
  // ============================================================

  function extractResponse(sentText) {
    // Sider-specific: answer-markdown-box
    var answerBoxes = document.querySelectorAll(".answer-markdown-box");
    if (answerBoxes.length) {
      var last = answerBoxes[answerBoxes.length - 1];
      var text = (last.textContent || "").trim();
      if (text.length > 5) return { text: text };
    }

    // Generic AI response selectors
    var aiSelectors = [
      ".ai-response",
      ".assistant-message",
      ".bot-message",
      ".response-text",
      '[class*="assistant"]',
      '[class*="response"]',
      '[class*="answer"]',
      '[class*="bot"]',
      '[class*="ai-"]',
      ".markdown-body",
      ".prose",
      '[data-role="assistant"]',
      '[data-message-role="assistant"]',
      ".message.assistant",
      ".message.ai",
      ".chat-message.assistant",
    ];

    var respEl = null;
    for (var i = 0; i < aiSelectors.length; i++) {
      var els = document.querySelectorAll(aiSelectors[i]);
      if (els.length) respEl = els[els.length - 1];
      if (respEl) break;
    }

    if (respEl) {
      return { text: (respEl.textContent || "").trim() };
    }

    // Fallback: find the longest text block
    var mainSel = [
      "main",
      ".chat-content",
      ".conversation",
      ".messages",
      '[role="log"]',
      '[role="list"]',
    ];
    var main = null;
    for (var j = 0; j < mainSel.length; j++) {
      main = document.querySelector(mainSel[j]);
      if (main) break;
    }
    if (!main) main = document.body;

    var all = main.querySelectorAll(
      "p, div, li, pre, code, h1, h2, h3, h4, h5, h6, span"
    );
    var best = "";
    for (var k = 0; k < all.length; k++) {
      var t2 = (all[k].textContent || "").trim();
      if (
        t2.length > best.length &&
        t2.length > 50 &&
        t2 !== (sentText || "").trim() &&
        !all[k].closest(
          "form, [role='form'], .input-area, .composer, .send-box, textarea, .prompt-box, nav, header, footer, [class*='sidebar'], [class*='toolbar']"
        )
      ) {
        best = t2;
      }
    }
    return { text: best };
  }

  // ---- legacy name (used by popup.js poller) ----
  function checkForResponse(sentText) {
    return extractResponse(sentText);
  }

  // ============================================================
  // Model detection (used by background.js and popup.js bridge)
  // ============================================================

  function detectModels() {
    var modelNames = [
      "GPT-4", "Claude", "Gemini", "Llama", "Mistral", "Grok",
      "DeepSeek", "o1", "o3", "opus", "sonnet", "haiku",
    ];
    var all = document.querySelectorAll(
      "button, [role='option'], [role='button'], select option, .item, .option, [class*='model'], [class*='Model'], li"
    );
    var seen = {};
    var options = [];
    var current = "";
    for (var i = 0; i < all.length; i++) {
      var text = (all[i].textContent || "").trim();
      if (text.length < 2 || text.length > 40 || seen[text]) continue;
      for (var j = 0; j < modelNames.length; j++) {
        if (text.toLowerCase().indexOf(modelNames[j].toLowerCase()) >= 0) {
          seen[text] = true;
          options.push(text);
          if (
            all[i].selected ||
            all[i].getAttribute("aria-selected") === "true" ||
            all[i].classList.contains("active") ||
            all[i].classList.contains("selected")
          ) {
            current = text;
          }
          break;
        }
      }
    }
    return { options: options, current: current };
  }

  function switchModel(name) {
    var all = document.querySelectorAll(
      "button, [role='option'], [role='button'], li, .item, .option, [class*='model'], [class*='Model']"
    );
    for (var i = 0; i < all.length; i++) {
      if ((all[i].textContent || "").trim() === name) {
        if (all[i].tagName === "OPTION") {
          all[i].selected = true;
          all[i].parentElement.dispatchEvent(
            new Event("change", { bubbles: true })
          );
          return;
        }
        if (all[i].offsetParent !== null) {
          all[i].click();
          return;
        }
      }
    }
    var triggers = document.querySelectorAll(
      "[class*='model-select'], [class*='ModelSelect'], [class*='model-switch'], [class*='model-picker']"
    );
    for (var j = 0; j < triggers.length; j++) {
      if (triggers[j].offsetParent !== null) {
        triggers[j].click();
        break;
      }
    }
    setTimeout(function () {
      var items = document.querySelectorAll(
        "button, [role='option'], li, .item"
      );
      for (var k = 0; k < items.length; k++) {
        if ((items[k].textContent || "").trim() === name) {
          items[k].click();
          break;
        }
      }
    }, 600);
  }

  // ============================================================
  // Export
  // ============================================================

  var exports = {
    // Dropdown
    openModelDropdown: openModelDropdown,
    readModelDropdown: readModelDropdown,
    clickModel: clickModel,
    // Input
    findInput: findInput,
    setInputValue: setInputValue,
    findSendButton: findSendButton,
    injectTextOnly: injectTextOnly,
    injectAndSubmit: injectAndSubmit,
    // Detection
    detectInputs: detectInputs,
    detectSendButtons: detectSendButtons,
    // Models
    detectModels: detectModels,
    switchModel: switchModel,
    // Response
    extractResponse: extractResponse,
    checkForResponse: checkForResponse,
  };

  // Chrome extension (global scope via importScripts / <script>)
  if (typeof self !== "undefined") {
    Object.assign(self, exports);
  }

  // Node.js (require)
  if (typeof module !== "undefined" && module.exports) {
    module.exports = exports;
  }
})();
