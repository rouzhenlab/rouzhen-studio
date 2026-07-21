// ROUZHEN Studio — Pages Functions (_worker.js)
// v0.3：Asset Library 架构升级
// - R2 是唯一数据源（Single Source of Truth）
// - 不依赖目录结构（递归识别 images/）
// - Thumbnail 路径镜像（从 image key 派生）
// - 消除 HEAD 风暴（一次性建立 thumbnails 索引）
// - 新增 Maintenance API 和 Import Existing Assets

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

    // 其他请求交给 Pages 静态资源
    return env.ASSETS.fetch(request);
  },
};

// ------------------------------
// POST /upload — 上传原图 + 缩略图
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

  // 生成文件名与日期路径
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const datePath = `${yyyy}/${mm}/${dd}`;

  const ext = extractExtension(file.name, file.type);
  const filename = `${now.getTime()}-${randomString(6)}${ext}`;
  const imageKey = `images/${datePath}/${filename}`;

  // 自定义 metadata
  const customMetadata = {};
  if (batchId) {
    customMetadata["batch-id"] = batchId;
  }
  // 预留 soft delete 字段
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

  if (thumbnail && typeof thumbnail !== "string" && thumbnail.size > 0) {
    // 缩略图路径：镜像 images/ 的相对路径（不再依赖 datePath）
    // images/YYYY/MM/DD/filename.webp -> thumbnails/YYYY/MM/DD/filename-thumb.webp
    const thumbExt = thumbnail.type === "image/webp" ? ".webp" : ".jpg";
    const baseFilename = filename.replace(ext, "");
    const thumbKey = `thumbnails/${datePath}/${baseFilename}-thumb${thumbExt}`;

    try {
      const thumbBuffer = await thumbnail.arrayBuffer();
      await env.BUCKET.put(thumbKey, thumbBuffer, {
        httpMetadata: { contentType: thumbnail.type || "image/jpeg" },
        customMetadata: { "original-key": imageKey },
      });
      thumbnailUrl = `${env.PUBLIC_BASE_URL}/${thumbKey}`;
    } catch (err) {
      // 缩略图写入失败不影响原图上传
    }
  }

  const publicUrl = `${env.PUBLIC_BASE_URL}/${imageKey}`;

  return jsonResponse({
    url: publicUrl,
    thumbnail_url: thumbnailUrl,
    markdown: `![${filename}](${publicUrl})`,
    filename,
    key: imageKey,
  });
}

// ------------------------------
// GET /api/assets — 素材列表（分页）
// ------------------------------
async function handleListAssets(request, env) {
  // 口令校验（gallery 也受 Token 保护）
  const token = request.headers.get("X-Upload-Token") || "";
  if (!env.UPLOAD_TOKEN || token !== env.UPLOAD_TOKEN) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor") || undefined;
  const limit = parseInt(url.searchParams.get("limit") || String(ASSETS_API_LIMIT), 10);

  let listed;
  try {
    listed = await env.BUCKET.list({
      prefix: "images/",
      limit: Math.min(limit, 1000),
      cursor,
    });
  } catch (err) {
    return jsonResponse({ error: "list-failed" }, 500);
  }

  const assets = [];

  // 先一次性获取所有缩略图 key（避免 HEAD 风暴）
  const thumbnailIndex = await buildThumbnailIndex(env);

  for (const obj of listed.objects) {
    // 跳过已 soft-delete 的对象
    if (obj.customMetadata && obj.customMetadata["deleted"] === "true") {
      continue;
    }

    // 递归识别 images/ 下所有图片，不依赖目录结构
    // filename 取 key 的最后一段
    const filename = obj.key.split("/").pop();
    const publicUrl = `${env.PUBLIC_BASE_URL}/${obj.key}`;

    // 从 image key 派生 thumbnail key（镜像路径）
    const thumbnailUrl = deriveThumbnailUrl(obj.key, env, thumbnailIndex);

    // 时间来源：R2 uploaded，不用路径解析
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

  // 按上传时间倒序（无时间的排在后面）
  assets.sort((a, b) => {
    if (!a.uploaded_at) return 1;
    if (!b.uploaded_at) return -1;
    return new Date(b.uploaded_at) - new Date(a.uploaded_at);
  });

  return jsonResponse({
    assets,
    cursor: listed.truncated ? listed.cursor : null,
    truncated: listed.truncated,
  });
}

// ------------------------------
// POST /api/generate-index — 生成 library.json 索引到 R2
// ------------------------------
async function handleGenerateIndex(request, env) {
  // 口令校验
  const token = request.headers.get("X-Upload-Token") || "";
  if (!env.UPLOAD_TOKEN || token !== env.UPLOAD_TOKEN) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  // 先一次性建立缩略图索引（避免 HEAD 风暴）
  const thumbnailIndex = await buildThumbnailIndex(env);

  // 遍历所有图片，收集完整信息
  const assets = [];
  let cursor;

  try {
    do {
      const listed = await env.BUCKET.list({
        prefix: "images/",
        limit: 1000,
        cursor,
      });

      for (const obj of listed.objects) {
        // 跳过已 soft-delete 的对象
        if (obj.customMetadata && obj.customMetadata["deleted"] === "true") continue;

        // 递归识别 images/ 下所有图片，不依赖目录结构
        const filename = obj.key.split("/").pop();
        const publicUrl = `${env.PUBLIC_BASE_URL}/${obj.key}`;

        // 从 image key 派生 thumbnail key（镜像路径）
        const { url: thumbnailUrl, key: thumbnailKey } = deriveThumbnailInfo(obj.key, env, thumbnailIndex);

        // 时间来源：R2 uploaded，不用路径解析
        const uploadedAt = obj.uploaded ? obj.uploaded.toISOString() : null;

        // 提取 batch_id（预留）
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

      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  } catch (err) {
    return jsonResponse({ error: "index-generation-failed" }, 500);
  }

  // 按上传时间倒序（无时间的排在后面）
  assets.sort((a, b) => {
    if (!a.uploaded_at) return 1;
    if (!b.uploaded_at) return -1;
    return new Date(b.uploaded_at) - new Date(a.uploaded_at);
  });

  // 构建 library.json（v0.3 架构升级）
  const library = {
    version: "0.3",
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
 * POST /api/maintenance/scan — 扫描 images/ 并统计
 */
async function handleMaintenanceScan(request, env) {
  const token = request.headers.get("X-Upload-Token") || "";
  if (!env.UPLOAD_TOKEN || token !== env.UPLOAD_TOKEN) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  // 扫描 images/
  const images = [];
  let cursor;

  try {
    do {
      const listed = await env.BUCKET.list({
        prefix: "images/",
        limit: 1000,
        cursor,
      });

      for (const obj of listed.objects) {
        if (obj.customMetadata && obj.customMetadata["deleted"] === "true") continue;
        images.push(obj);
      }

      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  } catch (err) {
    return jsonResponse({ error: "scan-failed" }, 500);
  }

  // 扫描 thumbnails/
  const thumbnailIndex = await buildThumbnailIndex(env);

  // 统计缺失缩略图
  let missingThumbnails = 0;
  for (const img of images) {
    const { key: thumbKey } = deriveThumbnailInfo(img.key, env, thumbnailIndex);
    if (!thumbKey) missingThumbnails++;
  }

  return jsonResponse({
    success: true,
    images: images.length,
    thumbnails: thumbnailIndex.size,
    missing_thumbnails: missingThumbnails,
  });
}

/**
 * POST /api/maintenance/scan-missing-thumbnails — 扫描缺失缩略图（不实际生成）
 * Worker 环境无法直接处理图片，此 API 仅返回缺失缩略图清单
 */
async function handleScanMissingThumbnails(request, env) {
  const token = request.headers.get("X-Upload-Token") || "";
  if (!env.UPLOAD_TOKEN || token !== env.UPLOAD_TOKEN) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  // 扫描 images/
  const images = [];
  let cursor;

  try {
    do {
      const listed = await env.BUCKET.list({
        prefix: "images/",
        limit: 1000,
        cursor,
      });

      for (const obj of listed.objects) {
        if (obj.customMetadata && obj.customMetadata["deleted"] === "true") continue;
        images.push(obj);
      }

      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  } catch (err) {
    return jsonResponse({ error: "scan-failed" }, 500);
  }

  // 扫描 thumbnails/
  const thumbnailIndex = await buildThumbnailIndex(env);

  // 收集缺失缩略图的图片
  const missing = [];
  for (const img of images) {
    const { key: thumbKey } = deriveThumbnailInfo(img.key, env, thumbnailIndex);
    if (!thumbKey) {
      missing.push({
        key: img.key,
        url: `${env.PUBLIC_BASE_URL}/${img.key}`,
        size: img.size,
      });
    }
  }

  return jsonResponse({
    success: true,
    total_images: images.length,
    missing_thumbnails: missing.length,
    missing_list: missing.slice(0, 100), // 限制返回数量，避免响应过大
    note: "Worker 无法生成缩略图，请使用外部工具或客户端生成后上传到 R2",
  });
}

/**
 * POST /api/maintenance/clean-orphans — 清理孤儿缩略图
 */
async function handleCleanOrphans(request, env) {
  const token = request.headers.get("X-Upload-Token") || "";
  if (!env.UPLOAD_TOKEN || token !== env.UPLOAD_TOKEN) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  // 扫描 images/
  const imageKeys = new Set();
  let cursor;

  try {
    do {
      const listed = await env.BUCKET.list({
        prefix: "images/",
        limit: 1000,
        cursor,
      });

      for (const obj of listed.objects) {
        if (obj.customMetadata && obj.customMetadata["deleted"] === "true") continue;
        imageKeys.add(obj.key);
      }

      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  } catch (err) {
    return jsonResponse({ error: "scan-failed" }, 500);
  }

  // 扫描 thumbnails/
  const thumbnailIndex = await buildThumbnailIndex(env);

  // 找出孤儿缩略图
  const orphans = [];
  for (const thumbKey of thumbnailIndex) {
    // 从 thumbnail key 反推 image key
    // thumbnails/a/b/c-thumb.webp -> images/a/b/c.webp
    const relativePath = thumbKey.startsWith("thumbnails/") ? thumbKey.slice(11) : thumbKey;

    // 移除 -thumb 后缀
    const ext = relativePath.includes(".") ? relativePath.slice(relativePath.lastIndexOf(".")) : "";
    const base = ext ? relativePath.slice(0, relativePath.length - ext.length) : relativePath;
    const baseWithoutThumb = base.endsWith("-thumb") ? base.slice(0, -6) : base;

    // 尝试可能的原图扩展名
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

  // 删除孤儿缩略图（限制数量，避免 Worker 执行时间过长）
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
 */
async function handleMaintenanceStats(request, env) {
  const token = request.headers.get("X-Upload-Token") || "";
  if (!env.UPLOAD_TOKEN || token !== env.UPLOAD_TOKEN) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  // 扫描 images/
  const images = [];
  let cursor;
  let totalSize = 0;
  let latestUpload = null;
  let oldestUpload = null;

  try {
    do {
      const listed = await env.BUCKET.list({
        prefix: "images/",
        limit: 1000,
        cursor,
      });

      for (const obj of listed.objects) {
        if (obj.customMetadata && obj.customMetadata["deleted"] === "true") continue;

        images.push(obj);
        totalSize += obj.size || 0;

        if (obj.uploaded) {
          const uploadTime = obj.uploaded.toISOString();
          if (!latestUpload || uploadTime > latestUpload) latestUpload = uploadTime;
          if (!oldestUpload || uploadTime < oldestUpload) oldestUpload = uploadTime;
        }
      }

      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  } catch (err) {
    return jsonResponse({ error: "scan-failed" }, 500);
  }

  // 扫描 thumbnails/
  const thumbnailIndex = await buildThumbnailIndex(env);

  // 统计缺失缩略图
  let missingThumbnails = 0;
  for (const img of images) {
    const { key: thumbKey } = deriveThumbnailInfo(img.key, env, thumbnailIndex);
    if (!thumbKey) missingThumbnails++;
  }

  return jsonResponse({
    images: images.length,
    thumbnails: thumbnailIndex.size,
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
