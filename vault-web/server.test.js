// Run with: VAULT_ROOT=/tmp node vault-web/server.test.js
const assert = require("assert");
const crypto = require("crypto");

const TEAM = "test.cloudflareaccess.com";
const AUD = "aud-tag-under-test";
process.env.ACCESS_TEAM_DOMAIN = TEAM;
process.env.ACCESS_AUD = AUD;

const { rewriteWikiLinks, vaultPath, verifyAccessJwt } = require("./server");

const rewrite = (text) => rewriteWikiLinks(text, "Vault Web-CONTEXT", "Notes Web");

assert.strictEqual(rewrite("see [[Vault Web-CONTEXT]]"), "see [[Notes Web]]");
assert.strictEqual(rewrite("[[Vault Web-CONTEXT|the plan]]"), "[[Notes Web|the plan]]");
assert.strictEqual(rewrite("[[Vault Web-CONTEXT#Ports]]"), "[[Notes Web#Ports]]");
assert.strictEqual(rewrite("[[Vault Web-CONTEXT#Ports|ports]]"), "[[Notes Web#Ports|ports]]");
assert.strictEqual(rewrite("[[vault web-context]]"), "[[Notes Web]]", "match is case-insensitive");
assert.strictEqual(rewrite("[[Vault Web-CONTEXT.md]]"), "[[Notes Web]]");
assert.strictEqual(rewrite("[[Xolo-CONTEXT]]"), "[[Xolo-CONTEXT]]", "other links untouched");
assert.strictEqual(rewrite("Vault Web-CONTEXT"), "Vault Web-CONTEXT", "bare text untouched");

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

  console.log("server: all assertions passed");
};

check();
