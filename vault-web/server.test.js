// Run with: VAULT_ROOT=/tmp node vault-web/server.test.js
const assert = require("assert");
const crypto = require("crypto");

const TEAM = "test.cloudflareaccess.com";
const AUD = "aud-tag-under-test";
process.env.ACCESS_TEAM_DOMAIN = TEAM;
process.env.ACCESS_AUD = AUD;

const { rewriteWikiLinks, linkIndex, vaultPath, verifyAccessJwt } = require("./server");

const FROM = "10_Projects/Old/Vault Web-CONTEXT.md";
const TO = "30_Resources/New/Notes Web.md";
const rewrite = (text) => rewriteWikiLinks(text, FROM, TO);

// title-style links keep their style, path-style links keep theirs
assert.strictEqual(rewrite("see [[Vault Web-CONTEXT]]"), "see [[Notes Web]]");
assert.strictEqual(
  rewrite("see [[10_Projects/Old/Vault Web-CONTEXT]]"),
  "see [[30_Resources/New/Notes Web]]",
  "a path-style link gets the new path, not the bare title");
assert.strictEqual(rewrite("[[Vault Web-CONTEXT|the plan]]"), "[[Notes Web|the plan]]");
assert.strictEqual(rewrite("[[Vault Web-CONTEXT#Ports]]"), "[[Notes Web#Ports]]");
assert.strictEqual(rewrite("[[Vault Web-CONTEXT#Ports|ports]]"), "[[Notes Web#Ports|ports]]");
assert.strictEqual(
  rewrite("[[10_Projects/Old/Vault Web-CONTEXT#Ports|ports]]"),
  "[[30_Resources/New/Notes Web#Ports|ports]]");
assert.strictEqual(rewrite("[[vault web-context]]"), "[[Notes Web]]", "match is case-insensitive");
assert.strictEqual(rewrite("[[Vault Web-CONTEXT.md]]"), "[[Notes Web]]");
assert.strictEqual(rewrite("[[/10_Projects/Old/Vault Web-CONTEXT]]"), "[[30_Resources/New/Notes Web]]",
  "a leading slash still resolves");
assert.strictEqual(rewrite("[[Xolo-CONTEXT]]"), "[[Xolo-CONTEXT]]", "other links untouched");
assert.strictEqual(rewrite("[[10_Projects/Other/Vault Web-CONTEXT]]"), "[[10_Projects/Other/Vault Web-CONTEXT]]",
  "a same-titled note in another folder is not touched by a path-style link");
assert.strictEqual(rewrite("Vault Web-CONTEXT"), "Vault Web-CONTEXT", "bare text untouched");

// A pure move must still relink, or every path-style link to it dies.
assert.strictEqual(
  rewriteWikiLinks("[[10_Projects/Old/Note]]", "10_Projects/Old/Note.md", "20_Areas/Work/Note.md"),
  "[[20_Areas/Work/Note]]",
  "moving without renaming still rewrites path-style links");

// --- link resolution ---

const files = [
  { path: "10_Projects/Project Xolo/XOLO-CONTEXT.md", name: "XOLO-CONTEXT" },
  { path: "10_Projects/Project Lifestream/LIFESTREAM-CONTEXT.md", name: "LIFESTREAM-CONTEXT" },
  { path: "Base/XOLO-CONTEXT.md", name: "XOLO-CONTEXT" },
];
const index = linkIndex(files);

assert.strictEqual(index.resolve("10_Projects/Project Xolo/XOLO-CONTEXT").path, files[0].path,
  "a full-path link resolves — this is what the vault actually uses");
assert.strictEqual(index.resolve("Base/XOLO-CONTEXT").path, files[2].path,
  "the path picks the right one of two same-titled notes");
assert.strictEqual(index.resolve("LIFESTREAM-CONTEXT").path, files[1].path, "a bare title still resolves");
assert.strictEqual(index.resolve("10_Projects/Project Xolo/XOLO-CONTEXT.md#Ports|xolo").path, files[0].path,
  "section and alias are stripped before matching");
assert.strictEqual(index.resolve("XOLO-CONTEXT").path, files[0].path, "an ambiguous title takes the first match");
assert.strictEqual(index.resolve("10_Projects/Nope/Missing"), null);

// Traversal is neutralised by stripping the leading ../, so it lands inside the
// vault rather than throwing; an absolute path is what trips the guard.
assert.strictEqual(vaultPath("../../../etc/passwd.md"), `${process.env.VAULT_ROOT}/etc/passwd.md`);
assert.throws(() => vaultPath("/etc/passwd.md"), /escapes vault root/);


// --- Cloudflare Access JWT ---

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const kid = "test-kid";
const keys = new Map([[kid, publicKey]]);
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

function sign(payload, { alg = "RS256", keyId = kid, tamper = false } = {}) {
  const head = b64({ alg, kid: keyId, typ: "JWT" });
  const body = b64(payload);
  const signature = crypto
    .sign("RSA-SHA256", Buffer.from(`${head}.${body}`), privateKey)
    .toString("base64url");
  return `${head}.${tamper ? b64({ ...payload, aud: "someone-else" }) : body}.${signature}`;
}

const future = Math.floor(Date.now() / 1000) + 600;
const valid = { aud: [AUD], iss: `https://${TEAM}`, exp: future, email: "pratee@example.com" };

const check = async () => {
  assert.strictEqual(await verifyAccessJwt(sign(valid), keys), true, "a well-formed token passes");
  assert.strictEqual(
    await verifyAccessJwt(sign({ ...valid, aud: ["another-app"] }), keys), false,
    "a token minted for a different Access app is rejected");
  assert.strictEqual(
    await verifyAccessJwt(sign({ ...valid, iss: "https://evil.cloudflareaccess.com" }), keys), false,
    "a token from another team is rejected");
  assert.strictEqual(
    await verifyAccessJwt(sign({ ...valid, exp: Math.floor(Date.now() / 1000) - 1 }), keys), false,
    "an expired token is rejected");
  assert.strictEqual(await verifyAccessJwt(sign(valid, { tamper: true }), keys), false,
    "a payload edited after signing is rejected");
  assert.strictEqual(await verifyAccessJwt(sign(valid, { alg: "none" }), keys), false,
    "alg=none is rejected");
  assert.strictEqual(await verifyAccessJwt(sign(valid, { keyId: "unknown" }), keys), false,
    "an unknown signing key is rejected");
  assert.strictEqual(await verifyAccessJwt("", keys), false);
  assert.strictEqual(await verifyAccessJwt("not.a.jwt", keys), false);

  // vault-web is Pratee's own reader behind Cloudflare Access, not an agent:
// 50_Private stays fully visible here. Only the internal dirs are refused.
assert.ok(vaultPath("50_Private/Health/labs.md"));
assert.throws(() => vaultPath(".git/config"), /not served/);
assert.ok(vaultPath("10_Projects/x.md"));

console.log("server: all assertions passed");
};

check();
