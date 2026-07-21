// ROUZHEN Studio — maintenance.js
// Maintenance 页面：扫描 / 缩略图 / 清理 / 统计

// ------------------------------
// 配置
// ------------------------------
const CONFIG = {
  TOKEN_STORAGE_KEY: "rz_upload_token",
};

// ------------------------------
// DOM
// ------------------------------
const tokenOverlay = document.getElementById("tokenOverlay");
const tokenInput = document.getElementById("tokenInput");
const tokenCancelBtn = document.getElementById("tokenCancelBtn");
const tokenConfirmBtn = document.getElementById("tokenConfirmBtn");

const refreshStatsBtn = document.getElementById("refreshStatsBtn");
const scanBtn = document.getElementById("scanBtn");
const scanMissingBtn = document.getElementById("scanMissingBtn");
const cleanOrphansBtn = document.getElementById("cleanOrphansBtn");

const statusEl = document.getElementById("galleryStatus");

// ------------------------------
// 初始化
// ------------------------------
function init() {
  const token = getStoredToken();
  if (!token) {
    openTokenOverlay();
    return;
  }
  loadStats(token);
}

// ------------------------------
// Statistics
// ------------------------------
async function loadStats(token) {
  setStatus("加载统计信息…");
  try {
    const res = await fetch("/api/maintenance/stats", {
      headers: { "X-Upload-Token": token },
    });

    if (res.status === 401 || res.status === 403) {
      clearStoredToken();
      setStatus("口令错误，请重新输入");
      openTokenOverlay();
      return;
    }

    if (!res.ok) throw new Error("stats-failed");

    const data = await res.json();

    document.getElementById("statImages").textContent = data.images || 0;
    document.getElementById("statThumbnails").textContent = data.thumbnails || 0;
    document.getElementById("statMissing").textContent = data.missing_thumbnails || 0;
    document.getElementById("statStorage").textContent = data.storage_mb ? `${data.storage_mb} MB` : "-";
    document.getElementById("statStorageBytes").textContent = data.storage_bytes ? `${data.storage_bytes} bytes` : "";
    document.getElementById("statLatest").textContent = data.latest_upload ? formatDate(data.latest_upload) : "-";
    document.getElementById("statOldest").textContent = data.oldest_upload ? formatDate(data.oldest_upload) : "-";

    setStatus("");
  } catch (err) {
    setStatus("加载失败：" + err.message);
  }
}

refreshStatsBtn.addEventListener("click", () => {
  const token = getStoredToken();
  if (token) loadStats(token);
});

// ------------------------------
// Scan R2
// ------------------------------
scanBtn.addEventListener("click", async () => {
  const token = getStoredToken();
  if (!token) return openTokenOverlay();

  const logEl = document.getElementById("scanLog");
  logEl.hidden = false;
  logEl.innerHTML = "";

  log(logEl, "开始扫描 images/…", "info");
  scanBtn.disabled = true;

  try {
    const res = await fetch("/api/maintenance/scan", {
      method: "POST",
      headers: { "X-Upload-Token": token },
    });

    if (!res.ok) throw new Error("scan-failed");

    const data = await res.json();
    log(logEl, `扫描完成`, "success");
    log(logEl, `发现图片: ${data.images}`, "info");
    log(logEl, `已有缩略图: ${data.thumbnails}`, "info");
    log(logEl, `缺失缩略图: ${data.missing_thumbnails}`, "info");

    loadStats(token);
  } catch (err) {
    log(logEl, `扫描失败: ${err.message}`, "error");
  } finally {
    scanBtn.disabled = false;
  }
});

// ------------------------------
// Scan Missing Thumbnails
// ------------------------------
scanMissingBtn.addEventListener("click", async () => {
  const token = getStoredToken();
  if (!token) return openTokenOverlay();

  const logEl = document.getElementById("scanMissingLog");
  logEl.hidden = false;
  logEl.innerHTML = "";

  log(logEl, "扫描缺失缩略图…", "info");
  scanMissingBtn.disabled = true;

  try {
    const res = await fetch("/api/maintenance/scan-missing-thumbnails", {
      method: "POST",
      headers: { "X-Upload-Token": token },
    });

    if (!res.ok) throw new Error("request-failed");

    const data = await res.json();
    log(logEl, `总图片: ${data.total_images}`, "info");
    log(logEl, `缺失缩略图: ${data.missing_thumbnails}`, "info");

    if (data.note) {
      log(logEl, data.note, "info");
    }

    if (data.missing_list && data.missing_list.length > 0) {
      log(logEl, "缺失缩略图清单（前 100 个）:", "info");
      data.missing_list.forEach(item => {
        log(logEl, `  ${item.key}`, "info");
      });
    }
  } catch (err) {
    log(logEl, `失败: ${err.message}`, "error");
  } finally {
    scanMissingBtn.disabled = false;
  }
});

// ------------------------------
// Clean Orphan Thumbnails
// ------------------------------
cleanOrphansBtn.addEventListener("click", async () => {
  const token = getStoredToken();
  if (!token) return openTokenOverlay();

  const logEl = document.getElementById("cleanOrphansLog");
  logEl.hidden = false;
  logEl.innerHTML = "";

  log(logEl, "开始清理孤儿缩略图…", "info");
  cleanOrphansBtn.disabled = true;

  try {
    const res = await fetch("/api/maintenance/clean-orphans", {
      method: "POST",
      headers: { "X-Upload-Token": token },
    });

    if (!res.ok) throw new Error("request-failed");

    const data = await res.json();
    log(logEl, `孤儿缩略图总数: ${data.orphan_thumbnails}`, "info");
    log(logEl, `已删除: ${data.deleted}`, "success");

    if (data.note) {
      log(logEl, data.note, "info");
    }

    if (data.remaining > 0) {
      log(logEl, `剩余: ${data.remaining}，可再次点击继续清理`, "info");
    }

    loadStats(token);
  } catch (err) {
    log(logEl, `失败: ${err.message}`, "error");
  } finally {
    cleanOrphansBtn.disabled = false;
  }
});

// ------------------------------
// Token
// ------------------------------
function openTokenOverlay() {
  tokenInput.value = "";
  tokenOverlay.hidden = false;
  tokenInput.focus();
}

function closeTokenOverlay() {
  tokenOverlay.hidden = true;
}

tokenCancelBtn.addEventListener("click", () => {
  closeTokenOverlay();
  window.location.href = "/";
});

tokenConfirmBtn.addEventListener("click", () => {
  const token = tokenInput.value.trim();
  if (!token) {
    setStatus("请输入口令");
    return;
  }
  saveStoredToken(token);
  closeTokenOverlay();
  init();
});

tokenInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    tokenConfirmBtn.click();
  }
});

// ------------------------------
// Token Storage
// ------------------------------
function getStoredToken() {
  try {
    return localStorage.getItem(CONFIG.TOKEN_STORAGE_KEY);
  } catch (err) {
    return "";
  }
}

function saveStoredToken(token) {
  try {
    localStorage.setItem(CONFIG.TOKEN_STORAGE_KEY, token);
  } catch (err) {}
}

function clearStoredToken() {
  try {
    localStorage.removeItem(CONFIG.TOKEN_STORAGE_KEY);
  } catch (err) {}
}

// ------------------------------
// Utils
// ------------------------------
function setStatus(msg) {
  statusEl.textContent = msg;
}

function log(el, msg, type = "info") {
  const div = document.createElement("div");
  div.className = `log-entry ${type}`;
  div.textContent = msg;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleString("zh-CN");
  } catch (e) {
    return iso;
  }
}

// ------------------------------
// Start
// ------------------------------
init();