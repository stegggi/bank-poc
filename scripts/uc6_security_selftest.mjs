#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { Wallet } from "ethers";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

async function importTranspiledTsModule(relativePath) {
  const absPath = path.join(repoRoot, relativePath);
  const source = await readFile(absPath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: absPath,
  }).outputText;
  const tempDir = await mkdtemp(path.join(repoRoot, ".uc6-selftest-"));
  const tempFile = path.join(tempDir, path.basename(relativePath, ".ts") + ".mjs");
  await writeFile(tempFile, transpiled, "utf8");
  try {
    return await import(pathToFileURL(tempFile).href);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function printResult(ok, label, detail = "") {
  const prefix = ok ? "PASS" : "FAIL";
  console.log(`${prefix} ${label}${detail ? ` :: ${detail}` : ""}`);
}

const failures = [];
async function run(label, fn) {
  try {
    await fn();
    printResult(true, label);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    failures.push({ label, detail });
    printResult(false, label, detail);
  }
}

const ownerAuth = await importTranspiledTsModule("lib/uc6OwnerAuth.ts");
const security = await import(pathToFileURL(path.join(repoRoot, "uc6-lp-bot/lib/security.mjs")).href);

await run("challenge replay protection is single-use", async () => {
  const nonce = ownerAuth.randomNonce(8);
  ownerAuth.saveChallenge({
    nonce,
    action: "update_settings",
    owner: Wallet.createRandom().address,
    payloadSha256: ownerAuth.sha256HexFromObject({ tradingEnabled: false }),
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAtMs: Date.now(),
  });
  assert.ok(ownerAuth.readChallenge(nonce));
  assert.ok(ownerAuth.consumeChallenge(nonce));
  assert.equal(ownerAuth.consumeChallenge(nonce), null);
});

await run("owner signature verifies for correct payload and action", async () => {
  const wallet = Wallet.createRandom();
  const payload = { tradingEnabled: false, bandHalfBps: 150 };
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const message = ownerAuth.makeOwnerMessage({
    action: "update_settings",
    owner: wallet.address,
    issuedAt,
    expiresAt,
    nonce: ownerAuth.randomNonce(8),
    payloadSha256: ownerAuth.sha256HexFromObject(payload),
  });
  const signature = await wallet.signMessage(message);
  const parsed = ownerAuth.verifyOwnerSignatureOrThrow({
    ownerAddress: wallet.address,
    message,
    signature,
    payload,
    expectedAction: "update_settings",
    nowMs: Date.now(),
    clockSkewSec: 30,
  });
  assert.equal(parsed.action, "update_settings");
});

await run("owner signature rejects expired challenge window", async () => {
  const wallet = Wallet.createRandom();
  const payload = {};
  const issuedAt = new Date(Date.now() - 120_000).toISOString();
  const expiresAt = new Date(Date.now() - 60_000).toISOString();
  const message = ownerAuth.makeOwnerMessage({
    action: "force_rebalance",
    owner: wallet.address,
    issuedAt,
    expiresAt,
    nonce: ownerAuth.randomNonce(8),
    payloadSha256: ownerAuth.sha256HexFromObject(payload),
  });
  const signature = await wallet.signMessage(message);
  assert.throws(() => {
    ownerAuth.verifyOwnerSignatureOrThrow({
      ownerAddress: wallet.address,
      message,
      signature,
      payload,
      expectedAction: "force_rebalance",
      nowMs: Date.now(),
      clockSkewSec: 30,
    });
  }, /expired|not yet valid/i);
});

await run("rate limiter trips after configured budget", async () => {
  const namespace = `uc6:selftest:${Date.now()}`;
  const ip = "127.0.0.1";
  assert.equal(ownerAuth.bestEffortRateLimit({ namespace, ip, limit: 2 }).ok, true);
  assert.equal(ownerAuth.bestEffortRateLimit({ namespace, ip, limit: 2 }).ok, true);
  assert.equal(ownerAuth.bestEffortRateLimit({ namespace, ip, limit: 2 }).ok, false);
});

await run("constant-time bearer matcher accepts only the correct token", async () => {
  assert.equal(security.safeBearerMatch("secret-token", "Bearer secret-token"), true);
  assert.equal(security.safeBearerMatch("secret-token", "Bearer wrong-token"), false);
  assert.equal(security.safeBearerMatch("secret-token", ""), false);
});

await run("owner routes declare body size limits", async () => {
  for (const relativePath of [
    "pages/api/uc6/challenge.ts",
    "pages/api/uc6/owner/settings.ts",
    "pages/api/uc6/owner/force-rebalance.ts",
    "pages/api/uc6/owner/liquidate-and-pause.ts",
  ]) {
    const source = await readFile(path.join(repoRoot, relativePath), "utf8");
    assert.match(source, /sizeLimit:\s*"64kb"/);
  }
});

await run("bot owner handlers use constant-time bearer matching", async () => {
  const source = await readFile(path.join(repoRoot, "uc6-lp-bot/uc6-bot.mjs"), "utf8");
  assert.match(source, /safeBearerMatch\(ENV\.adminToken,\s*auth\)/);
});

await run("/status path is cache-only and does not trigger live chain refreshes", async () => {
  const source = await readFile(path.join(repoRoot, "uc6-lp-bot/uc6-bot.mjs"), "utf8");
  assert.match(source, /if \(req\.method === "GET" && u\.pathname === "\/status"\) \{[\s\S]*return jsonResponse\(res, 200, this\.statusPayload\(\)\);[\s\S]*\}/);
});

if (failures.length > 0) {
  console.error(`\n${failures.length} security self-tests failed.`);
  process.exit(1);
}

console.log("\nAll security self-tests passed.");
