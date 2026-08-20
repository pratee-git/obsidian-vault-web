// Run with: node vault-web/relink.test.js
const assert = require("assert");
const { rewriteWikiLinks, vaultPath } = require("./server");

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

console.log("relink: all assertions passed");
