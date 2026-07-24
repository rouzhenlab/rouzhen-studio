// ROUZHEN Studio — editor.js
// v0.5.0 Step 2：Article Editor ↔ Asset Library 的连接
// 只做一件事：点右侧缩略图，在光标位置插入 {{asset:asset_id}}，面板不关闭

const CONFIG = {
  TOKEN_STORAGE_KEY: "rz_upload_token",
  RECENT_LIMIT: 20,
};

const textarea = document.getElementById("articleTextarea");
const assetGrid = document.getElementById("assetGrid");
const assetMsg = document.getElementById("assetMsg");

function getToken() {
  return localStorage.getItem(CONFIG.TOKEN_STORAGE_KEY);
}

// ------------------------------
// 在光标位置插入文本，保持光标在插入内容之后，不影响 textarea 的焦点
// ------------------------------
function insertAtCursor(text) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const before = textarea.value.substring(0, start);
  const after = textarea.value.substring(end);

  textarea.value = before + text + after;

  const newPos = start + text.length;
  textarea.focus();
  textarea.setSelectionRange(newPos, newPos);
}

// ------------------------------
// 加载最近上传的素材
// ------------------------------
async function loadRecentAssets() {
  const token = getToken();
  if (!token) {
    assetMsg.textContent = "未找到上传口令，请先在首页上传一次图片";
    return;
  }

  assetMsg.textContent = "加载中…";

  try {
    const res = await fetch(`/api/assets?limit=${CONFIG.RECENT_LIMIT}`, {
      headers: { "X-Upload-Token": token },
    });

    if (!res.ok) throw new Error("assets-failed");
    const data = await res.json();

    assetGrid.innerHTML = "";

    if (!data.assets || data.assets.length === 0) {
      assetMsg.textContent = "素材库还没有图片";
      return;
    }

    assetMsg.textContent = "";

    for (const asset of data.assets) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "asset-thumb-btn";

      const hasAssetId = Boolean(asset.asset_id);
      if (!hasAssetId) {
        // 老资产可能没有对应的 asset_id（早于 Asset Index 引入之前上传的），
        // 没有 asset_id 就没法生成 {{asset:id}}，先禁用，不强行插入错误引用
        btn.classList.add("asset-thumb-btn--disabled");
        btn.disabled = true;
        btn.title = "这张图没有 asset_id，暂时无法插入引用";
      } else {
        btn.title = asset.filename;
      }

      const img = document.createElement("img");
      img.src = asset.thumbnail_url || asset.url;
      img.alt = asset.filename;
      img.loading = "lazy";
      btn.appendChild(img);

      if (hasAssetId) {
        btn.addEventListener("click", () => {
          insertAtCursor(`{{asset:${asset.asset_id}}}`);

          // 短暂的"已插入"反馈，不影响继续点其他缩略图
          btn.classList.add("asset-thumb-btn--inserted");
          setTimeout(() => btn.classList.remove("asset-thumb-btn--inserted"), 900);
        });
      }

      assetGrid.appendChild(btn);
    }
  } catch (err) {
    assetMsg.textContent = "加载素材库失败，请检查网络";
  }
}

loadRecentAssets();
