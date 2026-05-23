// popup-extensions.js — Chrome 扩展管理面板

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
