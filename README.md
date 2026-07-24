# ROUZHEN Studio

ROUZHEN 的私人创作工作空间。当前版本：v0.5.0。

以 Dashboard 为唯一入口的个人内容操作系统：素材进入 → 文章创作 → 插入素材 → 生成发布内容 → Website 展示。

当前为单人使用的私人工具，不是面向多用户的产品。

---

## 文件结构

```
/
├── index.html              ← Dashboard，唯一入口
├── article/
│   └── editor.html         ← Article Editor
├── assets/
│   ├── upload.html         ← 上传图片
│   ├── index.html          ← 素材库浏览
│   └── maintenance.html    ← 维护工具
├── css/
│   ├── style.css
│   └── gallery.css
├── js/
│   ├── app.js               （upload.html 用）
│   ├── gallery.js           （assets/index.html 用）
│   ├── maintenance.js       （assets/maintenance.html 用）
│   └── editor.js            （article/editor.html 用）
├── _worker.js               ← Cloudflare Pages Functions，实际部署使用这个
├── worker/worker.js         （早期独立 Worker 版本，已被 _worker.js 取代，未删除但不再使用）
├── CHANGELOG.md
└── README.md
```

前端所有页面部署在 Cloudflare Pages，`_worker.js` 放在仓库根目录，会被 Cloudflare Pages 自动识别为 Pages Functions，跟前端一起部署，不需要单独 `wrangler deploy`。

---

## 1. Cloudflare Pages 部署说明

1. 将本仓库推送到 GitHub（`rouzhen-studio`）。
2. Cloudflare 控制台 → **Workers & Pages** → **创建应用程序** → **Pages** → **连接到 Git**。
3. 选择该仓库，构建设置：
   - 框架预设：无（None / 静态站点）
   - 构建命令：留空
   - 构建输出目录：`/`（仓库根目录）
4. 部署完成后会得到一个 `*.pages.dev` 域名，可在 Pages 设置里绑定自定义域名。
5. 之后每次 push 到主分支，Pages 会自动重新部署。

---

## 2. R2 Bucket 创建步骤

1. Cloudflare 控制台 → **R2** → **创建存储桶**，起一个名字（例如 `rouzhen-studio`）。
2. 进入该 Bucket → **设置** → **公开访问**：
   - 开启 **R2.dev 公开 URL**，会得到一个形如 `https://pub-xxxxxxxx.r2.dev` 的域名；
   - 或绑定自定义域名（例如 `images.yourdomain.com`），更适合长期使用。
3. 记下这个公开访问域名，后面配置 Worker 环境变量 `PUBLIC_BASE_URL` 时要用到。

> 注意：开启公开访问后，Bucket 内所有文件默认都可被外部直接访问，详见文末「公开/私有素材分离建议」。

---

## 3. Worker 部署步骤

Worker 独立于 Pages 部署，推荐用 [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)。

1. 本地安装 Wrangler（如未安装）：
   ```
   npm install -g wrangler
   ```
2. 登录 Cloudflare：
   ```
   wrangler login
   ```
3. 在 `worker/` 目录下新建 `wrangler.toml`（未包含在本仓库文件结构中，需自行创建），示例：
   ```toml
   name = "rouzhen-studio-worker"
   main = "worker.js"
   compatibility_date = "2024-01-01"

   [[r2_buckets]]
   binding = "BUCKET"
   bucket_name = "rouzhen-studio"
   ```
   `binding` 的值必须是 `BUCKET`，与 `worker.js` 中的 `env.BUCKET` 对应。
4. 部署：
   ```
   wrangler deploy
   ```
5. 部署成功后会得到一个 `https://<worker名>.<你的子域>.workers.dev` 地址。
6. 打开 `js/app.js`，把顶部 `CONFIG.WORKER_URL` 改成这个地址加 `/upload`，例如：
   ```
   https://rouzhen-studio-worker.yoursubdomain.workers.dev/upload
   ```
   改完提交并让 Pages 重新部署。

---

## 4. 环境变量配置说明

在 Cloudflare 控制台 → 该 Worker → **设置** → **变量和机密** 中添加以下三项：

| 变量名 | 类型 | 说明 |
|---|---|---|
| `UPLOAD_TOKEN` | 环境变量（建议设为 Secret） | 自己设定的上传口令字符串，与前端浮层输入的口令一致 |
| `BUCKET` | R2 Bucket 绑定 | 绑定到第 2 步创建的 R2 Bucket（也可在 `wrangler.toml` 里配置，二选一，控制台配置的会覆盖本地配置） |
| `PUBLIC_BASE_URL` | 环境变量 | R2 的公开访问域名，例如 `https://pub-xxxxxxxx.r2.dev`，**结尾不要加斜杠** |

配置完成后需要重新部署 Worker 生效（控制台修改环境变量通常自动生效，Binding 变更可能需要重新 `wrangler deploy` 或在控制台手动保存）。

---

## 5. 关于 Token 方案的说明

当前的口令（`UPLOAD_TOKEN`）机制是为了防止陌生人随意上传文件到 Bucket，**不是一个用户系统**：

- 没有账号、没有多用户、没有权限分级；
- 口令只有你自己一个人使用，忘记就直接去 Worker 环境变量里重新设置；
- 前端把口令存在浏览器 `localStorage`，仅用于免去每次上传都要输入；
- 这套方案只适合"单人个人工具"场景，如果未来要多人协作或对外开放，需要重新设计鉴权方式（例如引入真正的用户系统），不在 V0.1 范围内。

---

## 6. 未来公开/私有素材分离建议

当前 V0.1 所有图片都存放在同一个公开访问的 Bucket 里，路径统一为 `images/YYYY/MM/DD/文件名`，只要知道 URL 就能访问，没有区分素材的公开或私有属性。

未来如果需要区分「可以公开分享的素材」和「仅自己使用的私有素材」，可以考虑的方向（V0.1 暂不实现）：

- 用两个独立的路径前缀，例如 `images/public/...` 和 `images/private/...`，私有路径不开放 R2 公开访问，而是通过 Worker 生成带签名、有时效性的临时访问链接；
- 或者拆分成两个 Bucket：一个公开 Bucket，一个私有 Bucket，分别绑定不同权限；
- 上传时前端增加一个「公开 / 私有」的选择，由 Worker 根据选择写入不同路径或 Bucket。

这部分涉及权限模型变化，建议作为独立版本迭代，不建议在 V0.1 里直接叠加。
