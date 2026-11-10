import fs from 'node:fs';
import assert from 'node:assert/strict';

const html = fs.readFileSync('public/index.html', 'utf8');
const worker = fs.readFileSync('src/worker.js', 'utf8');
const serviceWorker = fs.readFileSync('public/service-worker.js', 'utf8');
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));

assert.equal(packageJson.version, '12.0.0', 'V12 should have a complete 12.0.0 package version');
assert.match(html, /id="openProfile"[^>]*>Profile<\/button>/, 'Overflow menu should contain Profile');
assert.match(html, /id="profileSettingsBackdrop"/, 'Own profile needs its own modal, separate from viewing another user');
assert.match(html, /id="ownProfileAvatar"/, 'Tapping the avatar should open the photo picker');
assert.match(html, /id="profilePhotoInput" type="file" accept="image\/\*"/, 'Profile photo picker should use the device image gallery');
assert.match(html, /id="ownProfileName"/, 'Nickname editing should live in Profile');
assert.doesNotMatch(html, /id="settingsName"|id="saveNameButton"/, 'Nickname editing should be removed from Settings');
assert.match(html, /avatar: 'nerukko_avatar_v1'/, 'Avatar should persist in browser storage');
assert.match(html, /function isValidAvatar\(/, 'Incoming avatar data should be validated');
assert.match(html, /data:image\\\/webp;base64/, 'Only compact WebP data URLs should be accepted');
assert.match(html, /function renderAvatar\(/, 'The app should provide one consistent avatar renderer');
assert.match(html, /createElementNS\('http:\/\/www\.w3\.org\/2000\/svg', 'svg'\)/, 'The default avatar should be a simple native profile icon');
assert.match(html, /type:'profile', name:state\.name, avatar:/, 'Profile should travel over the existing peer channel');
assert.match(html, /packet\.type === 'profile'/, 'Peers should receive profile changes over the data channel');
assert.match(html, /channel\.send\(JSON\.stringify\(\{ type:'profile'/, 'Current profile should be sent when a peer connection opens');
assert.match(html, /article\.prepend\(messageAuthor\(name, peerId/, 'Text messages should show their author/avatar on every message');
assert.match(html, /\.message\.grouped \.message-author \.author-name \{ display:none; \}/, 'Grouped messages may compact the repeated name but must keep the avatar');
assert.match(html, /id="roomBarAvatar"/, 'One-to-one header should include a small peer avatar');
assert.match(html, /renderAvatar\(\$\('roomBarAvatar'\), state\.activePrivate\.avatar\)/, 'One-to-one header should display the other person’s avatar');
assert.match(html, /state\.activePrivate = state\.mode === 'private'[\s\S]{0,180}refreshRoomBar\(\)/, 'Private header should refresh when the conversation starts');
assert.match(html, /packet\.type === 'profile'[\s\S]{0,700}refreshRoomBar\(\)/, 'Private header should refresh when the profile changes');
assert.match(html, /makeAvatar\(person\.id, 'room-member-avatar'\)/, 'Room member chips should also show small profile photos');
assert.match(html, /renderAvatar\(\$\('profileAvatar'\), person\.avatar\)/, 'Other user profile should display their photo');
assert.match(html, /renderAvatar\(\$\('privateAvatar'\), state\.activePrivate\.avatar\)/, 'Private conversation drawer should show their avatar');
assert.match(html, /id="roomSettingsButton"[\s\S]*?<circle cx="12" cy="12" r="3"/, 'Room settings should use a conventional gear-style control');
assert.match(html, /service-worker\.js\?v=12/, 'The HTML should request V12 service worker');
assert.match(serviceWorker, /nerukko-shell-v12/, 'V12 should have a fresh offline cache');
assert.doesNotMatch(worker, /avatar|profile-photo|data:image/i, 'Profile images must not be uploaded to or stored by the Worker');

// Make sure the profile modal and the key controls are present exactly once.
for (const id of ['openProfile', 'profileSettingsBackdrop', 'ownProfileAvatar', 'profilePhotoInput', 'ownProfileName', 'saveOwnProfileButton', 'roomBarAvatar']) {
  const hits = html.match(new RegExp(`id="${id}"`, 'g')) || [];
  assert.equal(hits.length, 1, `Expected one #${id} element, found ${hits.length}`);
}

console.log('Nerukko V12 profile checks passed.');
