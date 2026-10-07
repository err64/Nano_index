#!/usr/bin/env node
/**
 * Veriforge 官网构建脚本（零依赖）
 * 片段拼装 + 内容渲染 + SVG 雪碧图 + sitemap/robots 生成
 * 用法：node build.js   （环境变量 SITE_URL 覆盖默认域名）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(ROOT, "src");
const ASSETS = path.join(ROOT, "assets");
const DIST = path.join(ROOT, "dist");
const SITE_URL = (process.env.SITE_URL || "https://veriforge.nanofactory.dev").replace(/\/+$/, "");

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* ---------- 页面元数据 ---------- */
const NAV = [
  { id: "index", label: "首页", href: "/" },
  { id: "project", label: "项目介绍", href: "/project" },
  { id: "products", label: "产品与服务", href: "/products" },
  { id: "cases", label: "用户案例", href: "/cases" },
  { id: "articles", label: "技术文章", href: "/articles" },
  { id: "about", label: "关于实验室", href: "/about" },
  { id: "help", label: "帮助中心", href: "/help" },
];

const PAGES = {
  index: { file: "index.html", path: "/", title: "Veriforge · 可验证的 AI 编码工人引擎 | NANOFACTORY", desc: "Veriforge 在隔离的 Git Worktree 中驱动 Codex、Claude Code 等编码模型完成真实代码修改，以五级防篡改验证阶梯与机器证据链裁决每一次 AI 交付。", og: "website" },
  project: { file: "project.html", path: "/project", title: "项目介绍 · 发展历程与核心优势 | Veriforge", desc: "了解 Veriforge 的立项背景：为什么完成判定权必须离开模型。发展历程、两轮系统性审查纪要与核心优势对照。", og: "article" },
  products: { file: "products.html", path: "/products", title: "产品与服务 · 五大子系统与部署支持 | Veriforge", desc: "确定性状态机、防篡改验证引擎、多 Runtime 路由、生产控制平面与安全可观测。开源社区版加企业部署支持与试点陪跑。", og: "article" },
  articles: { file: "articles.html", path: "/articles", title: "技术文章 · Veriforge 实践系列 | Veriforge", desc: "防作弊、可复现、成本治理：来自 Veriforge 真实实现的长文拆解，所有机制今天就能在你自己的仓库落地。", og: "article" },
  cases: { file: "cases.html", path: "/cases", title: "用户案例 · 可复核的证据链 | Veriforge", desc: "增值税缺陷 6 秒修复、遗留缺陷批量清偿、内网控制平面部署：每个案例的指标都能在你的机器上重放复现。", og: "article" },
  about: { file: "about.html", path: "/about", title: "关于实验室 · 独立开发与联系 | Veriforge", desc: "NANOFACTORY 是独立实验室，由一人维护。MIT 协议，公开构建，所有验证证据可复现。工作界面、生态伙伴、试点申请与联系方式。", og: "article" },
  help: { file: "help.html", path: "/help", title: "帮助中心 · 快速上手与常见问题 | Veriforge", desc: "五分钟本地跑通 Veriforge：克隆、演示、控制台、接入真实模型，以及防作弊机制、故障排查等常见问题解答。", og: "article" },
  404: { file: "404.html", path: "/404.html", title: "页面不存在 | Veriforge", desc: "请求的页面不存在。", og: "website", noindex: true },
};

/* ---------- 内容渲染 ---------- */
const readData = (name) => JSON.parse(fs.readFileSync(path.join(SRC, "data", name), "utf8"));

const chipClass = { "防作弊": "chip-danger", "可复现性": "chip-ok", "成本治理": "chip-warn" };

/* ---------- 技术文章：frontmatter + 极简 Markdown ---------- */
/* 只实现文章实际用到的子集：h2-h4、围栏代码、GFM 表格、引用、有序/无序列表、
   分隔线、行内代码/加粗/斜体/链接。零依赖，转义先于一切行内替换。 */
function mdInline(s) {
  const codes = [];
  let t = s
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  t = t.replace(/`([^`]+)`/g, (_, c) => {
    codes.push("<code>" + c + "</code>");
    return "\x00" + (codes.length - 1) + "\x00";
  });
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" rel="noopener">$1</a>');
  return t.replace(/\x00(\d+)\x00/g, (_, i) => codes[+i]);
}

function renderMarkdown(src) {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  let codeSeq = 0;
  const isListItem = (l, ordered) => (ordered ? /^\s*\d+\.\s+/.test(l) : /^\s*[-*]\s+/.test(l));
  const startsBlock = (l) =>
    /^```/.test(l) || /^#{1,4}\s/.test(l) || /^>\s?/.test(l) || /^---+\s*$/.test(l) ||
    isListItem(l, false) || isListItem(l, true);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const fence = line.match(/^```([\w-]*)\s*$/);
    if (fence) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      const id = "code-" + (++codeSeq);
      out.push(
        '<figure class="codeblock">' +
        '<figcaption class="codeblock-head"><span>' + esc(fence[1] || "text") + "</span>" +
        '<button class="copy-btn" type="button" data-copy="' + id + '"><span>复制</span></button></figcaption>' +
        '<pre><code id="' + id + '">' + esc(buf.join("\n")) + "</code></pre></figure>"
      );
      continue;
    }

    const h = line.match(/^(#{2,4})\s+(.*)$/);
    if (h) {
      const lv = h[1].length;
      out.push("<h" + lv + ">" + mdInline(h[2]) + "</h" + lv + ">");
      i++; continue;
    }

    if (/^---+\s*$/.test(line)) { out.push("<hr>"); i++; continue; }

    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, "")); i++; }
      out.push("<blockquote>" + buf.map((l) => "<p>" + mdInline(l) + "</p>").join("") + "</blockquote>");
      continue;
    }

    const next = lines[i + 1] || "";
    if (line.includes("|") && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(next)) {
      const splitRow = (r) => r.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) { rows.push(splitRow(lines[i])); i++; }
      out.push(
        '<div class="table-scroll"><table>' +
        "<thead><tr>" + head.map((c) => "<th>" + mdInline(c) + "</th>").join("") + "</tr></thead>" +
        "<tbody>" + rows.map((r) => "<tr>" + r.map((c) => "<td>" + mdInline(c) + "</td>").join("") + "</tr>").join("") +
        "</tbody></table></div>"
      );
      continue;
    }

    if (isListItem(line, false) || isListItem(line, true)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items = [];
      while (i < lines.length && isListItem(lines[i], ordered)) {
        items.push(lines[i].replace(/^\s*(?:[-*]|\d+\.)\s+/, ""));
        i++;
      }
      out.push((ordered ? "<ol>" : "<ul>") + items.map((it) => "<li>" + mdInline(it) + "</li>").join("") + (ordered ? "</ol>" : "</ul>"));
      continue;
    }

    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) { para.push(lines[i]); i++; }
    out.push("<p>" + mdInline(para.join(" ")) + "</p>");
  }
  return out.join("\n");
}

function readArticles() {
  const dir = path.join(SRC, "articles");
  const arts = fs.readdirSync(dir).sort().filter((f) => f.endsWith(".md")).map((f) => {
    const raw = fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n?/g, "\n");
    const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
    if (!m) throw new Error("文章缺少 frontmatter: " + f);
    const meta = {};
    for (const l of m[1].split("\n")) {
      const kv = l.match(/^(\w+):\s*(.*)$/);
      if (kv) meta[kv[1]] = kv[2].replace(/^"(.*)"$/, "$1").trim();
    }
    for (const k of ["id", "title", "date", "summary"]) {
      if (!meta[k]) throw new Error("文章 frontmatter 缺少 " + k + ": " + f);
    }
    if (!/^[\w-]+$/.test(meta.id)) throw new Error("文章 id 含非法字符: " + meta.id);
    return {
      id: meta.id,
      part: Number(meta.part || 0),
      title: meta.title,
      date: meta.date,
      category: meta.category || "实践系列",
      featured: meta.featured === "true",
      summary: meta.summary,
      /* 阅读时长按中文约 650 字/分钟估算，含代码块 */
      minutes: Math.max(3, Math.round(raw.length / 650)),
      body: renderMarkdown(raw.slice(m[0].length)),
    };
  });
  if (arts.length === 0) throw new Error("src/articles 下没有文章");
  /* 列表序：新文章在前；同日按系列序号倒排 */
  return arts.sort((a, b) => (a.date === b.date ? b.part - a.part : a.date < b.date ? 1 : -1));
}

function articleTeaser(items) {
  const feat = items.find((n) => n.featured) || items[0];
  const rest = items.filter((n) => n !== feat).slice(0, 2);
  const one = (n, isFeat) => `
  <article class="newsitem${isFeat ? " news-feat reveal" : " reveal"}">
    <time datetime="${esc(n.date)}">${esc(n.date)}</time>
    <div>
      <h3><a href="/articles/${esc(n.id)}">${esc(n.title)}</a></h3>
      <p>${esc(n.summary)}</p>
    </div>
    <span class="chip ${chipClass[n.category] || ""}">${esc(n.category)}</span>
  </article>`;
  return one(feat, true) + rest.map((n) => one(n, false)).join("\n");
}

function articleListHtml(items) {
  return items.map((n) => `
  <article class="newsitem reveal" id="${esc(n.id)}">
    <time datetime="${esc(n.date)}">${esc(n.date)}</time>
    <div>
      <h3><a href="/articles/${esc(n.id)}">${esc(n.title)}</a></h3>
      <p>${esc(n.summary)}</p>
      <p class="article-item-meta">实践系列 · 第 ${esc(String(n.part))} 篇 · 阅读约 ${esc(String(n.minutes))} 分钟</p>
    </div>
    <span class="chip ${chipClass[n.category] || ""}">${esc(n.category)}</span>
  </article>`).join("\n");
}

function caseList(items) {
  return items.map((c, i) => `
  <article class="case-row reveal" id="${esc(c.id)}">
    <div class="case-row__body">
      <div class="case-row__head">
        <span class="chip">${esc(c.industry)}</span>
        <span class="case-row__index" aria-hidden="true">${String(i + 1).padStart(2, "0")}</span>
      </div>
      <h3 class="case-row__title">${esc(c.title)}</h3>
      <div class="case-narrative">
        <div class="case-fact">
          <h4>场景</h4>
          <p>${esc(c.scenario)}</p>
        </div>
        <div class="case-fact">
          <h4>挑战</h4>
          <p>${esc(c.challenge)}</p>
        </div>
        <div class="case-fact">
          <h4>方案</h4>
          <p>${esc(c.solution)}</p>
        </div>
      </div>
    </div>
    <div class="case-row__side">
      <figure class="evidence-win">
        <figcaption><i></i><i></i><i></i><span>验证证据</span></figcaption>
        <pre aria-label="证据摘录">${esc(c.evidence)}</pre>
      </figure>
      <ul class="case-metrics" aria-label="案例指标">
        ${c.metrics.map((m) => `<li>${esc(m)}</li>`).join("\n        ")}
      </ul>
    </div>
  </article>`).join("\n");
}

function faqList(items) {
  return items.map((f, i) => `
  <div class="acc-item">
    <h3>
      <button class="acc-btn" type="button" aria-expanded="false" aria-controls="faq-p-${i}" id="faq-b-${i}">
        <span>${esc(f.q)}</span>
        <svg class="ico" aria-hidden="true"><use href="/assets/img/icons.svg#plus"></use></svg>
      </button>
    </h3>
    <div class="acc-panel" id="faq-p-${i}" role="region" aria-labelledby="faq-b-${i}">
      <p>${esc(f.a)}</p>
    </div>
  </div>`).join("\n");
}

/* ---------- SVG 雪碧图 ---------- */
function buildSprite() {
  const symbols = [];
  const addDir = (dir, prefix) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir).sort()) {
      if (!f.endsWith(".svg")) continue;
      const raw = fs.readFileSync(path.join(dir, f), "utf8");
      const vb = (raw.match(/viewBox="([^"]+)"/) || [])[1] || "0 0 24 24";
      const inner = raw.slice(raw.indexOf(">", raw.indexOf("<svg")) + 1, raw.lastIndexOf("</svg>")).trim();
      const id = prefix + f.replace(/\.svg$/, "");
      symbols.push(`<symbol id="${id}" viewBox="${vb}" fill="currentColor">${inner}</symbol>`);
    }
  };
  addDir(path.join(SRC, "icons"), "");
  addDir(path.join(ASSETS, "img", "logos"), "logo-");
  return `<svg xmlns="http://www.w3.org/2000/svg"><defs>${symbols.join("\n")}</defs></svg>`;
}

/* ---------- JSON-LD ---------- */
const ORG_LD = JSON.stringify({
  "@context": "https://schema.org",
  "@graph": [
    { "@type": "Organization", "@id": `${SITE_URL}/#org`, name: "NANOFACTORY", url: SITE_URL, logo: `${SITE_URL}/assets/brand/icon.svg`, email: "shiganghai@gmail.com" },
    { "@type": "WebSite", "@id": `${SITE_URL}/#site`, name: "Veriforge 官网", url: SITE_URL, publisher: { "@id": `${SITE_URL}/#org` }, inLanguage: "zh-CN" },
  ],
});

function pageLd(id) {
  const p = PAGES[id];
  const bc = {
    "@context": "https://schema.org", "@type": "BreadcrumbList",
    itemListElement: (id === "index" ? [] : [{ "@type": "ListItem", position: 1, name: "首页", item: `${SITE_URL}/` }]).concat(
      id === "index" ? [] : [{ "@type": "ListItem", position: 2, name: p.title.split(" · ")[0], item: `${SITE_URL}${p.path}` }]
    ),
  };
  const blocks = [];
  if (id !== "index") blocks.push(bc);
  if (id === "products") blocks.push({
    "@context": "https://schema.org", "@type": "SoftwareApplication",
    name: "Veriforge", applicationCategory: "DeveloperApplication", operatingSystem: "Node.js 22+", 
    description: p.desc, url: `${SITE_URL}/products`, publisher: { "@id": `${SITE_URL}/#org` },
    license: "https://opensource.org/licenses/MIT", offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  });
  if (id === "articles") blocks.push({
    "@context": "https://schema.org", "@type": "CollectionPage",
    name: p.title, url: `${SITE_URL}/articles`, inLanguage: "zh-CN",
    publisher: { "@id": `${SITE_URL}/#org` },
    mainEntity: {
      "@type": "ItemList",
      itemListElement: readArticles().map((n, i) => ({
        "@type": "ListItem", position: i + 1, item: {
          "@type": "BlogPosting", headline: n.title, datePublished: n.date, url: `${SITE_URL}/articles/${n.id}`,
          description: n.summary, publisher: { "@id": `${SITE_URL}/#org` }, inLanguage: "zh-CN",
        },
      })),
    },
  });
  if (id === "help") blocks.push({
    "@context": "https://schema.org", "@type": "FAQPage",
    mainEntity: readData("faq.json").map((f) => ({
      "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  });
  /* JSON-LD 嵌入 HTML <script>：必须转义 <，防止内容中的 </script> 提前闭合标签注入任意 HTML */
  return blocks.map((b) => `<script type="application/ld+json">${JSON.stringify(b).replace(/</g, "\\u003c")}</script>`).join("\n");
}

/* ---------- 模板拼装 ---------- */
function render() {
  const partial = (name) => fs.readFileSync(path.join(SRC, "partials", name + ".html"), "utf8");
  const headP = partial("head"), headerP = partial("header"), footerP = partial("footer");

  const navHtml = NAV.map((n) => `      <a href="${n.href}" data-nav="${n.id}">${n.label}</a>`).join("\n");
  const activeNavHtml = (navId) => navId
    ? navHtml.replace(new RegExp(`data-nav="${navId}"`, "g"), `data-nav="${navId}" aria-current="page"`)
    : navHtml;

  const faq = readData("faq.json");
  const cases = readData("cases.json");
  const articles = readArticles();

  const OG_IMAGE = `${SITE_URL}/assets/img/og-cover.png`;

  const applySubs = (html, subs) => {
    html = html
      .replace("{{>head}}", headP)
      .replace("{{>header}}", headerP)
      .replace("{{>footer}}", footerP);
    for (const [k, v] of Object.entries(subs)) html = html.split(k).join(v);
    return html;
  };

  for (const [id, p] of Object.entries(PAGES)) {
    const html = fs.readFileSync(path.join(SRC, "pages", p.file), "utf8");
    const subs = {
      "{{TITLE}}": p.title,
      "{{DESC}}": p.desc,
      "{{CANONICAL}}": SITE_URL + (p.path === "/" ? "/" : p.path),
      "{{ROBOTS}}": p.noindex ? "noindex, nofollow" : "index, follow",
      "{{OG_TYPE}}": p.og,
      "{{OG_IMAGE}}": OG_IMAGE,
      "{{ORG_LD}}": ORG_LD,
      "{{PAGE_LD}}": pageLd(id),
      "{{NAV}}": activeNavHtml(id),
      "{{YEAR}}": String(new Date().getFullYear()),
      "{{ARTICLE_TEASER}}": id === "index" ? articleTeaser(articles) : "",
      "{{ARTICLE_LIST}}": id === "articles" ? articleListHtml(articles) : "",
      "{{CASES_LIST}}": id === "cases" ? caseList(cases) : "",
      "{{FAQ_LIST}}": id === "help" ? faqList(faq) : "",
    };
    fs.writeFileSync(path.join(DIST, p.file), applySubs(html, subs));
  }

  /* 文章详情页：dist/articles/<id>.html */
  const tpl = fs.readFileSync(path.join(SRC, "pages", "article.html"), "utf8");
  /* seriesOrder：阅读顺序（第 1 篇 → 第 N 篇），用于上一篇/下一篇 */
  const seriesOrder = [...articles].sort((a, b) => a.part - b.part);
  for (const a of articles) {
    const idx = seriesOrder.indexOf(a);
    const prev = seriesOrder[idx - 1];
    const next = seriesOrder[idx + 1];
    const side = (n, dir) => n
      ? `<a class="series-nav__item series-nav__item--${dir}" href="/articles/${esc(n.id)}">` +
        `<span>${dir === "prev" ? "上一篇" : "下一篇"}</span><b>${esc(n.title)}</b></a>`
      : `<span class="series-nav__item series-nav__item--${dir} is-empty" aria-hidden="true">${dir === "prev" ? "已是系列首篇" : "系列待续"}</span>`;
    const ld = JSON.stringify({
      "@context": "https://schema.org", "@type": "BlogPosting",
      headline: a.title, description: a.summary, datePublished: a.date,
      url: `${SITE_URL}/articles/${a.id}`, mainEntityOfPage: `${SITE_URL}/articles/${a.id}`,
      author: { "@id": `${SITE_URL}/#org` }, publisher: { "@id": `${SITE_URL}/#org` },
      inLanguage: "zh-CN",
    });
    const subs = {
      "{{TITLE}}": `${a.title} | Veriforge 实践系列`,
      "{{DESC}}": a.summary,
      "{{CANONICAL}}": `${SITE_URL}/articles/${a.id}`,
      "{{ROBOTS}}": "index, follow",
      "{{OG_TYPE}}": "article",
      "{{OG_IMAGE}}": OG_IMAGE,
      "{{ORG_LD}}": ORG_LD,
      "{{PAGE_LD}}": `<script type="application/ld+json">${ld.replace(/</g, "\\u003c")}</script>`,
      "{{NAV}}": activeNavHtml("articles"),
      "{{YEAR}}": String(new Date().getFullYear()),
      "{{ARTICLE_CHIP}}": `<span class="chip ${chipClass[a.category] || ""}">${esc(a.category)}</span>`,
      "{{ARTICLE_TITLE}}": esc(a.title),
      "{{ARTICLE_META}}": `发表于 <time datetime="${esc(a.date)}">${esc(a.date)}</time> · Veriforge 实践系列 第 ${esc(String(a.part))} 篇 · 阅读约 ${esc(String(a.minutes))} 分钟`,
      "{{ARTICLE_BODY}}": a.body,
      "{{ARTICLE_SERIES_NAV}}": side(prev, "prev") + side(next, "next"),
    };
    fs.mkdirSync(path.join(DIST, "articles"), { recursive: true });
    fs.writeFileSync(path.join(DIST, "articles", a.id + ".html"), applySubs(tpl, subs));
  }

  /* /news → /articles 兼容跳转（静态桩，任何托管方式下都可用） */
  fs.writeFileSync(path.join(DIST, "news.html"), `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>页面已迁移：技术文章 | Veriforge</title>
<meta name="robots" content="noindex, follow">
<link rel="canonical" href="${SITE_URL}/articles">
<meta http-equiv="refresh" content="0; url=/articles">
</head>
<body>
<p>「新闻动态」已升级为<a href="/articles">技术文章</a>，正在为你跳转……</p>
</body>
</html>
`);

  /* sitemap 与 robots（含文章详情页） */
  const today = new Date().toISOString().slice(0, 10);
  const urls = NAV.map((n) => `  <url><loc>${SITE_URL}${n.href === "/" ? "/" : n.href}</loc><lastmod>${today}</lastmod><changefreq>${n.id === "articles" ? "weekly" : "monthly"}</changefreq><priority>${n.id === "index" ? "1.0" : "0.8"}</priority></url>`).join("\n")
    + "\n" + articles.map((n) => `  <url><loc>${SITE_URL}/articles/${n.id}</loc><lastmod>${n.date}</lastmod><changefreq>monthly</changefreq><priority>0.6</priority></url>`).join("\n");
  fs.writeFileSync(path.join(DIST, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
  fs.writeFileSync(path.join(DIST, "robots.txt"), `User-agent: *\nAllow: /\nDisallow: /admin\n\nSitemap: ${SITE_URL}/sitemap.xml\n`);

  console.log(`build ok: ${Object.keys(PAGES).length} pages + ${articles.length} articles -> dist/ (SITE_URL=${SITE_URL})`);
}

/* ---------- 静态资产 ---------- */
function copyAssets() {
  fs.cpSync(ASSETS, path.join(DIST, "assets"), { recursive: true });
}

fs.mkdirSync(path.join(DIST, "assets", "img"), { recursive: true });
copyAssets();
fs.writeFileSync(path.join(DIST, "assets", "img", "icons.svg"), buildSprite());
render();
