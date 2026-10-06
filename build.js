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
  { id: "news", label: "新闻动态", href: "/news" },
  { id: "about", label: "关于我们", href: "/about" },
  { id: "help", label: "帮助中心", href: "/help" },
];

const PAGES = {
  index: { file: "index.html", path: "/", title: "Veriforge · 可验证的 AI 编码工人引擎 | NANOFACTORY", desc: "Veriforge 在隔离的 Git Worktree 中驱动 Codex、Claude Code 等编码模型完成真实代码修改，以五级防篡改验证阶梯与机器证据链裁决每一次 AI 交付。", og: "website" },
  project: { file: "project.html", path: "/project", title: "项目介绍 · 发展历程与核心优势 | Veriforge", desc: "了解 Veriforge 的立项背景：为什么完成判定权必须离开模型。发展历程、两轮系统性审查纪要与核心优势对照。", og: "article" },
  products: { file: "products.html", path: "/products", title: "产品与服务 · 五大子系统与部署支持 | Veriforge", desc: "确定性状态机、防篡改验证引擎、多 Runtime 路由、生产控制平面与安全可观测。开源社区版加企业部署支持与试点陪跑。", og: "article" },
  news: { file: "news.html", path: "/news", title: "新闻动态 · 项目进展与行业观察 | Veriforge", desc: "Veriforge 的版本里程碑、系统性审查纪要与工程深度文章，全部来自真实开发过程。", og: "article" },
  cases: { file: "cases.html", path: "/cases", title: "用户案例 · 可复核的证据链 | Veriforge", desc: "增值税缺陷 6 秒修复、遗留缺陷批量清偿、内网控制平面部署：每个案例的指标都能在你的机器上重放复现。", og: "article" },
  about: { file: "about.html", path: "/about", title: "关于我们 · 团队与联系 | Veriforge", desc: "NANOFACTORY 是一支小规模、高测试密度的工程团队。团队分工、生态伙伴、试点申请与联系方式。", og: "article" },
  help: { file: "help.html", path: "/help", title: "帮助中心 · 快速上手与常见问题 | Veriforge", desc: "五分钟本地跑通 Veriforge：克隆、演示、控制台、接入真实模型，以及防作弊机制、故障排查等常见问题解答。", og: "article" },
  404: { file: "404.html", path: "/404.html", title: "页面不存在 | Veriforge", desc: "请求的页面不存在。", og: "website", noindex: true },
};

/* ---------- 内容渲染 ---------- */
const readData = (name) => JSON.parse(fs.readFileSync(path.join(SRC, "data", name), "utf8"));

const chipClass = { "产品动态": "chip-accent" };

function newsTeaser(items) {
  const feat = items.find((n) => n.featured) || items[0];
  const rest = items.filter((n) => n !== feat).slice(0, 3);
  const one = (n, isFeat) => `
  <article class="newsitem${isFeat ? " news-feat reveal" : " reveal"}">
    <time datetime="${esc(n.date)}">${esc(n.date)}</time>
    <div>
      <h3><a href="/news#${esc(n.id)}">${esc(n.title)}</a></h3>
      <p>${esc(n.summary)}</p>
    </div>
    <span class="chip ${chipClass[n.category] || ""}">${esc(n.category)}</span>
  </article>`;
  return one(feat, true) + rest.map((n) => one(n, false)).join("\n");
}

function newsPageList(items) {
  return items.map((n) => `
  <article class="newsitem reveal" id="${esc(n.id)}">
    <time datetime="${esc(n.date)}">${esc(n.date)}</time>
    <div>
      <h3>${esc(n.title)}</h3>
      ${n.body.map((p) => `<p>${esc(p)}</p>`).join("\n      ")}
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
  if (id === "news") blocks.push({
    "@context": "https://schema.org", "@type": "ItemList",
    itemListElement: readData("news.json").map((n, i) => ({
      "@type": "ListItem", position: i + 1, item: {
        "@type": "NewsArticle", headline: n.title, datePublished: n.date, url: `${SITE_URL}/news#${n.id}`,
        description: n.summary, publisher: { "@id": `${SITE_URL}/#org` }, inLanguage: "zh-CN",
      },
    })),
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

  const news = readData("news.json");
  const faq = readData("faq.json");
  const cases = readData("cases.json");

  const OG_IMAGE = `${SITE_URL}/assets/img/og-cover.png`;

  for (const [id, p] of Object.entries(PAGES)) {
    let html = fs.readFileSync(path.join(SRC, "pages", p.file), "utf8");
    const activeNav = navHtml.replace(new RegExp(`data-nav="${id}"`, "g"), `data-nav="${id}" aria-current="page"`);
    const subs = {
      "{{TITLE}}": p.title,
      "{{DESC}}": p.desc,
      "{{CANONICAL}}": SITE_URL + (p.path === "/" ? "/" : p.path),
      "{{ROBOTS}}": p.noindex ? "noindex, nofollow" : "index, follow",
      "{{OG_TYPE}}": p.og,
      "{{OG_IMAGE}}": OG_IMAGE,
      "{{ORG_LD}}": ORG_LD,
      "{{PAGE_LD}}": pageLd(id),
      "{{NAV}}": activeNav,
      "{{YEAR}}": String(new Date().getFullYear()),
      "{{NEWS_TEASER}}": id === "index" ? newsTeaser(news) : "",
      "{{NEWS_PAGE_LIST}}": id === "news" ? newsPageList(news) : "",
      "{{CASES_LIST}}": id === "cases" ? caseList(cases) : "",
      "{{FAQ_LIST}}": id === "help" ? faqList(faq) : "",
    };
    html = html
      .replace("{{>head}}", headP)
      .replace("{{>header}}", headerP)
      .replace("{{>footer}}", footerP);
    for (const [k, v] of Object.entries(subs)) html = html.split(k).join(v);
    fs.writeFileSync(path.join(DIST, p.file), html);
  }

  /* sitemap 与 robots */
  const today = new Date().toISOString().slice(0, 10);
  const urls = NAV.map((n) => `  <url><loc>${SITE_URL}${n.href === "/" ? "/" : n.href}</loc><lastmod>${today}</lastmod><changefreq>${n.id === "news" ? "weekly" : "monthly"}</changefreq><priority>${n.id === "index" ? "1.0" : "0.8"}</priority></url>`).join("\n");
  fs.writeFileSync(path.join(DIST, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
  fs.writeFileSync(path.join(DIST, "robots.txt"), `User-agent: *\nAllow: /\nDisallow: /admin\n\nSitemap: ${SITE_URL}/sitemap.xml\n`);

  console.log(`build ok: ${Object.keys(PAGES).length} pages -> dist/ (SITE_URL=${SITE_URL})`);
}

/* ---------- 静态资产 ---------- */
function copyAssets() {
  fs.cpSync(ASSETS, path.join(DIST, "assets"), { recursive: true });
}

fs.mkdirSync(path.join(DIST, "assets", "img"), { recursive: true });
copyAssets();
fs.writeFileSync(path.join(DIST, "assets", "img", "icons.svg"), buildSprite());
render();
