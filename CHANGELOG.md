# ROUZHEN Studio — CHANGELOG

## v0.4.1 — Metadata Enhancement（本次）

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
| **v0.4.1** | Metadata Enhancement | 尺寸信息回填 + 单图复制 URL/Markdown/HTML（本次） |
| **v0.4.2** | Maintenance Jobs | 把"生成缺失缩略图""回填旧图尺寸""重建索引"等统一到一个维护页面，做成任务列表形式，而不是每个字段单独写一个工具 |
| **v0.5.0** | Asset Library 正式版 | 搜索、按标签/日期筛选、排序，Asset Library 核心浏览功能补齐 |

v0.4.2 里会补上 v0.4.1 遗留的一件事：老的历史图片（本次上线前上传的）没有真实 width/height，需要一个批量回填任务，回填逻辑和"生成缺失缩略图"是同一类操作，放在 Maintenance Jobs 里一起做最合适。
