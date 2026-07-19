// ROUZHEN Studio — app.js
// v0.2：多图上传 / 缩略图生成 / 上传队列 / 口令保护 / 复制结果

// ------------------------------
// 集中配置
// ------------------------------
const CONFIG = {
  WORKER_URL: "/upload",
  TOKEN_STORAGE_KEY: "rz_upload_token",
  SIZE_WARN_BYTES: 10 * 1024 * 1024, // 10MB，仅提示
  THUMB_MAX_DIM: 300,
};

// ------------------------------
// DOM 引用
// ------------------------------
const fileInput = document.getElementById("fileInput");
const selectBtn = document.getElementById("selectBtn");
const queueArea = document.getElementById("queueArea");
const uploadBtn = document.getElementById("uploadBtn");

const resultArea = document.getElementById("resultArea");
const resultList = document.getElementById("resultList");
const copyUrlBtn = document.getElementById("copyUrlBtn");
const copyMdBtn = document.getElementById("copyMdBtn");

const statusMsg = document.getElementById("statusMsg");

const tokenOverlay = document.getElementById("tokenOverlay");
const tokenInput = document.getElementById("tokenInput");
const tokenCancelBtn = document.getElementById("tokenCancelBtn");
const tokenConfirmBtn = document.getElementById("tokenConfirmBtn");

// ------------------------------
// 状态
// ------------------------------
let uploadQueue = [];   // { id, file, previewUrl, thumbnail, status, result }
let isUploading = false;
let nextQueueId = 0;
let allMarkdown = "";
let allUrls = "";
let pendingBatchAfterToken = false;

// ------------------------------
// 缩略图生成（Canvas → WebP，失败降级 JPEG）
// ------------------------------
async function generateThumbnail(file) {
  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;
  const maxDim = CONFIG.THUMB_MAX_DIM;

  let tw, th;
  if (width >= height) {
    tw = maxDim;
    th = Math.round((height / width) * maxDim);
  } else {
    th = maxDim;
    tw = Math.round((width / height) * maxDim);
  }

  const canvas = document.createElement("canvas");
  canvas.width = tw;
  canvas.height = th;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, tw, th);
  bitmap.close();

  // 优先 WebP，不支持则降级 JPEG
  let blob;
  try {
    blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.8 });
  } catch (e) {
    blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 });
  }
  const ext = blob.type === "image/webp" ? ".webp" : ".jpg";
  return new File([blob], `thumb-${file.name}${ext}`, { type: blob.type });
}

// ------------------------------
// 选图（支持 multiple）
// ------------------------------
selectBtn.addEventListener("click", () => {
  fileInput.value = "";
  fileInput.click();
});

fileInput.addEventListener("change", () => {
  const files = Array.from(fileInput.files);
  if (files.length === 0) return;

  for (const file of files) {
    if (!file.type.startsWith("image/")) continue;

    const previewUrl = URL.createObjectURL(file);
    uploadQueue.push({
      id: nextQueueId++,
      file,
      previewUrl,
      thumbnail: null,
      status: "waiting",
      result: null,
    });
  }

  renderQueue();
  uploadBtn.disabled = uploadQueue.length === 0;
  resultArea.hidden = true;
  setStatus("");
});

// ------------------------------
// 渲染上传队列
// ------------------------------
function renderQueue() {
  queueArea.innerHTML = "";

  for (const item of uploadQueue) {
    const div = document.createElement("div");
    div.className = "queue-item";
    div.dataset.id = item.id;

    const thumbSrc = item.previewUrl;
    const statusText = {
      waiting: "等待上传",
      generating: "生成缩略图…",
      uploading: "上传中…",
      done: "✓ 完成",
      error: "✗ 失败",
    }[item.status];

    const statusClass = `queue-status queue-status--${item.status}`;

    div.innerHTML = `
      <img class="queue-thumb" src="${thumbSrc}" alt="">
      <span class="queue-name">${item.file.name}</span>
      <span class="${statusClass}">${statusText}</span>
    `;

    queueArea.appendChild(div);
  }

  queueArea.hidden = false;
}

function updateQueueItemStatus(id) {
  const el = queueArea.querySelector(`[data-id="${id}"]`);
  if (!el) return;

  const item = findQueueItem(id);
  if (!item) return;

  const statusText = {
    waiting: "等待上传",
    generating: "生成缩略图…",
    uploading: "上传中…",
    done: "✓ 完成",
    error: "✗ 失败",
  }[item.status];

  const statusEl = el.querySelector(".queue-status");
  if (statusEl) {
    statusEl.textContent = statusText;
    statusEl.className = `queue-status queue-status--${item.status}`;
  }
}

// ------------------------------
// 上传按钮
// ------------------------------
uploadBtn.addEventListener("click", () => {
  if (isUploading || uploadQueue.length === 0) return;

  const savedToken = getStoredToken();
  if (!savedToken) {
    pendingBatchAfterToken = true;
    openTokenOverlay();
    return;
  }

  startBatchUpload(savedToken);
});

// ------------------------------
// 批量上传（逐个处理）
// ------------------------------
async function startBatchUpload(token) {
  isUploading = true;
  uploadBtn.disabled = true;

  const batchId = generateBatchId();
  let successCount = 0;
  let failCount = 0;

  for (const item of uploadQueue) {
    if (item.status === "done") continue;

    // 生成缩略图
    item.status = "generating";
    updateQueueItemStatus(item.id);

    try {
      item.thumbnail = await generateThumbnail(item.file);
    } catch (err) {
      // HEIC 等格式可能失败，缩略图为 null 也继续上传
      item.thumbnail = null;
    }

    // 上传
    item.status = "uploading";
    updateQueueItemStatus(item.id);
    setStatus(`上传中 ${successCount + failCount + 1}/${uploadQueue.length}…`);

    try {
      const result = await uploadSingleFile(item.file, item.thumbnail, token, batchId);
      item.status = "done";
      item.result = result;
      successCount++;
    } catch (err) {
      item.status = "error";
      failCount++;

      // 口令错误：停止后续上传，弹出重新输入
      if (err.message === "unauthorized") {
        clearStoredToken();
        updateQueueItemStatus(item.id);
        setStatus("口令错误，请重新输入");
        pendingBatchAfterToken = true;
        openTokenOverlay();
        isUploading = false;
        uploadBtn.disabled = false;
        return;
      }
    }

    updateQueueItemStatus(item.id);
  }

  isUploading = false;
  uploadBtn.disabled = false;

  if (failCount === 0) {
    setStatus(`全部上传成功（${successCount} 张）`);
  } else {
    setStatus(`上传完成：${successCount} 成功，${failCount} 失败`);
  }

  showResults();
}

// ------------------------------
// 单文件上传
// ------------------------------
async function uploadSingleFile(file, thumbnail, token, batchId) {
  const formData = new FormData();
  formData.append("file", file);
  if (thumbnail) {
    formData.append("thumbnail", thumbnail);
  }

  const response = await fetch(CONFIG.WORKER_URL, {
    method: "POST",
    headers: {
      "X-Upload-Token": token,
      "X-Batch-Id": batchId,
    },
    body: formData,
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error("unauthorized");
  }

  if (!response.ok) {
    throw new Error("upload-failed");
  }

  return response.json();
}

// ------------------------------
// 批次 ID 生成
// ------------------------------
function generateBatchId() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const h = String(now.getUTCHours()).padStart(2, "0");
  const min = String(now.getUTCMinutes()).padStart(2, "0");
  const s = String(now.getUTCSeconds()).padStart(2, "0");
  return `${y}${m}${d}-${h}${min}${s}`;
}

// ------------------------------
// 口令浮层
// ------------------------------
function openTokenOverlay() {
  tokenInput.value = "";
  tokenOverlay.hidden = false;
  tokenInput.focus();
}

function closeTokenOverlay() {
  tokenOverlay.hidden = true;
}

tokenInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    tokenConfirmBtn.click();
  }
});

tokenCancelBtn.addEventListener("click", (event) => {
  event.preventDefault();
  pendingBatchAfterToken = false;
  closeTokenOverlay();
});

tokenConfirmBtn.addEventListener("click", (event) => {
  event.preventDefault();

  const token = tokenInput.value.trim();
  if (!token) {
    setStatus("请输入口令");
    return;
  }

  saveStoredToken(token);
  closeTokenOverlay();

  if (pendingBatchAfterToken) {
    pendingBatchAfterToken = false;
    startBatchUpload(token);
  }
});

// ------------------------------
// 口令存储辅助
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
  } catch (err) {
    setStatus("浏览器存储不可用，口令将只在本次会话中生效");
  }
}

function clearStoredToken() {
  try {
    localStorage.removeItem(CONFIG.TOKEN_STORAGE_KEY);
  } catch (err) {
    // 忽略存储异常
  }
}

// ------------------------------
// 展示结果
// ------------------------------
function showResults() {
  const items = uploadQueue.filter((i) => i.status === "done" && i.result);
  if (items.length === 0) return;

  resultList.innerHTML = "";

  const urls = [];
  const mds = [];

  for (const item of items) {
    const url = item.result.url;
    const md = item.result.markdown || `![image](${url})`;
    urls.push(url);
    mds.push(md);

    const card = document.createElement("div");
    card.className = "result-item";
    card.innerHTML = `
      <img class="result-item-img" src="${url}" alt="">
      <span class="result-item-name">${item.file.name}</span>
    `;
    resultList.appendChild(card);
  }

  allUrls = urls.join("\n");
  allMarkdown = mds.join("\n\n");

  resultArea.hidden = false;
}

// ------------------------------
// 复制功能
// ------------------------------
copyUrlBtn.addEventListener("click", () => {
  copyText(allUrls, "链接已复制");
});

copyMdBtn.addEventListener("click", () => {
  copyText(allMarkdown, "Markdown 已复制");
});

async function copyText(text, successMsg) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    setStatus(successMsg);
  } catch (err) {
    setStatus("复制失败，请长按手动复制");
  }
}

// ------------------------------
// 工具
// ------------------------------
function findQueueItem(id) {
  return uploadQueue.find((i) => i.id === id);
}

function setStatus(msg) {
  statusMsg.textContent = msg;
}
