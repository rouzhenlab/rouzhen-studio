// ROUZHEN Studio v0.3.1 — Asset Library
// 简化版 UI：缩略图展示 + Markdown 复制 + metadata 查看 + 缺失列表

const CONFIG = {
  TOKEN_STORAGE_KEY: "rz_upload_token",
};

// State
let allAssets = [];
let currentTab = "all";
let selectedAssetId = null;

// DOM
const assetGrid = document.getElementById("assetGrid");
const statusEl = document.getElementById("statusEl");
const gridContainer = document.getElementById("gridContainer");
const metadataContainer = document.getElementById("metadataContainer");
const metadataPanel = document.getElementById("metadataPanel");
const metadataContent = document.getElementById("metadataContent");
const refreshBtn = document.getElementById("refreshBtn");
const buildIndexBtn = document.getElementById("buildIndexBtn");
const toast = document.getElementById("toast");
const tokenOverlay = document.getElementById("tokenOverlay");
const tokenInput = document.getElementById("tokenInput");
const tokenCancelBtn = document.getElementById("tokenCancelBtn");
const tokenConfirmBtn = document.getElementById("tokenConfirmBtn");
const tabs = document.querySelectorAll(".tab");

// Init
function init() {
  const token = getStoredToken();
  if (!token) {
    openTokenOverlay();
    return;
  }
  loadAssetIndex();
}

// Load Asset Index
async function loadAssetIndex() {
  setStatus("加载 Asset Index...");
  try {
    const res = await fetch("/api/asset-index", {
      headers: { "X-Upload-Token": getStoredToken() },
    });

    if (res.status === 401 || res.status === 403) {
      clearStoredToken();
      openTokenOverlay();
      return;
    }

    if (res.status === 404) {
      setStatus("Asset Index 未构建，请点击「构建索引」");
      allAssets = [];
      renderCurrentTab();
      return;
    }

    if (!res.ok) throw new Error("加载失败");

    const data = await res.json();
    allAssets = data.assets || [];
    setStatus(`已加载 ${allAssets.length} 个资产`);
    renderCurrentTab();
  } catch (err) {
    setStatus("加载失败: " + err.message);
  }
}

// Build Index
async function buildIndex() {
  const token = getStoredToken();
  if (!token) return;

  setStatus("正在构建 Asset Index...");
  buildIndexBtn.disabled = true;

  try {
    const res = await fetch("/api/asset-index/build", {
      method: "POST",
      headers: { "X-Upload-Token": token },
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.message || "构建失败");
    }

    const data = await res.json();
    setStatus(`构建完成: ${data.total} 个资产，${data.missing_thumbnails} 个缺失缩略图`);
    await loadAssetIndex();
  } catch (err) {
    setStatus("构建失败: " + err.message);
  } finally {
    buildIndexBtn.disabled = false;
  }
}

// Render current tab
function renderCurrentTab() {
  if (currentTab === "metadata") {
    gridContainer.hidden = true;
    metadataContainer.hidden = false;
    if (selectedAssetId) {
      loadMetadata(selectedAssetId);
    } else {
      metadataPanel.hidden = true;
    }
    return;
  }

  gridContainer.hidden = false;
  metadataContainer.hidden = true;
  assetGrid.innerHTML = "";

  let displayList = allAssets;
  if (currentTab === "missing") {
    displayList = allAssets.filter(a => a.thumbnail_status === "missing");
  }

  if (displayList.length === 0) {
    assetGrid.innerHTML = '<div class="empty-state">暂无数据</div>';
    return;
  }

  for (const assetSummary of displayList) {
    // 加载完整 metadata 渲染卡片
    loadAndRenderCard(assetSummary.asset_id);
  }
}

// 加载并渲染单张卡片
async function loadAndRenderCard(assetId) {
  try {
    const res = await fetch(`/api/asset-index/${assetId}`, {
      headers: { "X-Upload-Token": getStoredToken() },
    });
    if (!res.ok) return;

    const metadata = await res.json();
    renderCard(metadata);
  } catch (err) {
    // 忽略单卡错误
  }
}

// 渲染单张资产卡片
function renderCard(metadata) {
  const card = document.createElement("div");
  card.className = "asset-card gallery-card";
  card.dataset.assetId = metadata.asset_id;

  // 缩略图 URL（统一走代理）
  const thumbSrc = metadata.thumbnail_path
    ? `/api/thumb/${metadata.thumbnail_path}`
    : getPlaceholderImage();

  const statusBadge = `
    <div class="status-badge status-${metadata.thumbnail_status}">
      ${metadata.thumbnail_status === 'generated' ? '✓' : '⚠'}
    </div>
  `;

  card.innerHTML = `
    ${statusBadge}
    <img class="asset-thumb" src="${thumbSrc}" alt="${metadata.asset_id}"
         onerror="this.src='${getPlaceholderImage()}'">
    <div class="asset-info">
      <div class="asset-id" title="${metadata.asset_id}">${metadata.asset_id}</div>
      <div class="asset-name" title="${metadata.original_name}">${metadata.original_name}</div>
      ${metadata.uploaded_at ? `<div class="asset-date">${formatDate(metadata.uploaded_at)}</div>` : ''}
    </div>
  `;

  // 点击：根据当前 tab 行为不同
  card.addEventListener("click", () => {
    if (currentTab === "metadata") {
      selectedAssetId = metadata.asset_id;
      loadMetadata(metadata.asset_id);
    } else {
      copyMarkdown(metadata);
    }
  });

  assetGrid.appendChild(card);
}

// 加载并显示 metadata
async function loadMetadata(assetId) {
  try {
    const res = await fetch(`/api/asset-index/${assetId}`, {
      headers: { "X-Upload-Token": getStoredToken() },
    });
    if (!res.ok) {
      metadataContent.textContent = "加载失败";
      metadataPanel.hidden = false;
      return;
    }

    const metadata = await res.json();
    metadataContent.textContent = JSON.stringify(metadata, null, 2);
    metadataPanel.hidden = false;
  } catch (err) {
    metadataContent.textContent = "错误: " + err.message;
    metadataPanel.hidden = false;
  }
}

// 复制 Markdown
async function copyMarkdown(metadata) {
  const baseUrl = window.location.origin;
  // 优先使用缩略图 URL（assets/thumbnails/{asset_id}.webp）
  const targetUrl = metadata.thumbnail_path
    ? `${baseUrl}/${metadata.thumbnail_path}`
    : `${baseUrl}/${metadata.original_path}`;
  const markdown = `![ROUZHEN Asset](${targetUrl})`;

  try {
    await navigator.clipboard.writeText(markdown);
    showToast(`已复制: ${metadata.asset_id}`);
  } catch (err) {
    showToast("复制失败");
  }
}

// 占位图（无缩略图时）
function getPlaceholderImage() {
  return "data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22150%22 height=%22150%22><rect fill=%22%23f0f0ec%22 width=%22150%22 height=%22150%22/><text x=%2275%22 y=%2280%22 text-anchor=%22middle%22 fill=%22%238a8a82%22 font-size=%2212%22>No Thumb</text></svg>";
}

// 格式化日期
function formatDate(dateStr) {
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return "";
  return date.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
}

// Tab 切换
tabs.forEach(tab => {
  tab.addEventListener("click", () => {
    tabs.forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    currentTab = tab.dataset.tab;
    selectedAssetId = null;
    renderCurrentTab();
  });
});

// Buttons
refreshBtn.addEventListener("click", loadAssetIndex);
buildIndexBtn.addEventListener("click", buildIndex);

// Token
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
  if (!token) return;
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

// Token Storage
function getStoredToken() {
  try { return localStorage.getItem(CONFIG.TOKEN_STORAGE_KEY); } catch (e) { return ""; }
}
function saveStoredToken(token) {
  try { localStorage.setItem(CONFIG.TOKEN_STORAGE_KEY, token); } catch (e) {}
}
function clearStoredToken() {
  try { localStorage.removeItem(CONFIG.TOKEN_STORAGE_KEY); } catch (e) {}
}

// Utils
function setStatus(msg) { statusEl.textContent = msg; }

function showToast(msg) {
  toast.textContent = msg;
  toast.hidden = false;
  setTimeout(() => { toast.hidden = true; }, 2000);
}

// Start
init();