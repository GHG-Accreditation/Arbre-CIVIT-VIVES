// Vercel Routing Middleware: login for the whole site (app, data and manual).
//
// - Users and passwords come from the APP_USERS environment variable:
//     APP_USERS = "jordi:Contrasenya#2026, maria:AltraClau-55"
//   Every password must have 10+ characters and 3 of the 4 types
//   (lowercase, uppercase, digit, symbol); otherwise that user can't log in.
// - 5 failed attempts (per user or per IP) lock the login for 15 minutes.
//   The counters live in Upstash Redis (Vercel Marketplace), so clearing
//   cookies or changing browser does not reset them.
// - A successful login sets a signed, HttpOnly session cookie (8 hours).
//
// Required env vars: APP_USERS, SESSION_SECRET (32+ random characters) and
// the Upstash REST credentials (KV_REST_API_URL + KV_REST_API_TOKEN, or
// UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN). If anything is missing
// the site stays closed.

export const config = { matcher: "/:path*" };

const MAX_ATTEMPTS = 5;
const LOCK_SECONDS = 15 * 60;
const SESSION_SECONDS = 8 * 60 * 60;
const COOKIE = "arbre_session";
const MIN_LENGTH = 10;
const MIN_CLASSES = 3;

const enc = new TextEncoder();

export function passwordProblems(pw) {
  const problems = [];
  if (pw.length < MIN_LENGTH) problems.push(`mínim ${MIN_LENGTH} caràcters`);
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(r => r.test(pw)).length;
  if (classes < MIN_CLASSES) problems.push("3 de 4 tipus: minúscula, majúscula, número, símbol");
  return problems;
}

function parseUsers(raw) {
  const users = new Map();
  for (const entry of (raw || "").split(/[,\n]/)) {
    const i = entry.indexOf(":");
    if (i <= 0) continue;
    const user = entry.slice(0, i).trim().toLowerCase();
    const pass = entry.slice(i + 1).trim();
    if (user && pass) users.set(user, pass);
  }
  return users;
}

function settings() {
  const env = process.env;
  return {
    users: parseUsers(env.APP_USERS),
    secret: env.SESSION_SECRET || "",
    redisUrl: (env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, ""),
    redisToken: env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN || "",
  };
}

/* ---------- crypto helpers ---------- */

function b64url(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s) {
  return atob(s.replace(/-/g, "+").replace(/_/g, "/"));
}
async function hmac(secret, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}
// Constant-time comparison: compare HMACs of both values.
async function safeEqual(secret, a, b) {
  const [x, y] = await Promise.all([hmac(secret, a), hmac(secret, b)]);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.min(x.length, y.length); i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

async function makeSession(secret, user) {
  const payload = b64url(enc.encode(JSON.stringify({ u: user, exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS })));
  return `${payload}.${await hmac(secret, payload)}`;
}
async function readSession(secret, users, cookieHeader) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(cookieHeader || "");
  if (!m) return null;
  const [payload, sig] = m[1].split(".");
  if (!payload || !sig || !(await safeEqual(secret, sig, await hmac(secret, payload)))) return null;
  try {
    const data = JSON.parse(fromB64url(payload));
    if (!data.exp || data.exp < Date.now() / 1000) return null;
    if (!users.has(data.u)) return null; // user removed from APP_USERS
    return data.u;
  } catch (_) { return null; }
}

/* ---------- attempt counters (Upstash Redis REST) ---------- */

async function redis(cfg, commands) {
  const res = await fetch(`${cfg.redisUrl}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.redisToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error(`Redis ${res.status}`);
  return (await res.json()).map(r => r.result);
}

// Returns the seconds left on the lock (0 = not locked).
async function lockedFor(cfg, keys) {
  const ttls = await redis(cfg, keys.map(k => ["TTL", `lock:${k}`]));
  return Math.max(0, ...ttls.map(t => (typeof t === "number" ? t : 0)));
}

// Records a failure; returns attempts left before the lock.
async function registerFailure(cfg, keys) {
  const cmds = [];
  for (const k of keys) {
    cmds.push(["SET", `fail:${k}`, "0", "EX", String(LOCK_SECONDS), "NX"]);
    cmds.push(["INCR", `fail:${k}`]);
  }
  const out = await redis(cfg, cmds);
  const counts = keys.map((_, i) => Number(out[i * 2 + 1]) || 0);
  const lock = [];
  keys.forEach((k, i) => {
    if (counts[i] >= MAX_ATTEMPTS) {
      lock.push(["SET", `lock:${k}`, "1", "EX", String(LOCK_SECONDS)]);
      lock.push(["DEL", `fail:${k}`]);
    }
  });
  if (lock.length) await redis(cfg, lock);
  return Math.max(0, MAX_ATTEMPTS - Math.max(...counts));
}

async function clearFailures(cfg, keys) {
  await redis(cfg, keys.map(k => ["DEL", `fail:${k}`]));
}

/* ---------- pages ---------- */

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function page(status, { message = "", kind = "error", user = "", form = true } = {}) {
  const html = `<!doctype html>
<html lang="ca"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Accés — Arbre Genealògic</title>
<style>
  :root { --accent:#7c5e2e; --border:#d8d3c4; --text:#1f2937; --soft:#6b7280; }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    background:#f7f6f2; color:var(--text); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif; padding:16px; }
  .box { background:#fff; border:1px solid var(--border); border-radius:12px; padding:28px; width:100%; max-width:380px;
    box-shadow:0 4px 16px rgba(0,0,0,.06); }
  h1 { margin:0 0 4px; font-size:20px; }
  p.sub { margin:0 0 20px; color:var(--soft); font-size:13px; }
  label { display:block; font-size:13px; color:var(--soft); margin:12px 0 4px; }
  input { width:100%; padding:10px 12px; border:1px solid var(--border); border-radius:8px; font:inherit; font-size:15px; }
  input:focus { outline:none; border-color:var(--accent); }
  button { margin-top:18px; width:100%; padding:11px; border:0; border-radius:8px; background:var(--accent); color:#fff;
    font:inherit; font-weight:600; cursor:pointer; }
  .msg { margin:0 0 12px; padding:10px 12px; border-radius:8px; font-size:13px; }
  .msg.error { background:#fdecec; color:#991b1b; }
  .msg.info { background:#eef6ee; color:#166534; }
</style></head><body>
<div class="box">
  <h1>Arbre Genealògic</h1>
  <p class="sub">Família Civit · Vives — accés restringit</p>
  ${message ? `<p class="msg ${kind}">${escapeHtml(message)}</p>` : ""}
  ${form ? `<form method="post" action="/login" autocomplete="on">
    <label for="u">Usuari</label>
    <input id="u" name="user" autocomplete="username" required value="${escapeHtml(user)}" ${user ? "" : "autofocus"}>
    <label for="p">Contrasenya</label>
    <input id="p" name="password" type="password" autocomplete="current-password" required ${user ? "autofocus" : ""}>
    <button type="submit">Entrar</button>
  </form>` : ""}
</div></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
      "X-Robots-Tag": "noindex",
    },
  });
}

function redirect(location, cookie) {
  const headers = { Location: location, "Cache-Control": "no-store" };
  if (cookie) headers["Set-Cookie"] = cookie;
  return new Response(null, { status: 303, headers });
}

function minutes(sec) { return Math.max(1, Math.ceil(sec / 60)); }

/* ---------- entry point ---------- */

export default async function middleware(request) {
  const url = new URL(request.url);
  const cfg = settings();

  if (!cfg.users.size || cfg.secret.length < 32 || !cfg.redisUrl || !cfg.redisToken) {
    return page(503, { form: false, message: "Accés tancat: falta configurar APP_USERS, SESSION_SECRET (32+ caràcters) i la base de dades Upstash Redis a Vercel." });
  }

  if (url.pathname === "/logout") {
    return redirect("/login", `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
  }

  if (url.pathname === "/login") {
    if (request.method !== "POST") {
      if (await readSession(cfg.secret, cfg.users, request.headers.get("cookie"))) return redirect("/");
      return page(200);
    }
    const origin = request.headers.get("origin");
    if (origin && origin !== url.origin) return page(403, { message: "Petició no vàlida." });

    const form = await request.formData();
    const user = String(form.get("user") || "").trim().toLowerCase().slice(0, 100);
    const password = String(form.get("password") || "").slice(0, 200);
    const ip = (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
    const keys = [`user:${user}`, `ip:${ip}`];

    try {
      const wait = await lockedFor(cfg, keys);
      if (wait > 0) {
        return page(429, { user, message: `Massa intents fallits. Accés bloquejat; torna-ho a provar d'aquí a ${minutes(wait)} minuts.` });
      }
      const expected = cfg.users.get(user);
      const ok = (await safeEqual(cfg.secret, password, expected ?? "\u0000no-user")) && expected !== undefined;
      if (ok) {
        if (passwordProblems(expected).length) {
          return page(403, { user, message: "La contrasenya d'aquest usuari no compleix la política de seguretat (mínim 10 caràcters i 3 de 4 tipus). Cal que l'administrador la canviï." });
        }
        await clearFailures(cfg, keys);
        const token = await makeSession(cfg.secret, user);
        return redirect("/", `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}`);
      }
      const left = await registerFailure(cfg, keys);
      if (left <= 0) {
        return page(429, { user, message: `Massa intents fallits. Accés bloquejat durant ${LOCK_SECONDS / 60} minuts.` });
      }
      return page(401, { user, message: `Usuari o contrasenya incorrectes. Et queden ${left} intent${left === 1 ? "" : "s"} abans del bloqueig.` });
    } catch (e) {
      return page(503, { user, message: "No es pot verificar l'accés ara mateix (base de dades no disponible). Torna-ho a provar més tard." });
    }
  }

  if (await readSession(cfg.secret, cfg.users, request.headers.get("cookie"))) {
    return new Response(null, { headers: { "x-middleware-next": "1" } });
  }
  if (request.method === "GET" && (request.headers.get("accept") || "").includes("text/html")) {
    return redirect("/login");
  }
  return new Response("Cal iniciar sessió.", { status: 401, headers: { "Cache-Control": "no-store" } });
}
