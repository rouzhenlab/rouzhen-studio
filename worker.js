// ROUZHEN Studio — worker.js
// Cloudflare Worker：接收图片上传，写入 R2（Binding 方式，无需 Access Key）
//
// 需要在 Worker 环境变量 / Bucket 绑定中配置：
// - UPLOAD_TOKEN     环境变量，上传口令，与前端 X-Upload-Token 比对
// - BUCKET           R2 Bucket 绑定
// - PUBLIC_BASE_URL  环境变量，R2 公开访问域名，例如 https://images.example.com
//                     （不要带结尾斜杠）

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
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Upload-Token",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (request.method !== "POST" || url.pathname !== "/upload") {
      return jsonResponse({ error: "not-found" }, 404);
    }

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

    const ext = extractExtension(file.name, file.type);
    const filename = `${now.getTime()}-${randomString(6)}${ext}`;
    const key = `images/${yyyy}/${mm}/${dd}/${filename}`;

    // 写入 R2
    try {
      await env.BUCKET.put(key, file.stream(), {
        httpMetadata: { contentType: file.type },
      });
    } catch (err) {
      return jsonResponse({ error: "upload-failed" }, 500);
    }

    const publicUrl = `${env.PUBLIC_BASE_URL}/${key}`;

    return jsonResponse({
      url: publicUrl,
      markdown: `![image](${publicUrl})`,
      filename,
    });
  },
};

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
