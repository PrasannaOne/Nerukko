import fs from 'node:fs';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

// ---- GIFs are capped at 2 MB (photos are shrunk on the phone before sending).
assert.match(html, /const MAX_IMAGE_BYTES = 2 \* 1024 \* 1024;/);
assert.match(html, /Keep GIFs under 2 MB\./);
assert.ok(!html.includes('Keep GIFs under 8 MB.'));
assert.match(html, /async function prepareImageForSend/, 'Photo shrinking must stay in place.');

// ---- Relay credential lookups: refreshed regularly, failures never stick.
const start = html.indexOf('  const ICE_CACHE_MS');
const endMarker = '    return request;\n  }\n';
const end = html.indexOf(endMarker, html.indexOf('async function getProviderIceServers')) + endMarker.length;
const block = html.slice(start, end);
assert.ok(block.includes('getIceServers') && block.includes('getProviderIceServers'));
let now = 1_000_000, fetchMode = 'fail', fetchCount = 0;
const realNow = Date.now; Date.now = () => now;
const fakeFetch = async () => {
  fetchCount += 1;
  if (fetchMode === 'fail') return { ok: false, json: async () => ({}) };
  if (fetchMode === 'throw') throw new Error('offline');
  return { ok: true, json: async () => ({ provider: 'turnix', iceServers: [{ urls: 'turn:x', username: 'u', credential: 'c' }] }) };
};
const state = {};
const api = new Function('state', 'fetch', `${block}; return { getIceServers, getProviderIceServers };`)(state, fakeFetch);
try {
  // A failed first lookup must not leave the page on STUN-only forever.
  assert.equal(await api.getIceServers(), null);
  await api.getIceServers(); assert.equal(fetchCount, 1, 'Retries wait a few seconds, not every call.');
  fetchMode = 'ok'; now += 11_000;
  assert.ok(await api.getIceServers(), 'After the retry delay the lookup must recover.');
  assert.equal(state.iceProvider, 'turnix');
  const before = fetchCount;
  await api.getIceServers(); assert.equal(fetchCount, before, 'Good credentials are reused.');
  now += 16 * 60 * 1000; await api.getIceServers();
  assert.equal(fetchCount, before + 1, 'Credentials must be refreshed after 15 minutes.');
  // Same rules for the private-chat providers.
  const pBefore = fetchCount;
  await api.getProviderIceServers('metered'); await api.getProviderIceServers('metered');
  assert.equal(fetchCount, pBefore + 1);
  now += 16 * 60 * 1000; await api.getProviderIceServers('metered');
  assert.equal(fetchCount, pBefore + 2, 'Provider credentials must be refreshed too.');
  fetchMode = 'throw'; now += 16 * 60 * 1000;
  await assert.rejects(api.getProviderIceServers('turnix'));
  fetchMode = 'ok';
  assert.ok(await api.getProviderIceServers('turnix'), 'A failed provider lookup must not be cached.');
} finally { Date.now = realNow; }

// ---- /api/ice only answers this site's own pages.
{
  const env = {};
  const call = headers => worker.fetch(new Request('https://neruko.example/api/ice', { headers: { 'CF-Connecting-IP': '198.51.100.7', ...headers } }), env);
  assert.equal((await call({})).status, 403, 'Bare requests must be refused.');
  assert.equal((await call({ 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await call({ 'Sec-Fetch-Site': 'same-site' })).status, 403);
  assert.equal((await call({ Origin: 'https://evil.example' })).status, 403);
  assert.notEqual((await call({ 'Sec-Fetch-Site': 'same-origin' })).status, 403);
  assert.notEqual((await call({ Referer: 'https://neruko.example/' })).status, 403, 'Older browsers without Sec-Fetch-Site still work.');
}

// ---- Heart button, bot pacing, bot avatar.
const workerSrc = fs.readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
assert.match(html, /<a class="icon-button heart-button" href="https:\/\/prasannaone\.github\.io\/" target="_blank" rel="noopener noreferrer"/);
assert.ok(html.indexOf('heart-button" href') < html.indexOf('id="inviteAction"'), 'The heart must come before the share button.');
assert.match(html, /if \(id\) author\.append\(makeAvatarNode\(id\)\)/, 'The bot must not show an empty avatar.');
assert.match(html, /2000 \+ Math\.random\(\) \* 1000/, 'Bot replies wait 2-3 seconds.');
assert.match(html, /20000 \+ Math\.random\(\) \* 10000/, 'Quiet follow-up comes after 20-30 seconds.');
assert.match(html, /state\.botFollowupSent = true/, 'Only one follow-up per silence.');
assert.match(workerSrc, /botLastNudge/);
assert.match(workerSrc, /BOT_NUDGE_GAP_MS/);
for (const gone of ['Tap the icon to choose a picture from your gallery.', 'STUN-only connections may not work']) assert.ok(!html.includes(gone), `Wordy copy should be gone: ${gone}`);

console.log('Neruko relay-credential refresh, same-site guard and 2 MB GIF cap checks passed.');
