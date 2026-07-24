# ROUZHEN Studio — CHANGELOG

## v0.5.0 — Studio 创作工作台化（进行中）

**目标**：从"几个独立工具页面"变成"以 Dashboard 为唯一入口的创作系统"。AI 负责想，Studio 负责管，Website 负责看。

**Step 1：Asset Resolver（已完成）**
- 新增 `POST /api/resolve-assets`：把文章内容里的 `{{asset:asset_id}}` 占位符解析成真实 `<img src="..." alt="">`
- 找不到对应素材时，保留 `<!-- 未找到素材：xxx --> ` 提示，不静默丢失
- 支持可选的 `recordUsage`，只有生成正式内容时才会把引用记录写进对应资产 metadata 的 `used_in` 字段，预览阶段不写，避免反复污染
- 没有修改 Asset Library、metadata 结构、上传流程、Publisher 输出

**Step 2：Article Editor ↔ Asset Library 连接（已完成）**
- 新增 `article/editor.html` + `js/editor.js`：左侧文本编辑区，右侧"最近上传"缩略图面板
- 点击缩略图 → 在光标位置插入纯占位符 `{{asset:asset_id}}`（不是 `![xxx](url)`），光标停在插入内容之后，面板不关闭，可连续插入
- 没有 asset_id 的老资产会显示为置灰不可点，不会插入错误引用
- **依赖修复**：`/api/assets` 原本只返回 R2 路径（`id`/`key`），没有暴露真正的 `asset_id`，Resolver 认的是 `asset_id`，这次给 `/api/assets` 的返回结果补上了这个字段（只是把已经算出来的值传出去，没有改动 Asset Library 内部逻辑）
- Editor 目标刻意做得很小：没有 Meta 区、没有中英文 tab、没有保存/生成按钮、没有拖拽排序/caption/图注/AI 描述

**Step 3：Studio Dashboard（已完成）**
- 新的根目录 `index.html` 变成 Dashboard，只有两个入口：`New Article` → `article/editor.html`，`Add Assets` → `assets/index.html`
- 原来平铺在根目录的三个页面挪进 `assets/` 子目录，统一归为"素材相关"：
  - `index.html`（原上传页）→ `assets/upload.html`
  - `gallery.html` → `assets/index.html`（现在的"Add Assets"入口）
  - `maintenance.html` → `assets/maintenance.html`
- 所有页面之间的相互链接、css/js 相对路径、`js/gallery.js` 和 `js/maintenance.js` 里硬编码的 `window.location.href = "/"` 跳转，都已同步更新为新路径
- 最近文章列表先是占位文字（"功能开发中，暂未接入数据源"），不接假数据，不影响主流程

**未完成（v0.5.0 剩余部分）**
- ⏳ 手机端 Editor 的底部抽屉选图交互（现在是简单的上下堆叠，能用但不是正式体验）
- ⏳ Article Editor 补全 Meta 区、保存草稿、生成网站文件（Publish Center 那一步）

---

## v0.4.1 — Metadata Enhancement

**Asset Library 尺寸信息**
- `assets/metadata/{asset_id}.json` 早已预留 `width`/`height` 字段，本次真正把值填了进去
- `POST /upload` 接收前端传来的可选 `width`/`height`（来自 `createImageBitmap` 已经读到的真实尺寸），写入 metadata
- `GET /api/assets` 返回结果新增 `width` / `height` / `dimensions`（如 `"4032 × 3024"`），老图片没有真实值时三个字段均为 `null`
- 修复：重建索引（`handleGenerateIndex` / `scanDirectory` 两处）此前会把 `width`/`height` 无条件重置为 `null`，现改为像 `title`/`tags` 一样保留已有值

**Asset Library 单张图操作**
- 每张缩略图新增：文件尺寸 + 上传时间展示
- 每张图新增三个复制按钮：`复制 URL` / `复制 Markdown` / `复制 HTML`
- 多选 + 批量复制 Markdown（此前已实现，本次未改动）

**遗留 bug 修复（合并自此前会话）**
- `/api/assets` 分页 cursor 此前完全不生效，每次都从头返回同样的前 N 张，现改为基于真实偏移量翻页
- `maintenance.js` 生成缩略图时曾硬编码一个可能过期的 R2 域名，导致全部图片加载失败，现改为使用后端接口返回的真实 `url`
- 缩略图 `<img>` 增加 `loading="lazy"`，减少一次性发起的图片请求数量

---

## 路线图

| 版本 | 主题 | 内容 |
|---|---|---|
| **v0.4.1** | Metadata Enhancement | 尺寸信息回填 + 单图复制 URL/Markdown/HTML（已完成） |
| **v0.5.0** | Studio Dashboard + Article Editor | Asset Resolver、Editor 插入机制、Dashboard 唯一入口（本次，进行中） |
| v0.5.1 | Maintenance Jobs | 缩略图生成 / 尺寸回填 / 索引重建统一到一个维护任务页面（原 v0.4.2，顺延） |
| v0.6.0 | Asset Library 正式版 | 搜索、按标签/日期筛选、排序 |

**已知待办（记在这里，避免遗漏）**：
- 上传时没有同步更新 `assets/metadata/index.json` 总索引的 bug（导致新图要等一次"重建索引"才会在素材库出现缩略图），已确认修复方案，暂缓到 v0.5.1 Maintenance Jobs 一起做

