#!/usr/bin/env node
/**
 * Veriforge 官网服务器（零依赖 Node HTTP）
 * - dist/ 静态托管 + 安全响应头 + 友好 404
 * - /admin 内容后台（Token 鉴权）：编辑 src/data/*.json 并即时重建
 *
 * 环境变量：
 *   PORT            监听端口（默认 8080）
 *   HOST            监听地址（默认 127.0.0.1，对外必须显式修改并配置 ADMIN_TOKEN）
 *   SITE_URL        构建用规范域名（重建时生效）
 *   ADMIN_TOKEN     内容后台令牌；未设置则 /admin 仅展示"未启用"
 *   HTTPS=1         反代已终止 TLS 时开启 HSTS 与 Upgrade-Insecure-Requests
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, "dist");
const DATA = path.join(ROOT, "src", "data");
const ADMIN_DIR = path.join(ROOT, "admin");

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "127.0.0.1";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const HTTPS_ON = process.env.HTTPS === "1";
const CONTENT_FILES = ["cases.json", "faq.json"];

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".avif": "image/avif",
  ".webmanifest": "application/manifest+json", ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8", ".woff2": "font/woff2",
};

/* 登录限速：每 IP 每分钟最多 5 次失败 */
const failLog = new Map();
const FAILLOG_MAX = 10_000;
const tooManyFails = (ip) => {
  const now = Date.now();
  const arr = (failLog.get(ip) || []).filter((t) => now - t < 60_000);
  failLog.set(ip, arr);
  /* 容量上限：海量伪造源 IP 各失败一次会让 Map 无界增长（内存 DoS）。
     超限时先清除已过期的空条目，仍超限则按插入序淘汰最旧 key。 */
  if (failLog.size > FAILLOG_MAX) {
    for (const [k, v] of failLog) {
      if (!v.some((t) => now - t < 60_000)) failLog.delete(k);
    }
    for (const k of failLog.keys()) {
      if (failLog.size <= FAILLOG_MAX) break;
      failLog.delete(k);
    }
  }
  return arr.length >= 5;
};

/* 限速键：反代部署（Caddy/nginx）时 remoteAddress 恒为回环地址，若直接以其计键，
   所有访客共享一个限速桶，攻击者 5 次失败即可锁定全部管理员。
   因此仅在直连方为回环（即处于文档标准反代部署）时采信 X-Forwarded-For 的
   最后一跳——该值由直接连接本服务的可信反代追加，无法被上游伪造。
   直接暴露公网时 remoteAddress 为真实客户端地址，XFF 一律忽略以防伪造绕过。 */
const clientKey = (req) => {
  const ra = req.socket.remoteAddress || "?";
  const loopback = ra === "127.0.0.1" || ra === "::1" || ra === "::ffff:127.0.0.1";
  if (loopback) {
    const hops = String(req.headers["x-forwarded-for"] || "")
      .split(",").map((s) => s.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return ra;
};

function securityHeaders(res, isHtml) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; " +
    "connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; " +
    "frame-ancestors 'none'; form-action 'self'"
  );
  if (HTTPS_ON) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    res.setHeader("Content-Security-Policy",
      res.getHeader("Content-Security-Policy") + "; upgrade-insecure-requests");
  }
  if (isHtml) res.setHeader("Cache-Control", "no-cache, must-revalidate");
}

function send(res, status, body, type, cache) {
  res.statusCode = status;
  if (type) res.setHeader("Content-Type", type);
  if (cache) res.setHeader("Cache-Control", cache);
  res.end(body);
}

function sendFile(res, absPath, status = 200) {
  const ext = path.extname(absPath).toLowerCase();
  const isAsset = absPath.includes(`${path.sep}assets${path.sep}`);
  const data = fs.readFileSync(absPath);
  securityHeaders(res, ext === ".html");
  res.statusCode = status;
  res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
  res.setHeader("Content-Length", data.length);
  if (isAsset) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  else if (ext === ".xml" || ext === ".txt") res.setHeader("Cache-Control", "public, max-age=3600");
  res.end(data);
}

function resolveStatic(urlPath) {
  let p;
  try { p = decodeURIComponent(urlPath.split("?")[0]); } catch { return null; }
  if (p.includes("\0") || p.includes("..")) return null;
  if (p === "/") p = "/index.html";
  const base = path.normalize(path.join(DIST, p));
  if (!base.startsWith(DIST + path.sep) && base !== DIST) return null;
  const candidates = [base, base + ".html", path.join(base, "index.html")];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

/* ---------- Admin API ---------- */
const isAdmin = (req) => {
  const cookie = req.headers.cookie || "";
  return cookie.split(/;\s*/).some((c) => c === `vf_admin=${ADMIN_TOKEN}`) && ADMIN_TOKEN.length > 0;
};

function adminDisabled(res) {
  send(res, 503, JSON.stringify({ error: "ADMIN_TOKEN 未配置，内容后台未启用" }), MIME[".json"]);
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function runBuild() {
  const r = spawnSync(process.execPath, [path.join(ROOT, "build.js")], {
    encoding: "utf8", env: { ...process.env },
    timeout: 60_000,
  });
  return { ok: r.status === 0, output: ((r.stdout || "") + (r.stderr || "")).trim() };
}

/* 内容 schema 校验：在写入入口收敛坏数据与注入面。
   三个文件统一拒绝空数组；
   id 限 [\w-]+、date 限 ISO 日期，杜绝其进入 HTML 属性位。
   （技术文章走 src/articles/*.md，由 git 管理，不经内容后台） */
const SCHEMAS = {
  "cases.json": (c) => c && typeof c === "object"
    && typeof c.id === "string" && /^[\w-]+$/.test(c.id)
    && typeof c.industry === "string"
    && typeof c.title === "string" && c.title.length > 0
    && typeof c.scenario === "string" && typeof c.challenge === "string" && typeof c.solution === "string"
    && Array.isArray(c.metrics) && c.metrics.every((s) => typeof s === "string")
    && typeof c.evidence === "string",
  "faq.json": (f) => f && typeof f === "object"
    && typeof f.q === "string" && f.q.length > 0
    && typeof f.a === "string" && f.a.length > 0,
};

function validateContent(name, arr) {
  if (!Array.isArray(arr)) return "根节点必须是数组";
  if (arr.length === 0) return "数组不能为空（至少保留一条内容）";
  const check = SCHEMAS[name];
  for (let i = 0; i < arr.length; i++) {
    if (!check(arr[i])) return `第 ${i + 1} 条数据不符合 ${name} 的内容模型（缺少必填字段或格式错误）`;
  }
  return null;
}

async function handleAdmin(req, res, url) {
  const p = url.pathname;

  /* 后台界面（静态） */
  if (req.method === "GET" && !p.startsWith("/admin/api")) {
    const rel = p.replace(/^\/admin\/?/, "") || "index.html";
    const abs = path.normalize(path.join(ADMIN_DIR, rel));
    if (!abs.startsWith(ADMIN_DIR) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return send(res, 404, "Not Found", MIME[".txt"]);
    }
    return sendFile(res, abs);
  }

  if (!ADMIN_TOKEN) return adminDisabled(res);

  /* 登录 / 登出 */
  if (p === "/admin/api/login" && req.method === "POST") {
    const ip = clientKey(req);
    if (tooManyFails(ip)) return send(res, 429, JSON.stringify({ error: "尝试过于频繁，请一分钟后再试" }), MIME[".json"]);
    const body = await readBody(req);
    let token = "";
    try { token = String(JSON.parse(body).token || ""); } catch {}
    if (token && token === ADMIN_TOKEN) {
      failLog.delete(ip);
      res.setHeader("Set-Cookie", `vf_admin=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
      return send(res, 200, JSON.stringify({ ok: true }), MIME[".json"]);
    }
    failLog.set(ip, [...(failLog.get(ip) || []), Date.now()]);
    return send(res, 401, JSON.stringify({ error: "令牌错误" }), MIME[".json"]);
  }
  if (p === "/admin/api/logout" && req.method === "POST") {
    res.setHeader("Set-Cookie", "vf_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
    return send(res, 200, JSON.stringify({ ok: true }), MIME[".json"]);
  }

  if (!isAdmin(req)) return send(res, 401, JSON.stringify({ error: "未登录" }), MIME[".json"]);

  /* 内容读写 */
  const m = p.match(/^\/admin\/api\/content\/([\w.-]+\.json)$/);
  if (m && CONTENT_FILES.includes(m[1])) {
    const file = path.join(DATA, m[1]);
    if (req.method === "GET") {
      return send(res, 200, fs.readFileSync(file, "utf8"), MIME[".json"]);
    }
    if (req.method === "PUT") {
      const body = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(body); } catch (e) {
        return send(res, 400, JSON.stringify({ error: "JSON 无效：" + e.message }), MIME[".json"]);
      }
      const invalid = validateContent(m[1], parsed);
      if (invalid) return send(res, 400, JSON.stringify({ error: invalid }), MIME[".json"]);

      /* 原子写入（临时文件 + rename）；构建失败自动回滚数据并重建，
         避免「文件已坏、dist 停在旧版、此后每次重建都失败」的不可自恢复状态 */
      const tmp = file + ".tmp";
      const orig = fs.existsSync(file) ? fs.readFileSync(file) : null;
      fs.writeFileSync(tmp, JSON.stringify(parsed, null, 2) + "\n");
      fs.renameSync(tmp, file);
      const build = runBuild();
      if (!build.ok) {
        if (orig !== null) {
          fs.writeFileSync(tmp, orig);
          fs.renameSync(tmp, file);
        }
        const restore = runBuild();
        return send(res, 500, JSON.stringify({
          error: "构建失败，数据已回滚到修改前版本",
          build: build.output,
          rollback: restore.ok ? "已按原数据重建，站点保持一致" : "回滚后重建仍失败，请检查 src/data 与手动重建",
        }), MIME[".json"]);
      }
      return send(res, 200, JSON.stringify({ ok: true, build: build.output }), MIME[".json"]);
    }
  }
  if (p === "/admin/api/rebuild" && req.method === "POST") {
    const build = runBuild();
    return send(res, build.ok ? 200 : 500, JSON.stringify({ ok: build.ok, build: build.output }), MIME[".json"]);
  }
  if (p === "/admin/api/status" && req.method === "GET") {
    const files = CONTENT_FILES.map((f) => {
      const st = fs.statSync(path.join(DATA, f));
      return { name: f, updatedAt: st.mtime.toISOString() };
    });
    return send(res, 200, JSON.stringify({ files, siteUrl: process.env.SITE_URL || "(默认)" }), MIME[".json"]);
  }
  return send(res, 404, JSON.stringify({ error: "未知接口" }), MIME[".json"]);
}

/* ---------- 服务器 ---------- */
/* 启动期校验：dist 内出现的扩展名必须都在 MIME 表内。
   未映射的类型会按 application/octet-stream 下发，叠加 nosniff 后浏览器将拒绝渲染（如图片破图）。 */
function validateDistMime() {
  if (!fs.existsSync(DIST)) return;
  const unknown = new Set();
  const stack = [DIST];
  while (stack.length) {
    const dir = stack.pop();
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      if (f.isDirectory()) stack.push(path.join(dir, f.name));
      else {
        const ext = path.extname(f.name).toLowerCase();
        if (ext && !MIME[ext]) unknown.add(ext);
      }
    }
  }
  if (unknown.size) {
    console.warn(`[veriforge-site] 警告: dist 存在未映射 MIME 的扩展名: ${[...unknown].join(" ")} —— 请在 MIME 表补齐，否则会被 nosniff 阻断`);
  }
}
validateDistMime();

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || "localhost"}`); }
  catch { return send(res, 400, "Bad Request", MIME[".txt"]); }

  if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
    try { return await handleAdmin(req, res, url); }
    catch (e) {
      return send(res, 500, JSON.stringify({ error: "服务器内部错误" }), MIME[".json"]);
    }
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return send(res, 405, "Method Not Allowed", MIME[".txt"]);
  }

  /* 目录式 URL 规范化：/project/ → 301 /project（与页面 canonical 一致，避免重复内容） */
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    securityHeaders(res, false);
    res.statusCode = 301;
    res.setHeader("Location", url.pathname.replace(/\/+$/, "") || "/");
    res.setHeader("Content-Length", "0");
    return res.end();
  }

  const file = resolveStatic(url.pathname);
  if (file) return sendFile(res, file);

  /* 友好 404 */
  const nf = path.join(DIST, "404.html");
  if (fs.existsSync(nf)) return sendFile(res, nf, 404);
  return send(res, 404, "404 Not Found", MIME[".txt"]);
});

server.listen(PORT, HOST, () => {
  console.log(`[veriforge-site] http://${HOST}:${PORT}  (dist: ${DIST})`);
  console.log(`[veriforge-site] admin: ${ADMIN_TOKEN ? "enabled" : "disabled (set ADMIN_TOKEN)"}`);
});
