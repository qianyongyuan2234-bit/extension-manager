// Injected into Sider page — polls CLI bridge, executes multi-model workflow
(function () {
  "use strict";

  var BRIDGE = "http://127.0.0.1:8766";
  var running = false;
  var pollTimer = null;

  function log(msg) {
    console.log("[SiderCLI]", msg);
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  // ---- detect models ----
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
      var el = all[i];
      var text = (el.textContent || "").trim();
      if (text.length < 2 || text.length > 40 || seen[text]) continue;

      for (var j = 0; j < modelNames.length; j++) {
        if (text.toLowerCase().indexOf(modelNames[j].toLowerCase()) !== -1) {
          seen[text] = true;
          options.push(text);
          if (
            el.selected ||
            el.getAttribute("aria-selected") === "true" ||
            el.classList.contains("active") ||
            el.classList.contains("selected")
          ) {
            current = text;
          }
          break;
        }
      }
    }

    // deduplicate
    var uniq = [];
    var uniqSeen = {};
    for (var k = 0; k < options.length; k++) {
      if (!uniqSeen[options[k]]) {
        uniqSeen[options[k]] = true;
        uniq.push(options[k]);
      }
    }
    return { options: uniq, current: current };
  }

  // ---- switch model ----
  function switchModel(name) {
    return new Promise(function (resolve) {
      var all = document.querySelectorAll(
        "button, [role='option'], [role='button'], li, .item, .option, [class*='model'], [class*='Model']"
      );

      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if ((el.textContent || "").trim() === name) {
          if (el.tagName === "OPTION") {
            el.selected = true;
            el.parentElement.dispatchEvent(new Event("change", { bubbles: true }));
            resolve();
            return;
          }
          if (el.offsetParent !== null) {
            el.click();
            setTimeout(resolve, 600);
            return;
          }
        }
      }

      // try opening dropdown first
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
        var items = document.querySelectorAll("button, [role='option'], li, .item");
        for (var k = 0; k < items.length; k++) {
          if ((items[k].textContent || "").trim() === name) {
            items[k].click();
            break;
          }
        }
        resolve();
      }, 800);
    });
  }

  // ---- find input ----
  function findInput() {
    var candidates = [
      "textarea",
      "[contenteditable='true']",
      ".ProseMirror",
      '[role="textbox"]',
      "#prompt-textarea",
      "div[data-placeholder]",
      "form textarea",
      ".chat-input textarea",
      ".composer textarea",
    ];

    var input = null;
    for (var i = 0; i < candidates.length; i++) {
      input = document.querySelector(candidates[i]);
      if (input && input.offsetParent !== null) return input;
      input = null;
    }

    var allTA = document.querySelectorAll("textarea");
    for (var j = 0; j < allTA.length; j++) {
      if (allTA[j].offsetParent !== null) return allTA[j];
    }

    return null;
  }

  // ---- set input value ----
  function setInputValue(input, text) {
    var isCE =
      input.getAttribute("contenteditable") === "true" ||
      input.classList.contains("ProseMirror") ||
      input.getAttribute("role") === "textbox";

    if (isCE) {
      input.focus();
      input.textContent = text;
      input.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

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

  // ---- find and click send button ----
  function clickSend(input) {
    var btnCandidates = [
      "button[type='submit']",
      "button[aria-label*='send' i]",
      "button[aria-label*='Send']",
      "form button",
      "form [type='submit']",
      ".send-btn",
      "#send-button",
      "#submit-button",
      "button svg",
    ];

    var sendBtn = null;
    for (var i = 0; i < btnCandidates.length; i++) {
      sendBtn = document.querySelector(btnCandidates[i]);
      if (sendBtn && sendBtn.offsetParent !== null) return sendBtn.click();
      sendBtn = null;
    }

    // fallback Enter
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

  // ---- inject and submit ----
  function injectAndSubmit(text) {
    return new Promise(function (resolve) {
      var input = findInput();
      if (!input) {
        resolve({ error: "找不到输入框" });
        return;
      }
      setInputValue(input, text);

      setTimeout(function () {
        clickSend(input);
        resolve({ success: true });
      }, 400);
    });
  }

  // ---- check response ----
  function checkResponse(sentText) {
    var areaSel = [
      ".chat-content",
      ".conversation",
      ".messages",
      ".chat-messages",
      '[role="log"]',
      '[role="list"]',
      "main",
      ".response",
      ".ai-response",
      ".assistant-message",
      ".markdown-body",
      ".prose",
      ".chat-area",
    ];

    var area = null;
    for (var i = 0; i < areaSel.length; i++) {
      area = document.querySelector(areaSel[i]);
      if (area) break;
    }
    if (!area) area = document.body;

    var blocks = area.querySelectorAll(
      "p, div, span, li, pre, code, h1, h2, h3, h4, h5, h6, td, th"
    );
    var texts = [];
    for (var j = 0; j < blocks.length; j++) {
      var b = blocks[j];
      var t = (b.textContent || "").trim();
      if (t && t.length > 20) {
        if (
          b.closest(
            "form, [role='form'], .input-area, .composer, .send-box, textarea, .prompt-box"
          )
        )
          continue;
        if (t.trim() === sentText.trim()) continue;
        texts.push(t);
      }
    }

    var unique = [];
    for (var k = 0; k < texts.length; k++) {
      var t = texts[k];
      var subset = false;
      for (var m = 0; m < unique.length; m++) {
        if (unique[m].indexOf(t) !== -1) {
          subset = true;
          break;
        }
        if (t.indexOf(unique[m]) !== -1) {
          unique[m] = t;
          subset = true;
          break;
        }
      }
      if (!subset) unique.push(t);
    }
    return unique.join("\n\n");
  }

  // ---- poll for response ----
  function pollForResponse(sentText) {
    return new Promise(function (resolve) {
      var lastText = "";
      var stableCount = 0;
      var maxPolls = 120;
      var count = 0;

      function tick() {
        count++;
        var text = checkResponse(sentText);

        if (text && text === lastText) {
          stableCount++;
          if (stableCount >= 4) {
            resolve(text);
            return;
          }
        } else if (text) {
          lastText = text;
          stableCount = 0;
        }

        if (count >= maxPolls) {
          resolve(lastText || "[timeout]");
          return;
        }

        setTimeout(tick, 1500);
      }

      tick();
    });
  }

  // ---- main flow ----
  async function main() {
    if (running) return;
    running = true;

    try {
      log("checking for command...");

      var cmdResp = await fetch(BRIDGE + "/command?_=" + Date.now());
      if (!cmdResp.ok) {
        running = false;
        return;
      }

      var cmd = await cmdResp.json();
      if (cmd.status !== "pending") {
        running = false;
        return;
      }

      log("got command: " + cmd.question.slice(0, 50));

      var question = cmd.question;
      var results = [];

      // detect models
      var models = detectModels();
      log(
        "detected models: " +
          models.options.length +
          " (" +
          models.options.join(", ") +
          ")"
      );

      var modelList =
        models.options.length > 0 ? models.options : ["__default__"];

      // ask each model
      for (var i = 0; i < modelList.length; i++) {
        var model = modelList[i];
        log("switching to: " + model);

        if (model !== "__default__") {
          await switchModel(model);
          await sleep(2000);
        }

        var inj = await injectAndSubmit(question);
        if (inj.error) {
          log("inject failed: " + inj.error);
          results.push({ model: model, answer: "[发送失败: " + inj.error + "]" });
          continue;
        }

        log("waiting for " + model + " response...");
        var answer = await pollForResponse(question);
        log("got response from " + model + " (" + answer.length + " chars)");
        results.push({ model: model, answer: answer });
      }

      // post results
      log("posting " + results.length + " results to bridge");
      await fetch(BRIDGE + "/result", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: question, results: results }),
      });

      log("done");
    } catch (e) {
      log("error: " + e.message);
    }

    running = false;
  }

  // ---- start polling ----
  log("worker loaded, starting poll loop");
  pollTimer = setInterval(main, 2000);
  main();
})();
