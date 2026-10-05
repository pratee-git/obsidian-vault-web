const http = require("http");
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const VAULT_ROOT = process.env.VAULT_ROOT || process.cwd();
const PORT = Number(process.env.PORT || 4177);
const HOST = process.env.HOST || "127.0.0.1";
const APP_DIR = __dirname;
// A note row is ~120 bytes, so even a huge vault stays a small response.
const MAX_RESULTS = 5000;
const ACCESS_TOKEN = process.env.VAULT_WEB_TOKEN || crypto.randomBytes(32).toString("hex");
// Set BASE_ORIGIN to the public URL when serving through a tunnel, otherwise
// the browser Origin never matches and every write is rejected.
const BASE_ORIGIN = process.env.BASE_ORIGIN || `http://${HOST}:${PORT}`;
const HIDDEN_DIRS = new Set([
  ".git",
  ".obsidian",
  "node_modules",
  ".trash",
  // Claude Code worktrees: full copies of the vault frozen at branch time. Walked,
  // they put 1,486 stale notes in the list and let a wikilink resolve to an old copy.
  ".claude",
  ".tmp.drivedownload",
  ".tmp.driveupload",
]);

function send(res, status, body, type = "application/json; charset=utf-8", extraHeaders) {
  const payload =
    typeof body === "string" || Buffer.isBuffer(body)
      ? body
      : JSON.stringify(body);
  const length = Buffer.isBuffer(payload)
    ? payload.length
    : Buffer.byteLength(payload, "utf8");
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "Content-Length": length,
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  res.end(payload);
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  return !origin || origin === BASE_ORIGIN;
}

const TOKEN_COOKIE = "vault_web_token";

// When the origin sits behind Cloudflare Access, Access is the real gate and
// the shared token is only a fallback for direct localhost use. Access proves
// itself with a signed JWT, so verify the signature — never trust the header
// alone, which anything reaching the origin could set.
const ACCESS_TEAM_DOMAIN = process.env.ACCESS_TEAM_DOMAIN || "";
const ACCESS_AUD = process.env.ACCESS_AUD || "";
const CERTS_TTL_MS = 60 * 60 * 1000;
let certsCache = { at: 0, keys: new Map() };

async function accessKeys() {
  if (Date.now() - certsCache.at < CERTS_TTL_MS && certsCache.keys.size) {
    return certsCache.keys;
  }
  const response = await fetch(`https://${ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error(`Access certs: HTTP ${response.status}`);
  const { keys } = await response.json();
  const parsed = new Map();
  for (const jwk of keys || []) {
    parsed.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: "jwk" }));
  }
  certsCache = { at: Date.now(), keys: parsed };
  return parsed;
}

function decodeSegment(segment) {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

async function verifyAccessJwt(jwt, keys = null) {
  if (!ACCESS_TEAM_DOMAIN || !ACCESS_AUD || !jwt) return false;
  const parts = String(jwt).split(".");
  if (parts.length !== 3) return false;

  const [rawHeader, rawPayload, rawSignature] = parts;
  let header;
  let payload;
  try {
    header = decodeSegment(rawHeader);
    payload = decodeSegment(rawPayload);
  } catch {
    return false;
  }
  if (header.alg !== "RS256") return false;

  const key = (keys || (await accessKeys())).get(header.kid);
  if (!key) return false;

  const verified = crypto.verify(
    "RSA-SHA256",
    Buffer.from(`${rawHeader}.${rawPayload}`),
    key,
    Buffer.from(rawSignature, "base64url")
  );
  if (!verified) return false;

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= now) return false;
  if (typeof payload.nbf === "number" && payload.nbf > now + 60) return false;
  if (payload.iss !== `https://${ACCESS_TEAM_DOMAIN}`) return false;
  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  return audience.includes(ACCESS_AUD);
}

function cookieToken(req) {
  const raw = req.headers.cookie;
  if (!raw) return "";
  for (const part of raw.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === TOKEN_COOKIE) return decodeURIComponent(value.join("="));
  }
  return "";
}

async function authorized(req, url) {
  const header = req.headers["x-vault-web-token"];
  const query = url.searchParams.get("token");
  const token = (Array.isArray(header) ? header[0] : header) || query || cookieToken(req);
  if (token === ACCESS_TOKEN) return true;
  try {
    return await verifyAccessJwt(req.headers["cf-access-jwt-assertion"]);
  } catch {
    return false;
  }
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 5_000_000) {
        reject(new Error("Request body is too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function vaultPath(relPath = "") {
  const normalized = path
    .normalize(String(relPath).replace(/\\/g, "/"))
    .replace(/^(\.\.[/\\])+/, "");
  const absolute = path.resolve(VAULT_ROOT, normalized);
  const root = path.resolve(VAULT_ROOT);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    throw new Error("Path escapes vault root");
  }
  // HIDDEN_DIRS only prunes the walk; every /api/note route names its own path,
  // so the private zone has to be refused here or it stays fetchable directly.
  const top = path.relative(root, absolute).split(path.sep)[0];
  if (HIDDEN_DIRS.has(top)) {
    throw new Error("Path is not served");
  }
  return absolute;
}

// Renaming a note orphans every [[wikilink]] pointing at the old title, so
// rewrite them the way Obsidian does. Aliases and #sections are preserved.
// Rewrites links to a note that has moved or been renamed. Each link keeps the
// style it was written in: a path-style link gets the new path, a title-style
// link gets the new title. Aliases and #sections are preserved.
function rewriteWikiLinks(content, fromPath, toPath) {
  const fromKey = fromPath.replace(/\.md$/i, "").toLowerCase();
  const fromTitle = noteTitleFromPath(fromPath).toLowerCase();
  const toKey = toPath.replace(/\.md$/i, "");
  const toTitle = noteTitleFromPath(toPath);

  return content.replace(/\[\[([^\]]+)\]\]/g, (match, inner) => {
    const [targetPart, ...alias] = inner.split("|");
    const [rawTarget, ...section] = targetPart.split("#");
    const target = rawTarget.trim().replace(/^\/+/, "").replace(/\.md$/i, "").toLowerCase();

    let replacement;
    if (target === fromKey) replacement = toKey;
    else if (target === fromTitle) replacement = toTitle;
    else return match;

    return `[[${replacement}${section.length ? `#${section.join("#")}` : ""}${alias.length ? `|${alias.join("|")}` : ""}]]`;
  });
}

async function relinkNote(fromPath, toPath) {
  const files = await walk(VAULT_ROOT);
  let changed = 0;
  for (const file of files) {
    const abs = vaultPath(file.path);
    const content = await fs.readFile(abs, "utf8");
    const next = rewriteWikiLinks(content, fromPath, toPath);
    if (next === content) continue;
    await fs.writeFile(abs, next, "utf8");
    changed += 1;
  }
  return changed;
}

async function exists(absPath) {
  try {
    await fs.access(absPath);
    return true;
  } catch {
    return false;
  }
}

function toVaultRelative(absPath) {
  return path.relative(VAULT_ROOT, absPath).replace(/\\/g, "/");
}

function noteTitleFromPath(filePath) {
  return path.basename(filePath).replace(/\.md$/i, "");
}

function normalizeWikiTarget(target) {
  return String(target || "")
    .split("|")[0]
    .split("#")[0]
    .trim()
    .replace(/^\/+/, "")
    .replace(/\.md$/i, "");
}

// A wikilink may name a note by title ([[XOLO-CONTEXT]]) or by vault path
// ([[10_Projects/Project Xolo/XOLO-CONTEXT]]). Obsidian resolves both; matching
// on title alone reported every path-style link in the vault as broken.
function linkIndex(files) {
  const byPath = new Map();
  const byTitle = new Map();
  for (const file of files) {
    byPath.set(file.path.replace(/\.md$/i, "").toLowerCase(), file);
    // A duplicated title is ambiguous; keep the first, as Obsidian does.
    const title = file.name.toLowerCase();
    if (!byTitle.has(title)) byTitle.set(title, file);
  }
  return {
    resolve(target) {
      const key = normalizeWikiTarget(target).toLowerCase();
      return byPath.get(key) || byTitle.get(key) || null;
    },
  };
}

function extractWikiLinks(content) {
  const links = [];
  const seen = new Set();
  const re = /\[\[([^\]]+)\]\]/g;
  let match;
  while ((match = re.exec(content))) {
    const target = normalizeWikiTarget(match[1]);
    if (!target || seen.has(target.toLowerCase())) continue;
    seen.add(target.toLowerCase());
    links.push(target);
  }
  return links;
}

function snippetAround(content, at, length) {
  const start = Math.max(0, at - 40);
  const text = content.slice(start, at + length + 60).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${text}…`;
}

async function walk(dir, out = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".") && HIDDEN_DIRS.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!HIDDEN_DIRS.has(entry.name)) await walk(abs, out);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const stat = await fs.stat(abs);
    out.push({
      path: toVaultRelative(abs),
      name: entry.name.replace(/\.md$/i, ""),
      modified: stat.mtimeMs,
      size: stat.size,
    });
  }
  return out;
}

function contentVersion(content) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}

async function findNote(target) {
  const files = await walk(VAULT_ROOT);
  return linkIndex(files).resolve(target);
}

async function linkGraphFor(relPath) {
  const files = await walk(VAULT_ROOT);
  const index = linkIndex(files);
  const currentContent = await fs.readFile(vaultPath(relPath), "utf8");
  const outgoing = extractWikiLinks(currentContent).map((target) => {
    const note = index.resolve(target);
    return note || { name: target, path: "", missing: true };
  });

  const backlinks = [];
  for (const file of files) {
    if (file.path === relPath) continue;
    const content = await fs.readFile(vaultPath(file.path), "utf8");
    const hit = extractWikiLinks(content).some((link) => {
      const note = index.resolve(link);
      return note && note.path === relPath;
    });
    if (hit) backlinks.push(file);
  }
  backlinks.sort((a, b) => b.modified - a.modified);
  return { outgoing, backlinks };
}

function obsidianUrlFor(relPath) {
  const vault = path.basename(path.resolve(VAULT_ROOT));
  const file = relPath.replace(/\\/g, "/");
  return `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(file)}`;
}

async function api(req, res, url) {
  if (!sameOrigin(req)) {
    return send(res, 403, { error: "Forbidden origin" });
  }
  if (!(await authorized(req, url))) {
    return send(res, 401, { error: "Unauthorized" });
  }

  if (url.pathname === "/api/notes" && req.method === "GET") {
    const q = (url.searchParams.get("q") || "").trim().toLowerCase();
    const files = await walk(VAULT_ROOT);
    if (!q) {
      files.sort((a, b) => b.modified - a.modified);
      return send(res, 200, files.slice(0, MAX_RESULTS));
    }

    // ponytail: reads every note on each search. Fine at a few thousand notes;
    // add an mtime-keyed content cache if the vault outgrows that.
    const matches = [];
    for (const file of files) {
      if (file.path.toLowerCase().includes(q)) {
        matches.push(file);
        continue;
      }
      const content = await fs.readFile(vaultPath(file.path), "utf8");
      const at = content.toLowerCase().indexOf(q);
      if (at < 0) continue;
      matches.push({ ...file, snippet: snippetAround(content, at, q.length) });
    }
    matches.sort((a, b) => b.modified - a.modified);
    return send(res, 200, matches.slice(0, MAX_RESULTS));
  }

  if (url.pathname === "/api/folders" && req.method === "GET") {
    const files = await walk(VAULT_ROOT);
    const folders = new Set([""]);
    for (const file of files) {
      const parts = file.path.split("/");
      parts.pop();
      for (let i = 1; i <= parts.length; i += 1) {
        folders.add(parts.slice(0, i).join("/"));
      }
    }
    return send(res, 200, [...folders].sort());
  }

  if (url.pathname === "/api/status" && req.method === "GET") {
    return send(res, 200, {
      ok: true,
      vaultRoot: VAULT_ROOT,
      appDir: APP_DIR,
    });
  }

  if (url.pathname === "/api/note" && req.method === "GET") {
    const rel = url.searchParams.get("path");
    if (!rel || !rel.endsWith(".md")) return send(res, 400, { error: "Bad path" });
    const content = await fs.readFile(vaultPath(rel), "utf8");
    return send(res, 200, { path: rel, content, version: contentVersion(content) });
  }

  if (url.pathname === "/api/note" && req.method === "PUT") {
    const body = await parseBody(req);
    if (!body.path || !body.path.endsWith(".md")) {
      return send(res, 400, { error: "Bad path" });
    }
    // Refuse to overwrite a file that changed since this client loaded it (another
    // tab, an agent, git). Keyed on content, not mtime — Synology Drive touches mtime
    // without changing bytes. baseVersion is required: a client that does not send
    // it is a stale tab, which is exactly the writer this check exists to stop.
    const abs = vaultPath(body.path);
    const onDisk = await fs.readFile(abs, "utf8").catch(() => null);
    if (onDisk !== null && body.baseVersion !== contentVersion(onDisk)) {
      return send(res, 409, { error: "Note changed on disk since it was opened", version: contentVersion(onDisk) });
    }
    const content = String(body.content || "");
    await fs.writeFile(abs, content, "utf8");
    return send(res, 200, { ok: true, version: contentVersion(content) });
  }

  if (url.pathname === "/api/note" && req.method === "POST") {
    const body = await parseBody(req);
    const rawTitle = String(body.title || "").trim();
    if (!rawTitle) return send(res, 400, { error: "Title is required" });
    const safeTitle = rawTitle.replace(/[<>:"/\\|?*]/g, "-");
    const folder = String(body.folder || "Base").replace(/\\/g, "/");
    const rel = `${folder}/${safeTitle}.md`;
    const abs = vaultPath(rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const template = [
      "---",
      "type: concept-note",
      "inbox_status:",
      "  - Inbox",
      "---",
      "",
      `# ${rawTitle}`,
      "",
    ].join("\n");
    await fs.writeFile(abs, template, { encoding: "utf8", flag: "wx" });
    return send(res, 201, { path: rel, content: template });
  }

  // Rename and move are the same operation: give the note a new path.
  if (url.pathname === "/api/note" && req.method === "PATCH") {
    const body = await parseBody(req);
    if (!body.path || !body.path.endsWith(".md") || !body.to || !body.to.endsWith(".md")) {
      return send(res, 400, { error: "Bad path" });
    }
    const from = vaultPath(body.path);
    const to = vaultPath(body.to);
    if (from === to) return send(res, 200, { path: body.to });
    if (await exists(to)) {
      return send(res, 409, { error: "A note already exists at that path" });
    }
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.rename(from, to);
    const relinked = await relinkNote(body.path, toVaultRelative(to));
    return send(res, 200, { path: toVaultRelative(to), relinked });
  }

  // Deletes go to the vault-local .trash Obsidian already uses, so they stay recoverable.
  if (url.pathname === "/api/note" && req.method === "DELETE") {
    const rel = url.searchParams.get("path");
    if (!rel || !rel.endsWith(".md")) return send(res, 400, { error: "Bad path" });
    const from = vaultPath(rel);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const trashRel = `.trash/${rel.replace(/\//g, " - ").replace(/\.md$/i, "")} ${stamp}.md`;
    const to = vaultPath(trashRel);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.rename(from, to);
    return send(res, 200, { trashed: trashRel });
  }

  if (url.pathname === "/api/resolve" && req.method === "GET") {
    const title = url.searchParams.get("title") || "";
    const sectionless = title.split("#")[0].split("|")[0].trim();
    const file = await findNote(sectionless);
    return file ? send(res, 200, file) : send(res, 404, { error: "Not found" });
  }

  if (url.pathname === "/api/links" && req.method === "GET") {
    const rel = url.searchParams.get("path");
    if (!rel || !rel.endsWith(".md")) return send(res, 400, { error: "Bad path" });
    return send(res, 200, await linkGraphFor(rel));
  }

  if (url.pathname === "/api/obsidian-url" && req.method === "GET") {
    const rel = url.searchParams.get("path");
    if (!rel || !rel.endsWith(".md")) return send(res, 400, { error: "Bad path" });
    return send(res, 200, { url: obsidianUrlFor(rel) });
  }

  return false;
}

async function staticFile(req, res, url) {
  if (!sameOrigin(req)) {
    return send(res, 403, "Forbidden origin", "text/plain; charset=utf-8");
  }
  let rel = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  rel = rel.replace(/^\/+/, "");
  const abs = path.resolve(APP_DIR, rel);
  if (abs !== APP_DIR && !abs.startsWith(APP_DIR + path.sep)) {
    return send(res, 403, "Forbidden", "text/plain; charset=utf-8");
  }
  if (rel === "index.html") {
    // index.html carries the API token to the browser, so serving it to an
    // unauthenticated visitor hands out full read/write access to the vault.
    // The other assets are app code and stay open, or script tags would 401.
    if (!(await authorized(req, url))) {
      return send(res, 401, "Unauthorized", "text/plain; charset=utf-8");
    }
    const [html, css, js] = await Promise.all([
      fs.readFile(path.join(APP_DIR, "index.html"), "utf8"),
      fs.readFile(path.join(APP_DIR, "styles.css"), "utf8"),
      fs.readFile(path.join(APP_DIR, "app.js"), "utf8"),
    ]);
    const inline = html
      .replace('<link rel="stylesheet" href="/styles.css" />', `<style>${css}</style>`)
      .replace('<script defer src="/main.js"></script>', `<script>window.__VAULT_WEB_TOKEN__=${JSON.stringify(ACCESS_TOKEN)};</script><script>${js}</script>`);
    return send(res, 200, inline, "text/html; charset=utf-8", {
      "Set-Cookie": `${TOKEN_COOKIE}=${encodeURIComponent(ACCESS_TOKEN)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`,
    });
  }
  const ext = path.extname(abs).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml; charset=utf-8",
  };
  try {
    const data = await fs.readFile(abs);
    send(res, 200, data, types[ext] || "application/octet-stream");
  } catch {
    send(res, 404, "Not found", "text/plain; charset=utf-8");
  }
}

const server = http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${HOST}:${PORT}`);
      if (req.method === "OPTIONS") {
        if (sameOrigin(req)) {
          send(res, 204, "", "text/plain; charset=utf-8");
        } else {
          send(res, 403, "Forbidden origin", "text/plain; charset=utf-8");
        }
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        const handled = await api(req, res, url);
        if (handled === false) send(res, 404, { error: "Not found" });
        return;
      }
      await staticFile(req, res, url);
    } catch (error) {
      send(res, 500, { error: error.message });
    }
  });

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Vault Web: http://${HOST}:${PORT}`);
    console.log(`Vault root: ${VAULT_ROOT}`);
  });
}

module.exports = { rewriteWikiLinks, linkIndex, vaultPath, verifyAccessJwt, server };
