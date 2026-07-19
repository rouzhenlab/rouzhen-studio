// ROUZHEN Studio — Pages Functions (_worker.js)
// v0.2：上传（原图 + 缩略图）/ 素材列表 API / 口令保护

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
    // 根据实际 MIME 类型确定扩展名
    const thumbExt = thumbnail.type === "image/webp" ? ".webp" : ".jpg";
    const thumbFilename = filename.replace(ext, "") + "-thumb" + thumbExt;
    const thumbKey = `thumbnails/${datePath}/${thumbFilename}`;

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

  for (const obj of listed.objects) {
    // 跳过已 soft-delete 的对象
    if (obj.customMetadata && obj.customMetadata["deleted"] === "true") {
      continue;
    }

    // 从 key 解析路径信息
    // key 格式: images/YYYY/MM/DD/filename
    const parts = obj.key.split("/");
    if (parts.length < 5) continue;

    const year = parts[1];
    const month = parts[2];
    const day = parts[3];
    const filename = parts.slice(4).join("/");
    const datePath = `${year}/${month}/${day}`;

    const publicUrl = `${env.PUBLIC_BASE_URL}/${obj.key}`;

    // 推导缩略图 URL（检查 R2 中实际存在哪个格式）
    const ext = filename.includes(".") ? filename.slice(filename.lastIndexOf(".")) : "";
    const baseName = filename.replace(ext, "");
    let thumbnailUrl = "";
    for (const thumbExt of [".webp", ".jpg"]) {
      const candidateKey = `thumbnails/${datePath}/${baseName}-thumb${thumbExt}`;
      try {
        const head = await env.BUCKET.head(candidateKey);
        if (head) {
          thumbnailUrl = `${env.PUBLIC_BASE_URL}/${candidateKey}`;
          break;
        }
      } catch (e) {
        // 继续尝试下一个扩展名
      }
    }

    const uploadTime = obj.uploaded
      ? obj.uploaded.toISOString()
      : `${year}-${month}-${day}T00:00:00Z`;

    assets.push({
      filename,
      key: obj.key,
      url: publicUrl,
      thumbnail_url: thumbnailUrl,
      upload_time: uploadTime,
      type: "image",
      markdown: `![${filename}](${publicUrl})`,
      size: obj.size,
    });
  }

  // 按上传时间倒序
  assets.sort((a, b) => new Date(b.upload_time) - new Date(a.upload_time));

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
        if (obj.customMetadata && obj.customMetadata["deleted"] === "true") continue;

        const parts = obj.key.split("/");
        if (parts.length < 5) continue;

        const year = parts[1];
        const month = parts[2];
        const day = parts[3];
        const filename = parts.slice(4).join("/");
        const datePath = `${year}/${month}/${day}`;
        const ext = filename.includes(".") ? filename.slice(filename.lastIndexOf(".")) : "";
        const baseName = filename.replace(ext, "");

        const publicUrl = `${env.PUBLIC_BASE_URL}/${obj.key}`;

        // 查找缩略图
        let thumbnailUrl = "";
        let thumbKey = "";
        for (const thumbExt of [".webp", ".jpg"]) {
          const candidateKey = `thumbnails/${datePath}/${baseName}-thumb${thumbExt}`;
          try {
            const head = await env.BUCKET.head(candidateKey);
            if (head) {
              thumbnailUrl = `${env.PUBLIC_BASE_URL}/${candidateKey}`;
              thumbKey = candidateKey;
              break;
            }
          } catch (e) {}
        }

        const uploadTime = obj.uploaded
          ? obj.uploaded.toISOString()
          : `${year}-${month}-${day}T00:00:00Z`;

        assets.push({
          filename,
          key: obj.key,
          url: publicUrl,
          thumbnail_url: thumbnailUrl,
          thumbnail_key: thumbKey,
          upload_time: uploadTime,
          date: `${year}-${month}-${day}`,
          type: "image",
          markdown: `![${filename}](${publicUrl})`,
          size: obj.size,
          tags: [],
          usage_count: 0,
        });
      }

      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  } catch (err) {
    return jsonResponse({ error: "index-generation-failed" }, 500);
  }

  // 按上传时间倒序
  assets.sort((a, b) => new Date(b.upload_time) - new Date(a.upload_time));

  // 构建 library.json
  const library = {
    version: "0.2",
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
