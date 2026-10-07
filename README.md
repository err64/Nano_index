# NANOFACTORY · Veriforge 官网

> **NANOFACTORY 是独立实验室，由一人维护。MIT 协议，公开构建，所有验证证据可复现。**

这是 [Veriforge](https://github.com/nano-factory/veriforge)（AI 编码 worker 的验证与交付治理框架）的官方网站。做的是验证工具：**用户信的是证据，不是规模。** 所以本站不写「我们是一家公司」，只陈述可以独立核实的事实——代码公开、构建公开、文章里的每个机制都指向真实实现，读者可以在自己的机器上重放验证。

## 本地构建

零依赖，Node 18.17+：

```bash
node build.js        # 构建：src/ + assets/ -> dist/
node server.js       # 本地预览：http://127.0.0.1:8080（dist 静态托管 + /admin 内容后台）
```

环境变量：`SITE_URL`（规范域名，默认 `https://veriforge.nanofactory.dev`）、`PORT`、`HOST`、`ADMIN_TOKEN`（启用内容后台）、`HTTPS=1`（反代终止 TLS 时开启 HSTS）。

## 目录结构

```
build.js            零依赖构建脚本：片段拼装 + Markdown 渲染 + SVG 雪碧图 + sitemap/robots
server.js           零依赖 Node HTTP：静态托管 + 安全响应头 + 友好 404 + /admin API
admin/              内容后台（Token 鉴权，编辑 src/data/*.json 并即时重建）
src/pages/          页面模板（articles.html 列表 / article.html 文章详情模板）
src/partials/       head / header / footer 公共片段
src/articles/       技术文章源文件（Markdown + 极简 frontmatter）
src/data/           cases.json、faq.json（内容后台可编辑）
src/icons/          内联 SVG 图标源
assets/             CSS / JS / 图片，构建时原样拷贝到 dist/assets
deploy/             Caddyfile / nginx.conf / systemd 服务文件
dist/               构建产物（随仓库提交，可直接静态托管）
```

## 内容维护

**技术文章**（git 管理，不经内容后台）：在 `src/articles/` 新增 `.md` 文件，头部使用极简 frontmatter：

```markdown
---
id: my-post            # URL 标识，限字母数字连字符
part: 4                # 系列序号，决定上一篇/下一篇
title: 文章标题
date: 2026-10-07       # 发布日期，列表按此倒排
category: 分类         # 映射列表页徽章颜色
summary: 一句话摘要，用于列表与 meta description
featured: true         # 可选：首页置顶
---

正文支持：## / ### 标题、```围栏代码、GFM 表格、引用、有序/无序列表、
行内代码、加粗、斜体、链接。
```

构建后生成 `/articles/<id>` 静态页，自动进入列表页、首页速览、sitemap 与 JSON-LD；`/news` 保留为静态跳转桩指向 `/articles`。

**案例与 FAQ**：编辑 `src/data/cases.json`、`src/data/faq.json`，或登录 `/admin` 内容后台修改（服务端 schema 校验 + 保存即重建 + 失败自动回滚）。

## 协议

MIT。仓库内的构建脚本、样式与文案均可自由使用与修改。
