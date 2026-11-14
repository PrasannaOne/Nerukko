import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const worker = await readFile(new URL("../src/worker.js", import.meta.url), "utf8");
const page = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const workflow = await readFile(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");
assert.match(worker, /\/api\/ice/);
assert.match(worker, /turnix\.io\/api\/v1\/credentials\/ice/);
assert.match(worker, /metered\.live\/api\/v1\/turn\/credentials/);
assert.match(worker, /ICE_REQUEST_LIMIT = 60/);
assert.match(page, /fetch\('\/api\/ice'/);
assert.match(page, /iceTransportPolicy: 'all'/);
assert.match(page, /async function fallbackGroupPeer/);
assert.match(page, /getProviderIceServers\('metered'\)/);
assert.match(page, /iceProvider: 'metered'/);
assert.match(page, /providerIceCache = new Map/);
assert.match(page, /state\.peerIceProviders\.clear\(\)/);
assert.match(worker, /const servers = await turnix\(\)/);
assert.match(worker, /const servers = await metered\(\)/);
assert.doesNotMatch(worker, /Promise\.allSettled\(\[turnix\(\), metered\(\)\]\)/);
for (const workflowFile of ["../.github/workflows/deploy.yml", "../.github/workflows/deploy-from-zip.yml"]) {
  const workflowText = await readFile(new URL(workflowFile, import.meta.url), "utf8");
  for (const secret of ["TURNIX_API_TOKEN", "METERED_APP_NAME", "METERED_TURN_API_KEY"]) assert.ok(workflowText.includes(secret), `Missing workflow secret ${secret} in ${workflowFile}`);
}
console.log("ICE/TURN configuration checks passed.");
