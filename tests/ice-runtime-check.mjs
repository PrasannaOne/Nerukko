import assert from 'node:assert/strict';
import worker from '../src/worker.js';

const originalFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = async (url, options = {}) => {
  calls.push({ url: String(url), options });
  if (String(url).startsWith('https://turnix.io/')) {
    return new Response(JSON.stringify({ iceServers: [
      { urls: ['stun:stun.turnix.io:3478'] },
      { urls: ['turn:in.turnix.io:3478?transport=udp'], username: 'turnix-user', credential: 'turnix-pass' }
    ] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (String(url).includes('.metered.live/')) {
    return new Response(JSON.stringify([
      { urls: 'stun:metered.example:80' },
      { urls: 'turn:metered.example:443?transport=tcp', username: 'metered-user', credential: 'metered-pass' }
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  throw new Error('Unexpected external request');
};

try {
  const env = {
    TURNIX_API_TOKEN: 'test-turnix-token',
    METERED_APP_NAME: 'test-app',
    METERED_TURN_API_KEY: 'test-metered-key'
  };
  const request = () => new Request('https://neruko.example/api/ice', {
    headers: { 'CF-Connecting-IP': '192.0.2.10', 'Sec-Fetch-Site': 'same-origin' }
  });
  const response = await worker.fetch(request(), env);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.providers, { turnix: true, metered: false });
  assert.equal(data.provider, 'turnix');
  assert.ok(data.iceServers.some(server => String(server.urls).includes('turn:in.turnix.io')));
  assert.ok(!data.iceServers.some(server => String(server.urls).includes('turn:metered.example')));
  assert.equal(calls.length, 1, 'Metered must not be queried while Turnix succeeds');
  assert.equal(calls.length, 1);
  assert.match(calls[0].options.headers.Authorization, /^Bearer /);
  assert.deepEqual(JSON.parse(calls[0].options.body), { ttl: 3600, preferred_region: 'india' });
  assert.ok(!JSON.stringify(data).includes('test-turnix-token'));

  for (let i = 0; i < 59; i += 1) assert.equal((await worker.fetch(request(), env)).status, 200);
  assert.equal((await worker.fetch(request(), env)).status, 429);

  // A failed primary provider must leave the Metered secondary available.
  globalThis.fetch = async url => {
    if (String(url).startsWith('https://turnix.io/')) return new Response('unavailable', { status: 503 });
    if (String(url).includes('.metered.live/')) return new Response(JSON.stringify([
      { urls: 'turn:metered.example:443?transport=tcp', username: 'metered-user', credential: 'metered-pass' }
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    throw new Error('Unexpected external request');
  };
  const fallbackResponse = await worker.fetch(new Request('https://neruko.example/api/ice', { headers: { 'CF-Connecting-IP': '192.0.2.11', 'Sec-Fetch-Site': 'same-origin' } }), env);
  const fallbackData = await fallbackResponse.json();
  assert.deepEqual(fallbackData.providers, { turnix: false, metered: true });
  assert.equal(fallbackData.provider, 'metered');
  assert.ok(fallbackData.iceServers.some(server => String(server.urls).includes('turn:metered.example')));
  console.log('ICE endpoint runtime, provider fallback payload, secret isolation and rate-limit checks passed.');
} finally {
  globalThis.fetch = originalFetch;
}
