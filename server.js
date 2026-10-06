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
const CONTENT_FILES = ["news.json", "cases.json", "faq.json"];

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json", ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8", ".woff2": "font/woff2",
};

/* 登录限速：每 IP 每分钟最多 5 次失败 */
const failLog = new Map();
const tooManyFails = (ip) => {
  const now = Date.now();
  const arr = (failLog.get(ip) || []).filter((t) => now - t < 60_000);
  failLog.set(ip, arr);
  return arr.length >= 5;
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
    const ip = req.socket.remoteAddress || "?";
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
      try {
        const parsed = JSON.parse(body);
        if (!Array.isArray(parsed)) throw new Error("根节点必须是数组");
        fs.writeFileSync(file, JSON.stringify(parsed, null, 2) + "\n");
      } catch (e) {
        return send(res, 400, JSON.stringify({ error: "JSON 无效：" + e.message }), MIME[".json"]);
      }
      const build = runBuild();
      return send(res, build.ok ? 200 : 500, JSON.stringify({ ok: build.ok, build: build.output }), MIME[".json"]);
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
