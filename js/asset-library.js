// media-library.js — 媒体库前端逻辑
let currentTab = "all";
let allAssets = [];
let selectedAssetId = null;
let token = localStorage.getItem("rouzhen_token") || "";
let tabBound = false;

function $(id) { return document.getElementById(id); }

function setStatus(msg) {
  $("statusEl").textContent = msg || "";
}

function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function bindTabs() {
  if (tabBound) return;
  tabBound = true;
  document.querySelectorAll(".tab-bar .tab").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-bar .tab").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      currentTab = btn.dataset.tab;
      render();
    });
  });
}

async function fetchIndex() {
  const res = await fetch("/api/asset-index", {
    headers: { "X-Upload-Token": token },
  });

  if (res.status === 401) {
    throw new Error("unauthorized");
  }
  if (res.status === 404) {
    return { noIndex: true };
  }
  if (!res.ok) {
    throw new Error("fetch-failed");
  }
  return res.json();
}

function renderCard(asset) {
  const publicBase = window.location.origin;
  const thumbUrl = asset.thumbnail_path
    ? `${publicBase}/api/thumb/${asset.thumbnail_path}`
    : "";

  const sourceLabel = asset.source === "upload" ? "上传" : "Legacy";
  const statusLabel = asset.thumbnail_status === "generated" ? "已生成" : "待生成";

  return `
    <div class="asset-card" data-id="${escapeHtml(asset.asset_id)}" data-path="${escapeHtml(asset.original_path)}">
      <div class="asset-thumb-wrap">
        ${thumbUrl
          ? `<img class="asset-thumb" src="${escapeHtml(thumbUrl)}" loading="lazy" alt="" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
             <div class="asset-thumb-placeholder" style="display:none;">缩略图生成中</div>`
          : `<div class="asset-thumb-placeholder">缩略图待生成</div>`
        }
      </div>
      <div class="asset-info">
        <div class="asset-filename" title="${escapeHtml(asset.original_path)}">${escapeHtml(asset.original_name || asset.original_path.split("/").pop())}</div>
        <div class="asset-meta">
          <span class="asset-source">${sourceLabel}</span>
          <span class="asset-status">${statusLabel}</span>
        </div>
      </div>
    </div>
  `;
}

function render() {
  const grid = $("assetGrid");
  const metaContainer = $("metadataContainer");
  const gridContainer = $("gridContainer");

  if (currentTab === "metadata") {
    gridContainer.hidden = true;
    metaContainer.hidden = false;
    if (selectedAssetId) {
      const asset = allAssets.find(a => a.asset_id === selectedAssetId);
      if (asset) {
        metaContainer.innerHTML = `
          <h3>${escapeHtml(asset.original_name || asset.original_path)}</h3>
          <pre class="meta-pre">${escapeHtml(JSON.stringify(asset, null, 2))}</pre>
        `;
      }
    } else {
      metaContainer.innerHTML = `<p style="color:#666;font-size:0.85rem;">从列表中点击任意资产卡片，可在此查看完整元数据。</p>`;
    }
    return;
  }

  gridContainer.hidden = false;
  metaContainer.hidden = true;

  let filtered = allAssets;
  if (currentTab === "missing") {
    filtered = allAssets.filter(a => a.thumbnail_status === "pending" || !a.thumbnail_path);
  }

  if (filtered.length === 0) {
    grid.innerHTML = `<p style="color:#666;padding:24px;">暂无媒体资产</p>`;
    return;
  }

  grid.innerHTML = filtered.map(renderCard).join("");

  grid.querySelectorAll(".asset-card").forEach(card => {
    card.addEventListener("click", () => {
      const id = card.dataset.id;
      selectedAssetId = id;
      // 切换到元数据标签
      document.querySelectorAll(".tab-bar .tab").forEach(b => {
        b.classList.toggle("active", b.dataset.tab === "metadata");
      });
      currentTab = "metadata";
      render();
    });
  });
}

async function loadAssets() {
  setStatus("加载资产索引…");
  try {
    const data = await fetchIndex();
    if (data.noIndex) {
      allAssets = [];
      setStatus("资产索引未构建，请点击「构建索引」");
      $("assetGrid").innerHTML = `<p style="color:#666;padding:24px;">资产索引未构建</p>`;
      return;
    }
    allAssets = data.assets || [];
    setStatus(`已加载 ${allAssets.length} 个资产`);
    render();
  } catch (err) {
    if (err.message === "unauthorized") {
      openTokenOverlay();
    } else {
      setStatus("加载失败: " + err.message);
    }
  }
}

async function buildIndex() {
  setStatus("正在构建资产索引…");
  try {
    const res = await fetch("/api/asset-index/build", {
      method: "POST",
      headers: { "X-Upload-Token": token },
    });
    if (res.status === 401) {
      openTokenOverlay();
      return;
    }
    if (!res.ok) {
      setStatus("构建失败");
      return;
    }
    const data = await res.json();
    setStatus(`构建完成：总计 ${data.total}，缺失缩略图 ${data.missing_thumbnails}`);
    await loadAssets();
  } catch (err) {
    setStatus("构建失败: " + err.message);
  }
}

// Token Overlay
function openTokenOverlay() {
  $("tokenOverlay").hidden = false;
  $("tokenInput").focus();
}

function closeTokenOverlay() {
  $("tokenOverlay").hidden = true;
}

async function confirmToken() {
  const val = $("tokenInput").value.trim();
  if (!val) return;
  token = val;
  localStorage.setItem("rouzhen_token", val);
  closeTokenOverlay();
  await loadAssets();
}

function cancelToken() {
  closeTokenOverlay();
  $("tokenInput").value = "";
}

// Init
function init() {
  bindTabs();
  $("refreshBtn").addEventListener("click", loadAssets);
  $("buildIndexBtn").addEventListener("click", buildIndex);
  $("tokenConfirmBtn").addEventListener("click", confirmToken);
  $("tokenCancelBtn").addEventListener("click", cancelToken);
  $("tokenInput").addEventListener("keydown", e => {
    if (e.key === "Enter") confirmToken();
    if (e.key === "Escape") cancelToken();
  });

  if (!token) {
    openTokenOverlay();
  } else {
    loadAssets();
  }
}

init();
