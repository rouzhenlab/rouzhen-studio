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
const buildIndexBtn = document.getElementById("buildIndexBtn");
const scanMissingBtn = document.getElementById("scanMissingBtn");
const generateThumbnailsBtn = document.getElementById("generateThumbnailsBtn");
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

  log(logEl, "开始扫描 R2…", "info");
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
// Build Asset Index
// ------------------------------
buildIndexBtn.addEventListener("click", async () => {
  const token = getStoredToken();
  if (!token) return openTokenOverlay();

  const logEl = document.getElementById("buildIndexLog");
  logEl.hidden = false;
  logEl.innerHTML = "";

  log(logEl, "开始构建资产索引…", "info");
  buildIndexBtn.disabled = true;

  try {
    const res = await fetch("/api/asset-index/build", {
      method: "POST",
      headers: { "X-Upload-Token": token },
    });

    if (!res.ok) throw new Error("build-failed");

    const data = await res.json();
    log(logEl, `构建完成`, "success");
    log(logEl, `总资产: ${data.total}`, "info");
    log(logEl, `Legacy 资产: ${data.legacy}`, "info");
    log(logEl, `上传资产: ${data.uploaded}`, "info");
    log(logEl, `缺失缩略图: ${data.missing_thumbnails}`, "info");

    if (data.missing_thumbnails > 0) {
      log(logEl, `可以使用“生成缺失缩略图”功能生成缺失的缩略图`, "info");
    }

    loadStats(token);
  } catch (err) {
    log(logEl, `构建失败: ${err.message}`, "error");
  } finally {
    buildIndexBtn.disabled = false;
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
// Generate Missing Thumbnails
// ------------------------------
generateThumbnailsBtn.addEventListener("click", async () => {
  const token = getStoredToken();
  if (!token) return openTokenOverlay();

  const logEl = document.getElementById("generateLog");
  logEl.hidden = false;
  logEl.innerHTML = "";

  log(logEl, "获取缺失缩略图清单…", "info");
  generateThumbnailsBtn.disabled = true;

  try {
    // 第一步：先获取缺失缩略图清单
    const res = await fetch("/api/maintenance/scan-missing-thumbnails", {
      method: "POST",
      headers: { "X-Upload-Token": token },
    });

    if (!res.ok) throw new Error("获取清单失败");

    const data = await res.json();
    const missingList = data.missing_list || [];

    if (missingList.length === 0) {
      log(logEl, "没有缺失的缩略图", "success");
      generateThumbnailsBtn.disabled = false;
      return;
    }

    // 第二步：先分离已有/无 asset_id 的图片
    let processableList = missingList.filter(item => item.asset_id && item.asset_id.trim());
    let unprocessableCount = missingList.length - processableList.length;

    // 第三步：自动构建资产索引（如果有无 asset_id 的图片）
    if (unprocessableCount > 0) {
      log(logEl, `检测到 ${unprocessableCount} 张图片缺少资产 ID，正在自动构建索引…`, "info");
      try {
        const buildRes = await fetch("/api/asset-index/build", {
          method: "POST",
          headers: { "X-Upload-Token": token },
        });
        if (buildRes.ok) {
          log(logEl, "资产索引构建成功", "success");
          // 重新获取缺失缩略图清单
          const res2 = await fetch("/api/maintenance/scan-missing-thumbnails", {
            method: "POST",
            headers: { "X-Upload-Token": token },
          });
          if (res2.ok) {
            const data2 = await res2.json();
            const newMissingList = data2.missing_list || [];
            processableList = newMissingList.filter(item => item.asset_id && item.asset_id.trim());
            unprocessableCount = newMissingList.length - processableList.length;
            log(logEl, `重新扫描完成：可处理 ${processableList.length} 张，仍有 ${unprocessableCount} 张无法处理`, "info");
          }
        } else {
          log(logEl, "资产索引构建失败，跳过无 ID 的图片", "error");
        }
      } catch (err) {
        log(logEl, `构建资产索引出错: ${err.message}`, "error");
      }
    }

    if (unprocessableCount > 0) {
      log(logEl, `跳过 ${unprocessableCount} 张缺少资产 ID 的图片`, "info");
    }

    if (processableList.length === 0) {
      log(logEl, "没有可处理的图片", "info");
      generateThumbnailsBtn.disabled = false;
      return;
    }

    log(logEl, `需要生成 ${processableList.length} 张缩略图…`, "info");
    log(logEl, "(串行处理，每张约 1-3 秒)", "info");

    let successCount = 0;
    let failCount = 0;
    const totalStart = Date.now();

    for (let i = 0; i < processableList.length; i++) {
      const item = processableList[i];
      const start = Date.now();

      try {
        await generateAndUploadThumbnail(item.key, item.asset_id, token);
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        const totalElapsed = ((Date.now() - totalStart) / 1000).toFixed(1);
        const avg = (parseFloat(totalElapsed) / (i + 1)).toFixed(1);
        successCount++;
        log(logEl, `[${i + 1}/${processableList.length}] ✓ ${item.key} (${elapsed}s, 平均 ${avg}s)`, "success");
      } catch (err) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        failCount++;
        log(logEl, `[${i + 1}/${processableList.length}] ✗ ${item.key} (${elapsed}s) - ${err.message}`, "error");
      }
    }

    const totalTime = ((Date.now() - totalStart) / 1000).toFixed(1);
    log(logEl, "", "info");
    log(logEl, `完成！成功: ${successCount}, 失败: ${failCount}, 总耗时: ${totalTime}s`, successCount === processableList.length ? "success" : "info");

    if (successCount > 0) {
      log(logEl, "重新构建资产索引…", "info");
      const buildRes = await fetch("/api/asset-index/build", {
        method: "POST",
        headers: { "X-Upload-Token": token },
      });
      if (buildRes.ok) {
        log(logEl, "资产索引已更新", "success");
        loadStats(token);
      } else {
        log(logEl, "资产索引更新失败，请手动点击“扫描图片”", "error");
      }
    }

  } catch (err) {
    log(logEl, `错误: ${err.message}`, "error");
  } finally {
    generateThumbnailsBtn.disabled = false;
  }
});

async function generateAndUploadThumbnail(imageKey, assetId, token) {
  const baseUrl = window.location.origin;
  // 使用 /api/file/ 代理绕过 R2 CORS 限制
  const imageUrl = `${baseUrl}/api/file/${imageKey}`;

  const img = await loadImage(imageUrl);
  const thumbnailBlob = await generateThumbnail(img);

  // 使用专门的缩略图上传 API
  const uploadUrl = "/api/upload-thumbnail";

  const formData = new FormData();
  formData.append("thumbnail", thumbnailBlob, `${assetId}.webp`);
  formData.append("asset_id", assetId);
  formData.append("original_key", imageKey);

  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: { "X-Upload-Token": token },
    body: formData,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "unknown");
    throw new Error(`上传失败: ${res.status} ${errText}`);
  }
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`无法加载图片: ${url}`));
    img.src = url;
  });
}

function generateThumbnail(img) {
  return new Promise((resolve) => {
    const maxWidth = 400;
    const maxHeight = 400;

    let width = img.width;
    let height = img.height;

    if (width > maxWidth) {
      height = (height * maxWidth) / width;
      width = maxWidth;
    }
    if (height > maxHeight) {
      width = (width * maxHeight) / height;
      height = maxHeight;
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, width, height);

    canvas.toBlob((blob) => {
      resolve(blob);
    }, "image/webp", 0.8);
  });
}

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