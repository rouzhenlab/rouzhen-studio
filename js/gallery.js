// ROUZHEN Studio — gallery.js
// 素材库页面：Token 保护 / 时间流浏览 / 多选复制 / 滚动加载

// ------------------------------
// 配置
// ------------------------------
const CONFIG = {
  API_URL: "/api/assets",
  TOKEN_STORAGE_KEY: "rz_upload_token",
  PAGE_SIZE: 50,
};

// ------------------------------
// DOM
// ------------------------------
const galleryGrid = document.getElementById("galleryGrid");
const loadMoreWrap = document.getElementById("loadMoreWrap");
const loadMoreBtn = document.getElementById("loadMoreBtn");
const galleryStatus = document.getElementById("galleryStatus");
const selectAllBtn = document.getElementById("selectAllBtn");
const copySelectedBtn = document.getElementById("copySelectedBtn");
const downloadLibraryBtn = document.getElementById("downloadLibraryBtn");

const tokenOverlay = document.getElementById("tokenOverlay");
const tokenInput = document.getElementById("tokenInput");
const tokenCancelBtn = document.getElementById("tokenCancelBtn");
const tokenConfirmBtn = document.getElementById("tokenConfirmBtn");

// ------------------------------
// 状态
// ------------------------------
let allAssets = [];         // 已加载的所有素材
let selectedKeys = new Set(); // 选中的 asset key
let nextCursor = null;
let isLoading = false;
let hasMore = true;

// ------------------------------
// 初始化：检查 Token → 加载数据
// ------------------------------
function init() {
  const token = getStoredToken();
  if (!token) {
    openTokenOverlay();
    return;
  }
  loadAssets(token);
}

// ------------------------------
// 加载素材列表
// ------------------------------
async function loadAssets(token) {
  if (isLoading || !hasMore) return;
  isLoading = true;
  setStatus("加载中…");

  try {
    const params = new URLSearchParams({ limit: String(CONFIG.PAGE_SIZE) });
    if (nextCursor) params.set("cursor", nextCursor);

    const response = await fetch(`${CONFIG.API_URL}?${params}`, {
      headers: { "X-Upload-Token": token },
    });

    if (response.status === 401 || response.status === 403) {
      clearStoredToken();
      setStatus("口令错误，请重新输入");
      openTokenOverlay();
      isLoading = false;
      return;
    }

    if (!response.ok) {
      throw new Error("api-failed");
    }

    const data = await response.json();

    allAssets = allAssets.concat(data.assets);
    nextCursor = data.cursor;
    hasMore = data.truncated;

    renderGallery();

    if (hasMore) {
      loadMoreWrap.hidden = false;
    } else {
      loadMoreWrap.hidden = true;
    }

    setStatus(allAssets.length > 0 ? `共 ${allAssets.length} 张素材` : "暂无素材");
  } catch (err) {
    setStatus("加载失败，请检查网络");
  } finally {
    isLoading = false;
  }
}

// ------------------------------
// 渲染图库（按日期分组）
// ------------------------------
function renderGallery() {
  // 按日期分组（使用 uploaded_at）
  const groups = {};
  for (const asset of allAssets) {
    const dateKey = asset.uploaded_at ? asset.uploaded_at.slice(0, 10) : "unknown";
    if (!groups[dateKey]) groups[dateKey] = [];
    groups[dateKey].push(asset);
  }

  // 按日期倒序排列
  const sortedDates = Object.keys(groups).sort((a, b) => b.localeCompare(a));

  galleryGrid.innerHTML = "";

  for (const dateKey of sortedDates) {
    // 日期标题
    const dateHeader = document.createElement("div");
    dateHeader.className = "gallery-date-header";
    dateHeader.textContent = formatDateLabel(dateKey);
    galleryGrid.appendChild(dateHeader);

    // 图片网格
    const grid = document.createElement("div");
    grid.className = "gallery-day-grid";

    for (const asset of groups[dateKey]) {
      const card = document.createElement("div");
      card.className = "gallery-card";
      card.dataset.key = asset.key;

      if (selectedKeys.has(asset.key)) {
        card.classList.add("gallery-card--selected");
      }

      // thumbnail_url 可能为空，使用占位图
      const thumbSrc = asset.thumbnail_url || `data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22150%22 height=%22150%22><rect fill=%22%23f0f0ec%22 width=%22150%22 height=%22150%22/><text x=%2275%22 y=%2280%22 text-anchor=%22middle%22 fill=%22%238a8a82%22 font-size=%2212%22>No Thumb</text></svg>`;

      card.innerHTML = `
        <div class="gallery-card-check">
          <input type="checkbox" ${selectedKeys.has(asset.key) ? "checked" : ""}>
        </div>
        <img class="gallery-card-thumb" src="${thumbSrc}" alt="${asset.filename}"
             onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22150%22 height=%22150%22><rect fill=%22%23f0f0ec%22 width=%22150%22 height=%22150%22/><text x=%2275%22 y=%2280%22 text-anchor=%22middle%22 fill=%22%238a8a82%22 font-size=%2212%22>No Thumb</text></svg>'">
        <div class="gallery-card-info">
          <span class="gallery-card-name" title="${asset.filename}">${asset.filename}</span>
        </div>
      `;

      // 点击卡片切换选中
      card.addEventListener("click", (e) => {
        if (e.target.tagName === "INPUT") return;
        toggleSelect(asset.key);
      });

      // checkbox 点击
      const checkbox = card.querySelector("input[type=checkbox]");
      checkbox.addEventListener("change", () => {
        toggleSelect(asset.key);
      });

      grid.appendChild(card);
    }

    galleryGrid.appendChild(grid);
  }
}

// ------------------------------
// 选中逻辑
// ------------------------------
function toggleSelect(key) {
  if (selectedKeys.has(key)) {
    selectedKeys.delete(key);
  } else {
    selectedKeys.add(key);
  }
  updateSelectionUI();
}

function updateSelectionUI() {
  // 更新卡片样式
  const cards = galleryGrid.querySelectorAll(".gallery-card");
  cards.forEach((card) => {
    const key = card.dataset.key;
    const isSelected = selectedKeys.has(key);
    card.classList.toggle("gallery-card--selected", isSelected);
    const checkbox = card.querySelector("input[type=checkbox]");
    if (checkbox) checkbox.checked = isSelected;
  });

  // 更新按钮状态
  copySelectedBtn.disabled = selectedKeys.size === 0;
  selectAllBtn.textContent = selectedKeys.size === allAssets.length ? "取消全选" : "全选";
}

// ------------------------------
// 全选 / 取消全选
// ------------------------------
selectAllBtn.addEventListener("click", () => {
  if (selectedKeys.size === allAssets.length) {
    selectedKeys.clear();
  } else {
    for (const asset of allAssets) {
      selectedKeys.add(asset.key);
    }
  }
  updateSelectionUI();
});

// ------------------------------
// 复制选中 Markdown
// ------------------------------
copySelectedBtn.addEventListener("click", async () => {
  if (selectedKeys.size === 0) return;

  // 按时间顺序排列选中的素材（使用 uploaded_at）
  const selected = allAssets
    .filter((a) => selectedKeys.has(a.key))
    .sort((a, b) => {
      if (!a.uploaded_at) return 1;
      if (!b.uploaded_at) return -1;
      return new Date(b.uploaded_at) - new Date(a.uploaded_at);
    });

  const markdowns = selected.map(
    (a) => a.markdown || `![${a.filename}](${a.url})`
  );
  const text = markdowns.join("\n\n");

  try {
    await navigator.clipboard.writeText(text);
    setStatus(`已复制 ${selected.length} 张图片的 Markdown`);
  } catch (err) {
    setStatus("复制失败，请手动复制");
  }
});

// ------------------------------
// 下载素材库（直接写入本地 asset-library 目录，已存在则跳过）
// ------------------------------
downloadLibraryBtn.addEventListener("click", async () => {
  const token = getStoredToken();
  if (!token) {
    openTokenOverlay();
    return;
  }

  // 检查浏览器是否支持 File System Access API
  if (!window.showDirectoryPicker) {
    setStatus("当前浏览器不支持直接写入本地目录，请使用 Chrome / Edge");
    return;
  }

  downloadLibraryBtn.disabled = true;
  downloadLibraryBtn.textContent = "生成索引中…";

  try {
    // 1. 让用户选择 asset-library 目录（可新建或选已有）
    const dirHandle = await window.showDirectoryPicker({
      mode: "readwrite",
      startIn: "desktop",
    });

    // 2. 调用后端生成 library.json
    const genRes = await fetch("/api/generate-index", {
      method: "POST",
      headers: { "X-Upload-Token": token },
    });

    if (genRes.status === 401) {
      clearStoredToken();
      openTokenOverlay();
      return;
    }
    if (!genRes.ok) throw new Error("generate-index failed");

    const genData = await genRes.json();
    setStatus(`索引已生成，共 ${genData.total} 张，正在写入本地…`);

    // 3. 获取最新 library.json
    const libRes = await fetch("/library.json");
    if (!libRes.ok) throw new Error("fetch library.json failed");
    const library = await libRes.json();

    // 4. 写入 library.json（始终覆盖）
    const libFileHandle = await dirHandle.getFileHandle("library.json", { create: true });
    const libWritable = await libFileHandle.createWritable();
    await libWritable.write(JSON.stringify(library, null, 2));
    await libWritable.close();

    // 5. 创建/获取 thumbnails 子目录
    const thumbDirHandle = await dirHandle.getDirectoryHandle("thumbnails", { create: true });

    // 6. 逐个下载缩略图（已存在则跳过）
    const assetsWithThumbs = library.assets.filter((a) => a.thumbnail_url && a.thumbnail_key);
    const total = assetsWithThumbs.length;
    let written = 0;
    let skipped = 0;

    for (const asset of assetsWithThumbs) {
      try {
        downloadLibraryBtn.textContent = `处理 ${written + skipped + 1}/${total}`;

        // 本地扁平化: thumbnails/YYYY/filename-thumb.webp（点年份就看全部图）
        // thumbnail_key 格式: thumbnails/YYYY/MM/DD/filename-thumb.webp
        const relativePath = asset.thumbnail_key.replace("thumbnails/", "");
        // relativePath: YYYY/MM/DD/filename-thumb.webp
        const pathParts = relativePath.split("/");
        // pathParts: [YYYY, MM, DD, filename]
        const year = pathParts[0];
        const fileName = pathParts[pathParts.length - 1];

        // 只创建年份目录
        const yearDir = await thumbDirHandle.getDirectoryHandle(year, { create: true });

        // 检查文件是否已存在
        try {
          await yearDir.getFileHandle(fileName);
          skipped++;
          continue; // 已存在，跳过
        } catch (e) {
          // 文件不存在，需要下载
        }

        // 下载缩略图（通过 Worker 代理绕过 R2 CORS）
        const proxyUrl = `/api/thumb/${asset.thumbnail_key}`;
        const resp = await fetch(proxyUrl);
        if (!resp.ok) continue;
        const blob = await resp.blob();

        // 写入本地年份目录
        const fileHandle = await yearDir.getFileHandle(fileName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        written++;
      } catch (e) {
        // 单张失败不影响整体
      }
    }

    setStatus(`完成！新增 ${written} 张缩略图，跳过 ${skipped} 张已存在`);
  } catch (err) {
    if (err.name === "AbortError") {
      setStatus("已取消");
    } else {
      setStatus("下载失败：" + err.message);
    }
  } finally {
    downloadLibraryBtn.disabled = false;
    downloadLibraryBtn.textContent = "⬇ 下载素材库";
  }
});

// ------------------------------
// 加载更多
// ------------------------------
loadMoreBtn.addEventListener("click", () => {
  const token = getStoredToken();
  if (token) loadAssets(token);
});

// 滚动到底部自动加载
window.addEventListener("scroll", () => {
  if (!hasMore || isLoading) return;
  const scrollBottom = window.innerHeight + window.scrollY;
  const docHeight = document.documentElement.scrollHeight;
  if (docHeight - scrollBottom < 300) {
    const token = getStoredToken();
    if (token) loadAssets(token);
  }
});

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

tokenCancelBtn.addEventListener("click", () => {
  closeTokenOverlay();
  // 取消后跳回首页
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
  loadAssets(token);
});

// ------------------------------
// Token 存储
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
    // 忽略
  }
}

function clearStoredToken() {
  try {
    localStorage.removeItem(CONFIG.TOKEN_STORAGE_KEY);
  } catch (err) {
    // 忽略
  }
}

// ------------------------------
// 工具
// ------------------------------
function formatDateLabel(dateKey) {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);

  if (dateKey === todayStr) return "今天";
  if (dateKey === yesterdayStr) return "昨天";
  return dateKey;
}

function setStatus(msg) {
  galleryStatus.textContent = msg;
}

// ------------------------------
// 启动
// ------------------------------
init();
