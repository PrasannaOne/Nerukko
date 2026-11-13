
import fs from 'node:fs';
import assert from 'node:assert/strict';
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const pkg=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8'));
assert.equal(pkg.version,'14.1.0');
assert.match(html,/nerukko_friends_v1/);
assert.match(html,/nerukko_dm_history_v1/);
assert.match(html,/slice\(-100\)/);
assert.match(html,/function restorePrivateHistory/);
assert.match(html,/requestAnimationFrame\(\(\)=>editor\.focus/);
assert.match(html,/\.message\.mine \{ align-self:flex-end/);
assert.doesNotMatch(html,/whiteOutline|stickerOutline|White outline/i);
console.log('Nerukko V13 chat, friend persistence, history and sticker checks passed.');
