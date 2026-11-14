import fs from "node:fs";
import path from "node:path";

const root = path.resolve(".");
const html = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
const worker = fs.readFileSync(path.join(root, "src/worker.js"), "utf8");
const serviceWorker = fs.readFileSync(path.join(root, "public/service-worker.js"), "utf8");
const zip = fs.readFileSync(path.join(root, "Stickers/blackcat.zip"));
const workflow = fs.readFileSync(path.join(root, ".github/workflows/deploy.yml"), "utf8");

if (new RegExp("gi" + "phy", "i").test(html)) throw new Error("External sticker provider code remains in the client.");
if (!html.includes("url:'/Stickers/blackcat.zip?v=3'")) throw new Error("Default Black Cat pack URL is missing.");
if (!html.includes('id="stickerButton"') || !html.includes('id="stickerGrid"')) throw new Error("Sticker picker controls are missing.");
if (!html.includes("$('stickerButton').hidden = false;")) throw new Error("Stickers should be visible in group and private chats.");
if (!html.includes("state.mode !== 'private' && !sticker")) throw new Error("Group image uploads must remain blocked while stickers are allowed.");
if (!html.includes('const MAX_MEDIA_BYTES = 2 * 1024 * 1024') || !html.includes('const MEDIA_CHUNK_BYTES = 12 * 1024')) throw new Error('One-to-one P2P media limits and chunking must remain unchanged.');
if (!html.includes("channel.send(JSON.stringify({ type:'media-start'") || !html.includes('channel.send(packet)')) throw new Error('Chat media and text must continue to use peer data channels.');
if (!html.includes("(state.mode === 'private' || (packet.kind === 'sticker' && packet.mime === 'image/webp'))")) throw new Error("Incoming group media must be WebP stickers only.");

// Header and composer regression checks.
if (!html.includes('id="inviteAction"') || !html.includes('aria-label="Invite a friend"') || !html.includes('display: grid !important')) throw new Error("Brave-resilient invite control is missing.");
if (html.includes('id="shareButton"') || html.includes('aria-label="Share Neruko"')) throw new Error("Share-identifying selectors/labels must not be used on the invite control.");
if (!html.includes('border: 0; border-radius: 0; background: transparent')) throw new Error("Header should be unboxed and minimal.");
if (!html.includes('class="composer-field"') || !html.includes('border-radius:50%')) throw new Error("Integrated message field or circular Send button is missing.");
if (!html.includes('id="cameraButton"') || !html.includes('capture="environment"')) throw new Error("Private camera control is missing.");
if (!html.includes("$('cameraButton').hidden = state.mode !== 'private'")) throw new Error("Camera must remain private-chat-only.");
if (!html.includes("$('attachButton').hidden = state.mode !== 'private'")) throw new Error("Image/GIF attachment must remain private-chat-only.");
if (!html.includes('navigator.share') || !html.includes('execCommand')) throw new Error("Share fallback is incomplete.");
if (!html.includes('id="mediaBackdrop"') && !html.includes('id="uploadMedia"')) {
  // Expected: old standalone upload panel is gone; media controls live in the composer.
} else {
  throw new Error("Obsolete separate upload panel should be removed.");
}

// Storage and cache checks protect returning users from stale UI and storage restrictions.
if (!html.includes("function createSafeStorage()") || !html.includes("function createId()")) throw new Error("Safe browser storage/ID fallback is missing.");
if (!html.includes("updateViaCache:'none'")) throw new Error("Service-worker update strategy is missing.");
if (!serviceWorker.includes('neruko-shell') || !serviceWorker.includes('cache: "reload"')) throw new Error("Stable app-shell cache name is missing.");
if (!worker.includes('Cache-Control') || !worker.includes('no-store, no-cache, must-revalidate')) throw new Error("Worker must prevent stale HTML/service-worker responses.");

// About and ownership details.
if (!html.includes("Crafted by Prasanna") || !html.includes("https://t.me/prasannaone")) throw new Error("About creator/Telegram credit is missing.");
if (!html.includes('id="aboutTitle">About</h2>') || !html.includes('>About</button>')) throw new Error("About should use a clean, short label.");
if (!html.includes("Google Gemini") || !html.includes("recent conversation context")) throw new Error("About must disclose Bot processing by Gemini.");
if (!html.includes("function enableSwipeReply(article, target, mine = false)") || !html.includes("const direction = mine ? -1 : 1")) throw new Error("Reply swipes must work in both directions.");
if (!html.includes("reply-swipe-indicator") || !html.includes("↩")) throw new Error("Reply swipe indicator arrow is missing.");
if (!html.includes("max-width:min(112px,32vw)")) throw new Error("Stickers in chat should use the compact display size.");
if (!html.includes('width:min(420px,calc(100% - 24px))') || !html.includes('width:min(58vw,236px,29dvh)')) throw new Error('The sticker creator must use its compact centered layout and aligned crop preview.');
if (!html.includes('.sticker-option-toggle') || !html.includes('id="saveStickerFavourite"')) throw new Error('Sticker creator options must remain neatly aligned.');
if (!html.includes('gap:3px; padding:6px 14px 8px')) throw new Error('Chat message spacing should remain compact.');
if (html.includes('id="stickerOutline"') || html.includes('White outline')) throw new Error('The confusing white-outline toggle should be removed.');
if (!html.includes(".sticker-panel.is-creating") || !html.includes(".sticker-create-scroll") || !html.includes("overflow:hidden")) throw new Error("Sticker creator should fit in a fixed, non-scrollable panel with a fixed action row.");
if (!html.includes("$('stickerPanel').classList.add('is-creating')") || !html.includes("$('stickerPanel').classList.remove('is-creating')")) throw new Error("Sticker creator expanded state must reset on close.");
if (!html.includes("navigator.serviceWorker.register('/service-worker.js?v=15'")) throw new Error("Service worker registration must request V13 explicitly.");

let offset = 0;
let count = 0;
while (offset + 30 <= zip.length && zip.readUInt32LE(offset) === 0x04034b50) {
  const method = zip.readUInt16LE(offset + 8);
  const size = zip.readUInt32LE(offset + 18);
  const nameLength = zip.readUInt16LE(offset + 26);
  const extraLength = zip.readUInt16LE(offset + 28);
  const name = zip.toString("utf8", offset + 30, offset + 30 + nameLength);
  if (method !== 0) throw new Error(`Sticker ZIP entry is compressed: ${name}`);
  if (!name.toLowerCase().endsWith(".webp")) throw new Error(`Unexpected sticker entry: ${name}`);
  offset += 30 + nameLength + extraLength + size;
  count++;
}
if (count !== 40) throw new Error(`Expected 40 individual stickers, found ${count}.`);



if (!html.includes("const STICKER_PACKS = [") || !html.includes("selectedStickerPack = 'blackcat'")) throw new Error("Multi-pack configuration is missing.");
if (!html.includes('data-sticker-tab="recent"') || !html.includes('data-sticker-tab="favorites"') || !html.includes('data-sticker-tab="packs"')) throw new Error("Recent, favourites and packs tabs are required.");
if (!html.includes('id="stickerCreateInput"') || !html.includes('id="stickerCropCanvas"') || !html.includes('id="stickerZoom"')) throw new Error("Lightweight sticker creator controls are missing.");
if (html.includes('id="replaceStickerPhoto"') || html.includes('id="takeStickerPhoto"')) throw new Error('Redundant photo controls should not appear inside the sticker editor.');
if (!html.includes("indexedDB.open('nerukko-local-stickers', 2)")) throw new Error("Custom stickers should persist in local IndexedDB.");
if (!html.includes('id="saveStickerFavourite"')) throw new Error('Sticker creator should keep the save-to-favourites option.');
if (!html.includes('height:min(40dvh,340px)') || !html.includes('grid-template-columns:repeat(4')) throw new Error("Sticker tray should be compact with a four-column grid.");
if (!html.includes('function updateTypingPresence()') || !html.includes("packet.type === 'typing'")) throw new Error("Ephemeral typing indicator is missing.");
if (!html.includes('function appendMessageTime(article)') || !html.includes('message.grouped') || !html.includes('function isNearMessageBottom()')) throw new Error("Message grouping/timestamps/scroll preservation are missing.");
if (!serviceWorker.includes("neruko-shell")) throw new Error("V13 service-worker cache version is missing.");
if (!html.includes("updateViaCache:'none'")) throw new Error("Service-worker updates should bypass HTTP cache.");
if (!html.includes('quota-limited') || !html.includes('memory.set(key, safeValue)')) throw new Error('Storage wrapper must survive runtime quota errors.');
if (/remove\.bg|background.?remov|rembg|bria\.ai/i.test(html)) throw new Error("Sticker creator must not add background-removal services.");

if (!workflow.includes('cp Stickers/*.zip public/Stickers/')) throw new Error('Deployment must publish all future sticker packs.');
if (fs.existsSync(path.join(root, 'public/Stickers/blackcat.zip'))) throw new Error('Do not track a second copy of the sticker pack under public/.');

console.log(`V13 sticker/UI checks passed (${count} WebP assets, ZIP_STORED).`);
