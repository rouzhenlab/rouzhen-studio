// ROUZHEN Studio — app.js
// 前端交互逻辑：选图预览 / 口令浮层 / 调用 Worker 上传 / 展示结果 / 复制

// ------------------------------
// 集中配置
// ------------------------------
const CONFIG = {
  WORKER_URL: "https://rouzhen-upload.leathersy.workers.dev/upload", // TODO: 替换为实际部署的 Worker 地址
  TOKEN_STORAGE_KEY: "rz_upload_token",
  SIZE_WARN_BYTES: 10 * 1024 * 1024, // 10MB，仅提示，不阻止
};

// ------------------------------
// DOM 引用
// ------------------------------
const fileInput = document.getElementById("fileInput");
const selectBtn = document.getElementById("selectBtn");
const previewWrap = document.getElementById("previewWrap");
const previewImg = document.getElementById("previewImg");
const fileNameEl = document.getElementById("fileName");
const uploadBtn = document.getElementById("uploadBtn");

const resultArea = document.getElementById("resultArea");
const resultImg = document.getElementById("resultImg");
const urlInput = document.getElementById("urlInput");
const copyBtn = document.getElementById("copyBtn");
const copyMdBtn = document.getElementById("copyMdBtn");

const statusMsg = document.getElementById("statusMsg");

const tokenOverlay = document.getElementById("tokenOverlay");
const tokenInput = document.getElementById("tokenInput");
const tokenCancelBtn = document.getElementById("tokenCancelBtn");
const tokenConfirmBtn = document.getElementById("tokenConfirmBtn");

// ------------------------------
// 状态
// ------------------------------
let selectedFile = null;
let markdownResult = "";
let pendingUploadAfterToken = false;

// ------------------------------
// 选图 & 本地预览
// ------------------------------
selectBtn.addEventListener("click", () => {
  fileInput.value = "";
  fileInput.click();
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (!file) return;

  selectedFile = file;

  const objectUrl = URL.createObjectURL(file);
  previewImg.src = objectUrl;
  previewWrap.hidden = false;

  const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
  let nameLine = `${file.name}（${sizeMB} MB）`;
  if (file.size > CONFIG.SIZE_WARN_BYTES) {
    nameLine += " · 文件较大，上传可能较慢";
  }
  fileNameEl.textContent = nameLine;

  uploadBtn.disabled = false;
  resultArea.hidden = true;
  setStatus("");
});

// ------------------------------
// 上传按钮
// ------------------------------
uploadBtn.addEventListener("click", () => {
  if (!selectedFile) return;

  const savedToken = getStoredToken();
  if (!savedToken) {
    pendingUploadAfterToken = true;
    openTokenOverlay();
    return;
  }

  startUpload(savedToken);
});

// ------------------------------
// 口令浮层
// ------------------------------
function openTokenOverlay() {
  tokenInput.value = "";
  tokenOverlay.hidden = false;
  tokenInput.focus();
}

tokenInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    tokenConfirmBtn.click();
  }
});

function closeTokenOverlay() {
  tokenOverlay.hidden = true;
}

tokenCancelBtn.addEventListener("click", (event) => {
  event.preventDefault();
  pendingUploadAfterToken = false;
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

  if (pendingUploadAfterToken) {
    pendingUploadAfterToken = false;
    startUpload(token);
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
// 上传逻辑
// ------------------------------
async function startUpload(token) {
  uploadBtn.disabled = true;
  setStatus("上传中…");

  try {
    const formData = new FormData();
    formData.append("file", selectedFile);

    const response = await fetch(CONFIG.WORKER_URL, {
      method: "POST",
      headers: {
        "X-Upload-Token": token,
      },
      body: formData,
    });

    if (response.status === 401 || response.status === 403) {
      // 口令错误：清除本地口令，重新弹出输入
      clearStoredToken();
      setStatus("口令错误，请重新输入");
      uploadBtn.disabled = false;
      pendingUploadAfterToken = true;
      openTokenOverlay();
      return;
    }

    if (!response.ok) {
      throw new Error("upload-failed");
    }

    const data = await response.json();
    showResult(data);
    setStatus("上传成功");
  } catch (err) {
    setStatus("上传失败，请检查网络后重试");
  } finally {
    uploadBtn.disabled = false;
  }
}

// ------------------------------
// 展示结果
// ------------------------------
function showResult(data) {
  resultImg.src = data.url;
  urlInput.value = data.url;
  markdownResult = data.markdown || `![image](${data.url})`;

  resultArea.hidden = false;
}

// ------------------------------
// 复制功能
// ------------------------------
copyBtn.addEventListener("click", () => {
  copyText(urlInput.value, "链接已复制");
});

copyMdBtn.addEventListener("click", () => {
  copyText(markdownResult, "Markdown 已复制");
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
// 状态提示
// ------------------------------
function setStatus(msg) {
  statusMsg.textContent = msg;
}
