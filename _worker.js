// ROUZHEN Studio — Pages Functions (_worker.js)
// v0.3.13：Asset Index Layer
// - v0.3 基础架构保留（R2 唯一数据源 + 镜像缩略图）
// - 新增 Asset Index Layer：管理 asset_id + metadata + 缩略图状态
// - 旧图片保持原路径，新上传使用 Asset ID 命名
// - 缩略图状态管理：pending / generated / missing

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Upload-Token, X-Batch-Id",
};

const ASSETS_API_LIMIT = 50;

const SYSTEM_PREFIXES = [
  "thumbnails/",
  "assets/",
  "library.json",
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS 预检
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // 路由分发
    if (url.pathname === "/upload" && request.method === "POST") {
      return handleUpload(request, env);
    }

    // 缩略图上传 API（专门用于维护页面生成缩略图）
    if (url.pathname === "/api/upload-thumbnail" && request.method === "POST") {
      return handleUploadThumbnail(request, env);
    }

    if (url.pathname === "/api/assets" && request.method === "GET") {
      return handleListAssets(request, env);
    }

    if (url.pathname === "/api/generate-index" && request.method === "POST") {
      return handleGenerateIndex(request, env);
    }

    if (url.pathname === "/library.json" && request.method === "GET") {
      return handleGetLibrary(env);
    }

    // Maintenance API
    if (url.pathname === "/api/maintenance/scan" && request.method === "POST") {
      return handleMaintenanceScan(request, env);
    }

    if (url.pathname === "/api/maintenance/scan-missing-thumbnails" && request.method === "POST") {
      return handleScanMissingThumbnails(request, env);
    }

    if (url.pathname === "/api/maintenance/clean-orphans" && request.method === "POST") {
      return handleCleanOrphans(request, env);
    }

    if (url.pathname === "/api/maintenance/stats" && request.method === "GET") {
      return handleMaintenanceStats(request, env);
    }

    // 缩略图代理（绕过 R2 公开 URL 的 CORS 限制）
    if (url.pathname.startsWith("/api/thumb/") && request.method === "GET") {
      return handleThumbProxy(url, env);
    }

    // 文件代理（绕过 R2 公开 URL 的 CORS 限制，用于 Canvas 加载图片）
    if (url.pathname.startsWith("/api/file/") && request.method === "GET") {
      return handleFileProxy(url, env);
    }

    // Asset Index API (v0.3.13)
    if (url.pathname === "/api/asset-index/build" && request.method === "POST") {
      return handleBuildAssetIndex(request, env);
    }

    if (url.pathname === "/api/asset-index" && request.method === "GET") {
      return handleGetAssetIndex(request, env);
    }

    if (url.pathname.startsWith("/api/asset-index/rz_") && request.method === "GET") {
      return handleGetAssetMetadata(request, env);
    }

    if (url.pathname === "/api/asset-index/thumbnail-queue" && request.method === "GET") {
      return handleGetThumbnailQueue(request, env);
    }

    if (url.pathname.startsWith("/api/asset-index/rz_") && request.method === "PUT") {
      return handleUpdateThumbnailStatus(request, env);
    }

    // 其他请求交给 Pages 静态资源
    return env.ASSETS.fetch(request);
  },
};

// ------------------------------
// POST /upload — 上传原图 + 缩略图
// v0.3.13: 新上传使用 Asset ID 命名
// ------------------------------
async function handleUpload(request, env) {
  // 口令校验
  const token = request.headers.get("X-Upload-Token") || "";
  if (!env.UPLOAD_TOKEN || token !== env.UPLOAD_TOKEN) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  // 批次 ID（可选，用于 metadata）
  const batchId = request.headers.get("X-Batch-Id") || "";

  // 解析表单
  let formData;
  try {
    formData = await request.formData();
  } catch (err) {
    return jsonResponse({ error: "invalid-form" }, 400);
  }

  const file = formData.get("file");
  if (!file || typeof file === "string") {
    return jsonResponse({ error: "no-file" }, 400);
  }

  // MIME 类型校验
  if (!ALLOWED_MIME_TYPES.includes(file.type)) {
    return jsonResponse({ error: "invalid-type" }, 400);
  }

  // 大小校验
  if (file.size > MAX_FILE_SIZE) {
    return jsonResponse({ error: "file-too-large" }, 400);
  }

  // v0.3.13: 生成 Asset ID
  const now = new Date();
  const assetId = generateAssetId(now);
  const ext = extractExtension(file.name, file.type);

  // 新上传路径: media/original/{asset_id}.{ext}
  const imageKey = `media/original/${assetId}${ext}`;
  const originalName = file.name;

  // 自定义 metadata
  const customMetadata = {
    "asset-id": assetId,
    "original-name": originalName,
  };
  if (batchId) {
    customMetadata["batch-id"] = batchId;
  }
  customMetadata["deleted"] = "false";

  // 写入原图到 R2
  try {
    await env.BUCKET.put(imageKey, file.stream(), {
      httpMetadata: { contentType: file.type },
      customMetadata,
    });
  } catch (err) {
    return jsonResponse({ error: "upload-failed" }, 500);
  }

  // 写入缩略图到 R2（如果前端提供了）
  const thumbnail = formData.get("thumbnail");
  let thumbnailUrl = "";
  let thumbnailKey = "";

  if (thumbnail && typeof thumbnail !== "string" && thumbnail.size > 0) {
    // v0.3.13: 统一缩略图路径 assets/thumbnails/{asset_id}.webp
    const thumbExt = ".webp"; // 统一使用 webp
    thumbnailKey = `assets/thumbnails/${assetId}${thumbExt}`;

    try {
      const thumbBuffer = await thumbnail.arrayBuffer();
      await env.BUCKET.put(thumbnailKey, thumbBuffer, {
        httpMetadata: { contentType: "image/webp" },
        customMetadata: { "asset-id": assetId, "original-key": imageKey },
      });
      thumbnailUrl = `${env.PUBLIC_BASE_URL}/${thumbnailKey}`;
    } catch (err) {
      // 缩略图写入失败不影响原图上传
    }
  }

  // v0.3.13: 创建 metadata 文件
  const metadata = {
    asset_id: assetId,
    source: "upload",
    original_path: imageKey,
    original_name: originalName,
    type: "image",
    mime: file.type,
    size: file.size,
    width: null,
    height: null,
    uploaded_at: now.toISOString(),
    thumbnail_status: thumbnailKey ? "generated" : "pending",
    thumbnail_path: thumbnailKey || "",
    title: "",
    description: "",
    used_in: [],
    tags: [],
    article_ref: null,
    batch_id: batchId || null,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };

  try {
    await env.BUCKET.put(
      `assets/metadata/${assetId}.json`,
      JSON.stringify(metadata, null, 2),
      { httpMetadata: { contentType: "application/json" } }
    );
  } catch (err) {
    // metadata 写入失败不影响上传
  }

  const publicUrl = `${env.PUBLIC_BASE_URL}/${imageKey}`;

  return jsonResponse({
    asset_id: assetId,
    url: publicUrl,
    thumbnail_url: thumbnailUrl,
    thumbnail_status: metadata.thumbnail_status,
    markdown: `![${assetId}](${publicUrl})`,
    filename: `${assetId}${ext}`,
    key: imageKey,
    original_name: originalName,
  });
}

// ------------------------------
// POST /api/upload-thumbnail — 专门用于上传缩略图
// 前端 Canvas 生成缩略图后调用此 API
// ------------------------------
async function handleUploadThumbnail(request, env) {
  // 口令校验
  const token = request.headers.get("X-Upload-Token") || "";
  if (!env.UPLOAD_TOKEN || token !== env.UPLOAD_TOKEN) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  // 解析表单
  let formData;
  try {
    formData = await request.formData();
  } catch (err) {
    return jsonResponse({ error: "invalid-form" }, 400);
  }

  const thumbnail = formData.get("thumbnail");
  if (!thumbnail || typeof thumbnail === "string") {
    return jsonResponse({ error: "no-thumbnail" }, 400);
  }

  // 获取参数
  const assetId = formData.get("asset_id");
  const originalKey = formData.get("original_key");

  if (!assetId) {
    return jsonResponse({ error: "missing-asset-id" }, 400);
  }

  // 缩略图路径
  const thumbnailKey = `assets/thumbnails/${assetId}.webp`;

  // 写入 R2
  try {
    const thumbBuffer = await thumbnail.arrayBuffer();
    await env.BUCKET.put(thumbnailKey, thumbBuffer, {
      httpMetadata: { contentType: "image/webp" },
      customMetadata: {
        "asset-id": assetId,
        "original-key": originalKey || "",
      },
    });
  } catch (err) {
    return jsonResponse({ error: "upload-failed" }, 500);
  }

  // 更新 metadata 状态
  try {
    const metadataKey = `assets/metadata/${assetId}.json`;
    const metadataObj = await env.BUCKET.get(metadataKey);
    if (metadataObj) {
      const metadata = JSON.parse(await metadataObj.text());
      metadata.thumbnail_status = "generated";
      metadata.thumbnail_path = thumbnailKey;
      metadata.updated_at = new Date().toISOString();
      await env.BUCKET.put(metadataKey, JSON.stringify(metadata, null, 2), {
        httpMetadata: { contentType: "application/json" },
      });
    }

    // 更新索引
    const indexObj = await env.BUCKET.get("assets/metadata/index.json");
    if (indexObj) {
      const index = JSON.parse(await indexObj.text());
      const assetIndex = index.assets.findIndex(a => a.asset_id === assetId);
      if (assetIndex !== -1) {
        index.assets[assetIndex].thumbnail_status = "generated";
        await env.BUCKET.put("assets/metadata/index.json", JSON.stringify(index, null, 2), {
          httpMetadata: { contentType: "application/json" },
        });
      }
    }
  } catch (err) {
    // 更新失败不影响上传成功
  }

  return jsonResponse({
    success: true,
    asset_id: assetId,
    thumbnail_key: thumbnailKey,
    thumbnail_url: `${env.PUBLIC_BASE_URL}/${thumbnailKey}`,
  });
}

// ------------------------------
// GET /api/assets — 素材列表（分页）
// v0.3.13: 全量扫描 Bucket，排除系统目录，检查两种缩略图路径
// ------------------------------
async function handleListAssets(request, env) {
  // 口令校验（gallery 也受 Token 保护）
  const token = request.headers.get("X-Upload-Token") || "";
  if (!env.UPLOAD_TOKEN || token !== env.UPLOAD_TOKEN) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  const url = new URL(request.url);
  const limit = parseInt(url.searchParams.get("limit") || String(ASSETS_API_LIMIT), 10);

  // 加载 Asset Index 获取 original_path -> asset_id 映射
  const pathToAssetId = new Map();
  try {
    const indexObj = await env.BUCKET.get("assets/metadata/index.json");
    if (indexObj) {
      const index = JSON.parse(await indexObj.text());
      if (index.assets) {
        for (const asset of index.assets) {
          pathToAssetId.set(asset.original_path, asset.asset_id);
        }
      }
    }
  } catch (err) {
    // Asset Index 不存在时返回空映射
  }

  // 扫描所有图片
  const allImages = await scanAllImages(env);

  // 按上传时间倒序
  allImages.sort((a, b) => {
    if (!a.uploaded) return 1;
    if (!b.uploaded) return -1;
    return new Date(b.uploaded) - new Date(a.uploaded);
  });

  // 简单分页
  const pageLimit = Math.min(limit, 1000);
  const pagedImages = allImages.slice(0, pageLimit);
  const truncated = allImages.length > pageLimit;

  // 扫描两种缩略图索引
  const thumbnailIndex = await buildThumbnailIndex(env);
  const assetThumbnailIndex = await buildAssetThumbnailIndex(env);

  const assets = [];
  for (const obj of pagedImages) {
    const filename = obj.key.split("/").pop();
    const publicUrl = `${env.PUBLIC_BASE_URL}/${obj.key}`;

    // 检查两种缩略图路径：优先新路径 assets/thumbnails/
    let thumbnailUrl = "";
    const assetId = pathToAssetId.get(obj.key);
    
    if (assetId) {
      const expectedNewThumbKey = `assets/thumbnails/${assetId}.webp`;
      if (assetThumbnailIndex.has(expectedNewThumbKey)) {
        thumbnailUrl = `${env.PUBLIC_BASE_URL}/api/thumb/${expectedNewThumbKey}`;
      }
    }
    
    if (!thumbnailUrl) {
      const { key: oldThumbKey } = deriveThumbnailInfo(obj.key, env, thumbnailIndex);
      thumbnailUrl = oldThumbKey ? `${env.PUBLIC_BASE_URL}/api/thumb/${oldThumbKey}` : "";
    }

    const uploadedAt = obj.uploaded ? obj.uploaded.toISOString() : null;

    assets.push({
      id: obj.key,
      filename,
      key: obj.key,
      url: publicUrl,
      thumbnail_url: thumbnailUrl,
      uploaded_at: uploadedAt,
      size: obj.size,
      mime: obj.httpMetadata?.contentType || null,
      type: "image",
      markdown: `![${filename}](${publicUrl})`,
    });
  }

  return jsonResponse({
    assets,
    cursor: truncated ? String(pageLimit) : null,
    truncated,
  });
}

// ------------------------------
// POST /api/generate-index — 生成 library.json 索引到 R2
// v0.3.13: 全量扫描 Bucket，排除系统目录，检查两种缩略图路径
// ------------------------------
async function handleGenerateIndex(request, env) {
  // 口令校验
  const token = request.headers.get("X-Upload-Token") || "";
  if (!env.UPLOAD_TOKEN || token !== env.UPLOAD_TOKEN) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  // 加载 Asset Index 获取 original_path -> asset_id 映射
  const pathToAssetId = new Map();
  try {
    const indexObj = await env.BUCKET.get("assets/metadata/index.json");
    if (indexObj) {
      const index = JSON.parse(await indexObj.text());
      if (index.assets) {
        for (const asset of index.assets) {
          pathToAssetId.set(asset.original_path, asset.asset_id);
        }
      }
    }
  } catch (err) {
    // Asset Index 不存在时返回空映射
  }

  // 建立缩略图索引
  const thumbnailIndex = await buildThumbnailIndex(env);
  const assetThumbnailIndex = await buildAssetThumbnailIndex(env);

  // 扫描所有图片
  const allImages = await scanAllImages(env);

  // 生成资产列表
  const assets = [];
  for (const obj of allImages) {
    const filename = obj.key.split("/").pop();
    const publicUrl = `${env.PUBLIC_BASE_URL}/${obj.key}`;

    // 检查两种缩略图路径：优先新路径
    let thumbnailUrl = "";
    let thumbnailKey = "";
    const assetId = pathToAssetId.get(obj.key);
    
    if (assetId) {
      const expectedNewThumbKey = `assets/thumbnails/${assetId}.webp`;
      if (assetThumbnailIndex.has(expectedNewThumbKey)) {
        thumbnailUrl = `${env.PUBLIC_BASE_URL}/api/thumb/${expectedNewThumbKey}`;
        thumbnailKey = expectedNewThumbKey;
      }
    }
    
    if (!thumbnailUrl) {
      const { key: oldThumbKey } = deriveThumbnailInfo(obj.key, env, thumbnailIndex);
      thumbnailUrl = oldThumbKey ? `${env.PUBLIC_BASE_URL}/api/thumb/${oldThumbKey}` : "";
      thumbnailKey = oldThumbKey;
    }

    const uploadedAt = obj.uploaded ? obj.uploaded.toISOString() : null;
    const batchId = obj.customMetadata?.["batch-id"] || null;

    assets.push({
      id: obj.key,
      filename,
      key: obj.key,
      url: publicUrl,
      thumbnail_url: thumbnailUrl,
      thumbnail_key: thumbnailKey,
      uploaded_at: uploadedAt,
      size: obj.size,
      mime: obj.httpMetadata?.contentType || null,
      type: "image",
      markdown: `![${filename}](${publicUrl})`,
      batch_id: batchId,
      tags: [],
      usage_count: 0,
    });
  }

  // 按上传时间倒序（无时间的排在后面）
  assets.sort((a, b) => {
    if (!a.uploaded_at) return 1;
    if (!b.uploaded_at) return -1;
    return new Date(b.uploaded_at) - new Date(a.uploaded_at);
  });

  // 构建 library.json
  const library = {
    version: "0.3.13",
    generated_at: new Date().toISOString(),
    total: assets.length,
    assets,
  };

  // 写入 R2 根目录
  try {
    await env.BUCKET.put("library.json", JSON.stringify(library, null, 2), {
      httpMetadata: { contentType: "application/json" },
    });
  } catch (err) {
    return jsonResponse({ error: "index-save-failed" }, 500);
  }

  return jsonResponse({
    success: true,
    total: assets.length,
    generated_at: library.generated_at,
  });
}

// ------------------------------
// GET /library.json — 读取索引
// ------------------------------
async function handleGetLibrary(env) {
  try {
    const obj = await env.BUCKET.get("library.json");
    if (!obj) {
      return jsonResponse({ error: "no-index", message: "请先生成索引" }, 404);
    }
    const text = await obj.text();
    return new Response(text, {
      headers: {
        "Content-Type": "application/json",
        ...CORS_HEADERS,
      },
    });
  } catch (err) {
    return jsonResponse({ error: "fetch-index-failed" }, 500);
  }
}

// ------------------------------
// 缩略图辅助函数（性能优化 + 镜像路径）
// ------------------------------

/**
 * 一次性扫描 thumbnails/，建立内存索引（Set），避免 HEAD 风暴
 */
async function buildThumbnailIndex(env) {
  const index = new Set();
  let cursor;

  try {
    do {
      const listed = await env.BUCKET.list({
        prefix: "thumbnails/",
        limit: 1000,
        cursor,
      });

      for (const obj of listed.objects) {
        index.add(obj.key);
      }

      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  } catch (err) {
    // 索引构建失败时返回空集合，不影响主流程
  }

  return index;
}

/**
 * 从 image key 派生可能的 thumbnail key（镜像路径）
 * images/a/b/c.webp -> thumbnails/a/b/c-thumb.webp
 * images/x/test.jpg -> thumbnails/x/test-thumb.webp（优先）或 .jpg
 */
function deriveThumbnailInfo(imageKey, env, thumbnailIndex) {
  // 移除 "images/" 前缀，得到相对路径
  const relativePath = imageKey.startsWith("images/") ? imageKey.slice(7) : imageKey;

  // 提取扩展名和基础名
  const ext = relativePath.includes(".")
    ? relativePath.slice(relativePath.lastIndexOf("."))
    : "";
  const base = ext ? relativePath.slice(0, relativePath.length - ext.length) : relativePath;

  // 优先尝试 .webp 缩略图，再尝试原扩展名
  const candidates = [".webp", ext || ".jpg"];

  for (const thumbExt of candidates) {
    const thumbKey = `thumbnails/${base}-thumb${thumbExt}`;
    if (thumbnailIndex.has(thumbKey)) {
      return {
        key: thumbKey,
        url: `${env.PUBLIC_BASE_URL}/${thumbKey}`,
      };
    }
  }

  // 找不到缩略图，返回空
  return { key: "", url: "" };
}

/**
 * 简化版：只返回 URL
 */
function deriveThumbnailUrl(imageKey, env, thumbnailIndex) {
  const { url } = deriveThumbnailInfo(imageKey, env, thumbnailIndex);
  return url;
}

// ------------------------------
// GET /api/thumb/{key} — 缩略图代理（解决 R2 CORS 问题）
// ------------------------------
async function handleThumbProxy(url, env) {
  // 提取 R2 key: /api/thumb/thumbnails/2026/07/19/xxx-thumb.webp → thumbnails/2026/07/19/xxx-thumb.webp
  const key = url.pathname.replace("/api/thumb/", "");
  if (!key) {
    return jsonResponse({ error: "no-key" }, 400);
  }

  try {
    const obj = await env.BUCKET.get(key);
    if (!obj) {
      return jsonResponse({ error: "not-found" }, 404);
    }

    const contentType = obj.httpMetadata?.contentType || "image/webp";
    return new Response(obj.body, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=31536000",
        ...CORS_HEADERS,
      },
    });
  } catch (err) {
    return jsonResponse({ error: "thumb-fetch-failed" }, 500);
  }
}

/**
 * GET /api/file/* — 文件代理（绕过 R2 CORS 限制）
 * 用于 Canvas 加载图片生成缩略图
 */
async function handleFileProxy(url, env) {
  // 提取 R2 key: /api/file/images/2026/07/19/xxx.jpg → images/2026/07/19/xxx.jpg
  const key = url.pathname.replace("/api/file/", "");
  if (!key) {
    return jsonResponse({ error: "no-key" }, 400);
  }

  // 禁止访问系统文件
  if (isSystemPath(key)) {
    return jsonResponse({ error: "forbidden" }, 403);
  }

  try {
    const obj = await env.BUCKET.get(key);
    if (!obj) {
      return jsonResponse({ error: "not-found" }, 404);
    }

    // 尝试获取 contentType，如果没有则根据扩展名推断
    let contentType = obj.httpMetadata?.contentType;
    if (!contentType) {
      const ext = key.split(".").pop()?.toLowerCase();
      const mimeMap = {
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        png: "image/png",
        gif: "image/gif",
        webp: "image/webp",
        bmp: "image/bmp",
        svg: "image/svg+xml",
        heic: "image/heic",
        heif: "image/heif",
        avif: "image/avif",
      };
      contentType = mimeMap[ext] || "application/octet-stream";
    }

    return new Response(obj.body, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400",
        ...CORS_HEADERS,
      },
    });
  } catch (err) {
    return jsonResponse({ error: "file-fetch-failed" }, 500);
  }
}

// ------------------------------
// 工具函数
// ------------------------------

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}

function extractExtension(name, mimeType) {
  if (name && name.includes(".")) {
    const ext = name.slice(name.lastIndexOf("."));
    if (ext.length <= 6) return ext.toLowerCase();
  }
  const map = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/heic": ".heic",
    "image/heif": ".heif",
  };
  return map[mimeType] || "";
}

function randomString(length) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < length; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

// ------------------------------
// Maintenance API
// ------------------------------

/**
 * POST /api/maintenance/scan — 扫描图片并统计
 * v0.3.13: 全量扫描 Bucket，排除系统目录，检查两种缩略图路径
 */
async function handleMaintenanceScan(request, env) {
  const token = request.headers.get("X-Upload-Token") || "";
  if (!env.UPLOAD_TOKEN || token !== env.UPLOAD_TOKEN) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  // 加载 Asset Index 获取 original_path -> asset_id 映射
  const pathToAssetId = new Map();
  try {
    const indexObj = await env.BUCKET.get("assets/metadata/index.json");
    if (indexObj) {
      const index = JSON.parse(await indexObj.text());
      if (index.assets) {
        for (const asset of index.assets) {
          pathToAssetId.set(asset.original_path, asset.asset_id);
        }
      }
    }
  } catch (err) {
    // Asset Index 不存在时返回空映射
  }

  // 扫描所有图片
  const images = await scanAllImages(env);

  // 扫描两种缩略图
  const thumbnailIndex = await buildThumbnailIndex(env);
  const assetThumbnailIndex = await buildAssetThumbnailIndex(env);

  // 统计有效的缩略图（去重）
  const validThumbnails = new Set();
  for (const key of assetThumbnailIndex) {
    validThumbnails.add(key);
  }
  for (const key of thumbnailIndex) {
    validThumbnails.add(key);
  }

  // 统计缺失缩略图
  let missingThumbnails = 0;
  for (const img of images) {
    const { key: oldThumbKey } = deriveThumbnailInfo(img.key, env, thumbnailIndex);
    const assetId = pathToAssetId.get(img.key);
    const expectedNewThumbKey = assetId ? `assets/thumbnails/${assetId}.webp` : "";
    const hasNewThumbnail = expectedNewThumbKey && assetThumbnailIndex.has(expectedNewThumbKey);

    if (!oldThumbKey && !hasNewThumbnail) {
      missingThumbnails++;
    }
  }

  return jsonResponse({
    success: true,
    images: images.length,
    thumbnails: validThumbnails.size,
    missing_thumbnails: missingThumbnails,
  });
}

/**
 * POST /api/maintenance/scan-missing-thumbnails — 扫描缺失缩略图（不实际生成）
 * v0.3.13: 全量扫描 Bucket，返回 asset_id 用于前端生成缩略图
 */
async function handleScanMissingThumbnails(request, env) {
  const token = request.headers.get("X-Upload-Token") || "";
  if (!env.UPLOAD_TOKEN || token !== env.UPLOAD_TOKEN) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  // 加载 Asset Index 获取 original_path -> asset_id 映射
  const pathToAssetId = new Map();
  try {
    const indexObj = await env.BUCKET.get("assets/metadata/index.json");
    if (indexObj) {
      const index = JSON.parse(await indexObj.text());
      if (index.assets) {
        for (const asset of index.assets) {
          pathToAssetId.set(asset.original_path, asset.asset_id);
        }
      }
    }
  } catch (err) {
    // Asset Index 不存在时返回空映射
  }

  // 扫描所有图片
  const images = await scanAllImages(env);

  // 扫描两种缩略图
  const thumbnailIndex = await buildThumbnailIndex(env);
  const assetThumbnailIndex = await buildAssetThumbnailIndex(env);

  // 收集缺失缩略图的图片
  const missing = [];
  for (const img of images) {
    const { key: oldThumbKey } = deriveThumbnailInfo(img.key, env, thumbnailIndex);
    const assetId = pathToAssetId.get(img.key);
    const expectedNewThumbKey = assetId ? `assets/thumbnails/${assetId}.webp` : "";
    const hasNewThumbnail = expectedNewThumbKey && assetThumbnailIndex.has(expectedNewThumbKey);

    if (!oldThumbKey && !hasNewThumbnail) {
      missing.push({
        key: img.key,
        url: `${env.PUBLIC_BASE_URL}/${img.key}`,
        size: img.size,
        asset_id: assetId || "",
      });
    }
  }

  return jsonResponse({
    success: true,
    total_images: images.length,
    missing_thumbnails: missing.length,
    missing_list: missing.slice(0, 100),
    note: "仅返回缺失缩略图清单。如需自动生成，请在 Maintenance 页面使用 Generate Missing Thumbnails 功能。",
  });
}

/**
 * POST /api/maintenance/clean-orphans — 清理孤儿缩略图
 * v0.3.13: 全量扫描 Bucket，同时清理 thumbnails/ 和 assets/thumbnails/ 下的孤儿缩略图
 */
async function handleCleanOrphans(request, env) {
  const token = request.headers.get("X-Upload-Token") || "";
  if (!env.UPLOAD_TOKEN || token !== env.UPLOAD_TOKEN) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  // 扫描所有图片
  const allImages = await scanAllImages(env);
  const imageKeys = new Set();
  const assetIds = new Set();

  for (const img of allImages) {
    imageKeys.add(img.key);
    // 从文件名提取 asset_id（rz_ 前缀的）
    const filename = img.key.split("/").pop();
    const nameWithoutExt = filename.split(".")[0];
    if (nameWithoutExt.startsWith("rz_")) {
      assetIds.add(nameWithoutExt);
    }
  }

  // 从 Asset Index 获取所有 asset_id（包括 legacy）
  try {
    const indexObj = await env.BUCKET.get("assets/metadata/index.json");
    if (indexObj) {
      const index = JSON.parse(await indexObj.text());
      if (index.assets) {
        for (const asset of index.assets) {
          assetIds.add(asset.asset_id);
        }
      }
    }
  } catch (err) {
    // 索引不存在不影响清理
  }

  // 扫描两种缩略图
  const oldThumbnailIndex = await buildThumbnailIndex(env);
  const newThumbnailIndex = await buildAssetThumbnailIndex(env);

  // 找出旧缩略图中的孤儿
  const orphans = [];
  for (const thumbKey of oldThumbnailIndex) {
    const relativePath = thumbKey.startsWith("thumbnails/") ? thumbKey.slice(11) : thumbKey;

    const ext = relativePath.includes(".") ? relativePath.slice(relativePath.lastIndexOf(".")) : "";
    const base = ext ? relativePath.slice(0, relativePath.length - ext.length) : relativePath;
    const baseWithoutThumb = base.endsWith("-thumb") ? base.slice(0, -6) : base;

    const possibleExts = ext && ext !== ".webp" ? [ext, ".webp", ".jpg", ".png"] : [".webp", ".jpg", ".png", ".gif"];
    let hasOriginal = false;

    for (const imgExt of possibleExts) {
      const imageKey = `images/${baseWithoutThumb}${imgExt}`;
      if (imageKeys.has(imageKey)) {
        hasOriginal = true;
        break;
      }
    }

    if (!hasOriginal) {
      orphans.push(thumbKey);
    }
  }

  // 找出新缩略图中的孤儿
  for (const thumbKey of newThumbnailIndex) {
    const filename = thumbKey.split("/").pop();
    const assetId = filename.split(".")[0];

    if (!assetIds.has(assetId)) {
      orphans.push(thumbKey);
    }
  }

  // 删除孤儿缩略图（限制数量）
  const toDelete = orphans.slice(0, 100);
  let deleted = 0;

  for (const key of toDelete) {
    try {
      await env.BUCKET.delete(key);
      deleted++;
    } catch (err) {
      // 继续删除其他
    }
  }

  return jsonResponse({
    success: true,
    orphan_thumbnails: orphans.length,
    deleted: deleted,
    remaining: orphans.length - deleted,
    note: deleted < orphans.length ? "分批清理中，请再次调用此 API 继续清理" : "清理完成",
  });
}

/**
 * GET /api/maintenance/stats — 统计信息
 * v0.3.13: 全量扫描 Bucket，统计所有图片和两种缩略图
 */
async function handleMaintenanceStats(request, env) {
  const token = request.headers.get("X-Upload-Token") || "";
  if (!env.UPLOAD_TOKEN || token !== env.UPLOAD_TOKEN) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  // 加载 Asset Index 获取 original_path -> asset_id 映射
  const pathToAssetId = new Map();
  try {
    const indexObj = await env.BUCKET.get("assets/metadata/index.json");
    if (indexObj) {
      const index = JSON.parse(await indexObj.text());
      if (index.assets) {
        for (const asset of index.assets) {
          pathToAssetId.set(asset.original_path, asset.asset_id);
        }
      }
    }
  } catch (err) {
    // Asset Index 不存在时返回空映射
  }

  // 扫描所有图片
  const images = await scanAllImages(env);

  // 计算大小和时间
  let totalSize = 0;
  let latestUpload = null;
  let oldestUpload = null;

  for (const img of images) {
    totalSize += img.size || 0;
    if (img.uploaded) {
      const uploadTime = img.uploaded.toISOString();
      if (!latestUpload || uploadTime > latestUpload) latestUpload = uploadTime;
      if (!oldestUpload || uploadTime < oldestUpload) oldestUpload = uploadTime;
    }
  }

  // 扫描两种缩略图
  const thumbnailIndex = await buildThumbnailIndex(env);
  const assetThumbnailIndex = await buildAssetThumbnailIndex(env);

  // 统计有效的缩略图（去重：新路径优先，旧路径作为补充）
  const validThumbnails = new Set();
  for (const key of assetThumbnailIndex) {
    validThumbnails.add(key);
  }
  for (const key of thumbnailIndex) {
    validThumbnails.add(key);
  }

  // 统计缺失缩略图
  let missingThumbnails = 0;
  for (const img of images) {
    const { key: oldThumbKey } = deriveThumbnailInfo(img.key, env, thumbnailIndex);
    const assetId = pathToAssetId.get(img.key);
    const expectedNewThumbKey = assetId ? `assets/thumbnails/${assetId}.webp` : "";
    const hasNewThumbnail = expectedNewThumbKey && assetThumbnailIndex.has(expectedNewThumbKey);

    if (!oldThumbKey && !hasNewThumbnail) {
      missingThumbnails++;
    }
  }

  return jsonResponse({
    images: images.length,
    thumbnails: validThumbnails.size,
    missing_thumbnails: missingThumbnails,
    storage_bytes: totalSize,
    storage_mb: Math.round(totalSize / 1024 / 1024 * 100) / 100,
    latest_upload: latestUpload,
    oldest_upload: oldestUpload,
  });
}

// ------------------------------
// Import Existing Assets API（已移除）
// ------------------------------
// 原 /api/import/preview 和 /api/import/confirm 已删除。
// 导入逻辑复用 /api/maintenance/scan 和 /api/generate-index：
//   1. POST /api/maintenance/scan  获取统计预览
//   2. POST /api/generate-index   建立 library.json 索引

// ------------------------------
// Asset Index Layer (v0.3.13)
// ------------------------------

/**
 * 生成 Asset ID
 * 格式：rz_YYYYMMDD_HHMMSSmmm_random6
 * 包含毫秒级时间戳，避免并发冲突
 */
function generateAssetId(uploadTime = new Date()) {
  const yyyy = uploadTime.getUTCFullYear();
  const mm = String(uploadTime.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(uploadTime.getUTCDate()).padStart(2, '0');
  const HH = String(uploadTime.getUTCHours()).padStart(2, '0');
  const MM = String(uploadTime.getUTCMinutes()).padStart(2, '0');
  const SS = String(uploadTime.getUTCSeconds()).padStart(2, '0');
  const mmm = String(uploadTime.getUTCMilliseconds()).padStart(3, '0');
  const random = randomString(6);

  return `rz_${yyyy}${mm}${dd}_${HH}${MM}${SS}${mmm}_${random}`;
}

/**
 * POST /api/asset-index/build — 扫描 R2 构建 Asset Index
 * v0.3.13: 全量扫描 Bucket 所有图片（排除系统目录），统一使用 assets/thumbnails/{asset_id}.webp
 * Legacy 缩略图迁移：基于 original_path 映射
 */
async function handleBuildAssetIndex(request, env) {
  const token = request.headers.get("X-Upload-Token") || "";
  if (!env.UPLOAD_TOKEN || token !== env.UPLOAD_TOKEN) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  const now = new Date().toISOString();

  // 加载已有 metadata 索引
  const existingMetadata = new Map();
  try {
    const metadataIndexObj = await env.BUCKET.get("assets/metadata/index.json");
    if (metadataIndexObj) {
      const metadataIndex = JSON.parse(await metadataIndexObj.text());
      if (metadataIndex.assets) {
        for (const asset of metadataIndex.assets) {
          existingMetadata.set(asset.original_path, asset.asset_id);
        }
      }
    }
  } catch (err) {
    // 首次构建
  }

  // 全量扫描所有图片
  const allImages = await scanAllImages(env);
  const assets = [];

  for (const obj of allImages) {
    // 判断来源：文件名含 rz_ 前缀的视为 upload，否则 legacy
    const filename = obj.key.split("/").pop();
    const nameWithoutExt = filename.split(".")[0];
    const source = nameWithoutExt.startsWith("rz_") ? "upload" : "legacy";

    // 提取或生成 Asset ID
    let assetId = existingMetadata.get(obj.key);
    if (!assetId) {
      if (source === "upload" && nameWithoutExt.startsWith("rz_")) {
        assetId = nameWithoutExt;
      } else {
        assetId = generateAssetId(obj.uploaded || new Date());
      }
    }

    // 构建 metadata（保留已有字段）
    let metadata = {
      asset_id: assetId,
      source: source,
      original_path: obj.key,
      original_name: filename,
      type: "image",
      mime: obj.httpMetadata?.contentType || null,
      size: obj.size,
      width: null,
      height: null,
      uploaded_at: obj.uploaded ? obj.uploaded.toISOString() : null,
      thumbnail_status: "pending",
      thumbnail_path: "",
      title: "",
      description: "",
      used_in: [],
      tags: [],
      article_ref: null,
      created_at: now,
      updated_at: now,
    };

    // 保留人工修改的字段
    if (existingMetadata.has(obj.key)) {
      try {
        const existingMetaObj = await env.BUCKET.get(`assets/metadata/${assetId}.json`);
        if (existingMetaObj) {
          const existingMeta = JSON.parse(await existingMetaObj.text());
          if (existingMeta.title) metadata.title = existingMeta.title;
          if (existingMeta.description) metadata.description = existingMeta.description;
          if (existingMeta.used_in && Array.isArray(existingMeta.used_in)) {
            metadata.used_in = existingMeta.used_in;
          }
          if (existingMeta.tags && Array.isArray(existingMeta.tags)) {
            metadata.tags = existingMeta.tags;
          }
          if (existingMeta.created_at) metadata.created_at = existingMeta.created_at;
        }
      } catch (err) {
        // 读取失败使用默认值
      }
    }

    assets.push(metadata);

    await env.BUCKET.put(
      `assets/metadata/${assetId}.json`,
      JSON.stringify(metadata, null, 2),
      { httpMetadata: { contentType: "application/json" } }
    );
  }

  // 构建缩略图索引
  const oldThumbnailIndex = await buildThumbnailIndex(env);
  const newThumbnailIndex = await buildAssetThumbnailIndex(env);

  // 更新缩略图状态 + 迁移旧缩略图
  for (const asset of assets) {
    const expectedNewThumbKey = `assets/thumbnails/${asset.asset_id}.webp`;

    // 检查新路径是否已有缩略图
    if (newThumbnailIndex.has(expectedNewThumbKey)) {
      asset.thumbnail_status = "generated";
      asset.thumbnail_path = expectedNewThumbKey;
      continue;
    }

    // Legacy 缩略图迁移
    if (asset.source === "legacy") {
      const { key: oldThumbKey } = deriveThumbnailInfo(asset.original_path, env, oldThumbnailIndex);
      if (oldThumbKey) {
        try {
          const oldThumbObj = await env.BUCKET.get(oldThumbKey);
          if (oldThumbObj) {
            await env.BUCKET.put(
              expectedNewThumbKey,
              oldThumbObj.body,
              { httpMetadata: { contentType: "image/webp" } }
            );
            newThumbnailIndex.add(expectedNewThumbKey);
            asset.thumbnail_status = "generated";
            asset.thumbnail_path = expectedNewThumbKey;
            continue;
          }
        } catch (err) {
          // 迁移失败不中断
        }
      }
    }

    asset.thumbnail_status = "pending";
    asset.thumbnail_path = "";
  }

  // 写入 metadata 索引
  const metadataIndex = {
    version: "0.3.13",
    generated_at: now,
    total: assets.length,
    assets: assets.map(a => ({
      asset_id: a.asset_id,
      original_path: a.original_path,
      source: a.source,
      thumbnail_status: a.thumbnail_status,
    })),
  };

  await env.BUCKET.put(
    "assets/metadata/index.json",
    JSON.stringify(metadataIndex, null, 2),
    { httpMetadata: { contentType: "application/json" } }
  );

  // 写入总索引
  const assetIndex = {
    version: "0.3.13",
    generated_at: now,
    total: assets.length,
    legacy_assets: assets.filter(a => a.source === "legacy").length,
    uploaded_assets: assets.filter(a => a.source === "upload").length,
    missing_thumbnails: assets.filter(a => a.thumbnail_status === "pending").length,
  };

  await env.BUCKET.put(
    "assets/index.json",
    JSON.stringify(assetIndex, null, 2),
    { httpMetadata: { contentType: "application/json" } }
  );

  return jsonResponse({
    success: true,
    total: assets.length,
    legacy: assetIndex.legacy_assets,
    uploaded: assetIndex.uploaded_assets,
    missing_thumbnails: assetIndex.missing_thumbnails,
    generated_at: now,
  });
}

/**
 * 扫描指定目录
 */
async function scanDirectory(env, prefix, existingMetadata, assets, now, source) {
  let cursor;

  try {
    do {
      const listed = await env.BUCKET.list({
        prefix,
        limit: 1000,
        cursor,
      });

      for (const obj of listed.objects) {
        if (obj.customMetadata && obj.customMetadata["deleted"] === "true") continue;

        // 跳过缩略图（缩略图归 assets/thumbnails/ 管理）
        if (obj.key.includes("/thumbnails/") || obj.key.startsWith("thumbnails/")) continue;
        if (obj.key.includes("/thumbs/") || obj.key.startsWith("thumbs/")) continue;

        // 只处理图片
        if (!isImage(obj.httpMetadata?.contentType)) continue;

        // 提取或生成 Asset ID
        let assetId = existingMetadata.get(obj.key);
        if (!assetId) {
          if (source === "upload" && obj.key.includes("rz_")) {
            // 新上传：从文件名提取
            const filename = obj.key.split("/").pop();
            assetId = filename.split(".")[0];
          } else {
            // Legacy：生成新 ID
            assetId = generateAssetId(obj.uploaded || new Date());
          }
        }

        // 写入 metadata（保留已有字段）
        let metadata = {
          asset_id: assetId,
          source: source,
          original_path: obj.key,
          original_name: obj.key.split("/").pop(),
          type: "image",
          mime: obj.httpMetadata?.contentType || null,
          size: obj.size,
          width: null,
          height: null,
          uploaded_at: obj.uploaded ? obj.uploaded.toISOString() : null,
          thumbnail_status: "pending",
          thumbnail_path: "",
          title: "",
          description: "",
          used_in: [],
          tags: [],
          article_ref: null,
          created_at: now,
          updated_at: now,
        };

        // 如果已有 metadata，保留人工修改的字段
        if (existingMetadata.has(obj.key)) {
          try {
            const existingMetaObj = await env.BUCKET.get(`assets/metadata/${assetId}.json`);
            if (existingMetaObj) {
              const existingMeta = JSON.parse(await existingMetaObj.text());
              if (existingMeta.title) metadata.title = existingMeta.title;
              if (existingMeta.description) metadata.description = existingMeta.description;
              if (existingMeta.used_in && Array.isArray(existingMeta.used_in)) {
                metadata.used_in = existingMeta.used_in;
              }
              if (existingMeta.tags && Array.isArray(existingMeta.tags)) {
                metadata.tags = existingMeta.tags;
              }
              if (existingMeta.created_at) metadata.created_at = existingMeta.created_at;
            }
          } catch (err) {
            // 读取失败使用默认值
          }
        }

        assets.push(metadata);

        await env.BUCKET.put(
          `assets/metadata/${assetId}.json`,
          JSON.stringify(metadata, null, 2),
          { httpMetadata: { contentType: "application/json" } }
        );
      }

      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  } catch (err) {
    // 目录不存在则跳过
  }
}

/**
 * 扫描 assets/thumbnails/ 索引
 */
async function buildAssetThumbnailIndex(env) {
  const index = new Set();
  let cursor;

  try {
    do {
      const listed = await env.BUCKET.list({
        prefix: "assets/thumbnails/",
        limit: 1000,
        cursor,
      });

      for (const obj of listed.objects) {
        index.add(obj.key);
      }

      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  } catch (err) {}

  return index;
}

/**
 * 判断是否为图片
 */
function isImage(contentType) {
  if (!contentType) return false;
  return contentType.startsWith("image/");
}

/**
 * 扫描 Bucket 中所有图片（排除系统目录）
 * 同时支持 contentType 和文件扩展名判断，兼容 R2 直传文件
 */
async function scanAllImages(env) {
  const images = [];
  let cursor;

  try {
    do {
      const listed = await env.BUCKET.list({
        limit: 1000,
        cursor,
      });

      for (const obj of listed.objects) {
        if (obj.customMetadata && obj.customMetadata["deleted"] === "true") continue;
        if (isSystemPath(obj.key)) continue;
        if (!isImage(obj.httpMetadata?.contentType) && !isImageFile(obj.key)) continue;
        images.push(obj);
      }

      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  } catch (err) {
    // 扫描失败返回空数组
  }

  return images;
}

/**
 * 根据扩展名判断是否为图片文件（兼容无 contentType 的 R2 直传文件）
 */
function isImageFile(key) {
  const ext = key.split(".").pop()?.toLowerCase();
  return ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "heic", "heif", "avif"].includes(ext);
}

/**
 * 判断是否为系统文件/目录（排除扫描）
 */
function isSystemPath(key) {
  for (const prefix of SYSTEM_PREFIXES) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * GET /api/asset-index — 获取 Asset Index 列表（包含完整 metadata）
 */
async function handleGetAssetIndex(request, env) {
  const token = request.headers.get("X-Upload-Token") || "";
  if (!env.UPLOAD_TOKEN || token !== env.UPLOAD_TOKEN) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  try {
    const obj = await env.BUCKET.get("assets/metadata/index.json");
    if (!obj) {
      return jsonResponse({ error: "no-index", message: "请先构建 Asset Index" }, 404);
    }

    const index = JSON.parse(await obj.text());
    const detailedAssets = [];

    // 加载每个 asset 的完整 metadata
    for (const summary of index.assets || []) {
      try {
        const metaObj = await env.BUCKET.get(`assets/metadata/${summary.asset_id}.json`);
        if (metaObj) {
          const metadata = JSON.parse(await metaObj.text());
          detailedAssets.push(metadata);
        } else {
          // 单个 metadata 文件不存在时返回 summary
          detailedAssets.push({
            asset_id: summary.asset_id,
            original_path: summary.original_path,
            source: summary.source,
            thumbnail_status: summary.thumbnail_status,
            thumbnail_path: "",
          });
        }
      } catch (err) {
        detailedAssets.push({
          asset_id: summary.asset_id,
          original_path: summary.original_path,
          source: summary.source,
          thumbnail_status: summary.thumbnail_status,
          thumbnail_path: "",
        });
      }
    }

    return jsonResponse({
      version: index.version,
      generated_at: index.generated_at,
      total: detailedAssets.length,
      assets: detailedAssets,
    });
  } catch (err) {
    return jsonResponse({ error: "fetch-index-failed" }, 500);
  }
}

/**
 * GET /api/asset-index/:id — 获取单个 metadata
 */
async function handleGetAssetMetadata(request, env) {
  const token = request.headers.get("X-Upload-Token") || "";
  if (!env.UPLOAD_TOKEN || token !== env.UPLOAD_TOKEN) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  const url = new URL(request.url);
  const assetId = url.pathname.split("/").pop();

  try {
    const obj = await env.BUCKET.get(`assets/metadata/${assetId}.json`);
    if (!obj) {
      return jsonResponse({ error: "not-found" }, 404);
    }

    const metadata = JSON.parse(await obj.text());
    return jsonResponse(metadata);
  } catch (err) {
    return jsonResponse({ error: "fetch-metadata-failed" }, 500);
  }
}

/**
 * GET /api/asset-index/thumbnail-queue — 获取待生成缩略图队列
 */
async function handleGetThumbnailQueue(request, env) {
  const token = request.headers.get("X-Upload-Token") || "";
  if (!env.UPLOAD_TOKEN || token !== env.UPLOAD_TOKEN) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  try {
    const indexObj = await env.BUCKET.get("assets/metadata/index.json");
    if (!indexObj) {
      return jsonResponse({ error: "no-index" }, 404);
    }

    const index = JSON.parse(await indexObj.text());
    const pendingAssets = index.assets.filter(a => a.thumbnail_status === "missing");

    // 获取每个资产的详细信息
    const queue = [];
    for (const asset of pendingAssets.slice(0, 100)) { // 限制数量
      const metadataObj = await env.BUCKET.get(`assets/metadata/${asset.asset_id}.json`);
      if (metadataObj) {
        const metadata = JSON.parse(await metadataObj.text());
        queue.push({
          asset_id: metadata.asset_id,
          original_path: metadata.original_path,
          original_url: `${env.PUBLIC_BASE_URL}/${metadata.original_path}`,
          size: metadata.size,
        });
      }
    }

    return jsonResponse({
      total_pending: pendingAssets.length,
      queue: queue,
    });
  } catch (err) {
    return jsonResponse({ error: "fetch-queue-failed" }, 500);
  }
}

/**
 * PUT /api/asset-index/:id/thumbnail — 更新缩略图状态
 */
async function handleUpdateThumbnailStatus(request, env) {
  const token = request.headers.get("X-Upload-Token") || "";
  if (!env.UPLOAD_TOKEN || token !== env.UPLOAD_TOKEN) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  const url = new URL(request.url);
  const assetId = url.pathname.split("/")[2]; // /api/asset-index/{id}/thumbnail

  try {
    const body = await request.json();
    const { thumbnail_path, status } = body;

    if (!thumbnail_path || !status) {
      return jsonResponse({ error: "missing-params" }, 400);
    }

    // 获取 metadata
    const metadataObj = await env.BUCKET.get(`assets/metadata/${assetId}.json`);
    if (!metadataObj) {
      return jsonResponse({ error: "not-found" }, 404);
    }

    const metadata = JSON.parse(await metadataObj.text());

    // 更新
    metadata.thumbnail_status = status;
    metadata.thumbnail_path = thumbnail_path;
    metadata.updated_at = new Date().toISOString();

    // 写回
    await env.BUCKET.put(
      `assets/metadata/${assetId}.json`,
      JSON.stringify(metadata, null, 2),
      { httpMetadata: { contentType: "application/json" } }
    );

    // 更新索引
    const indexObj = await env.BUCKET.get("assets/metadata/index.json");
    if (indexObj) {
      const index = JSON.parse(await indexObj.text());
      const assetIndex = index.assets.findIndex(a => a.asset_id === assetId);
      if (assetIndex !== -1) {
        index.assets[assetIndex].thumbnail_status = status;
        await env.BUCKET.put(
          "assets/metadata/index.json",
          JSON.stringify(index, null, 2),
          { httpMetadata: { contentType: "application/json" } }
        );
      }
    }

    return jsonResponse({ success: true, asset_id: assetId });
  } catch (err) {
    return jsonResponse({ error: "update-failed" }, 500);
  }
}
