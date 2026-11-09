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
if (!html.includes("(state.mode === 'private' || (packet.kind === 'sticker' && packet.mime === 'image/webp'))")) throw new Error("Incoming group media must be WebP stickers only.");

// Header and composer regression checks.
if (!html.includes('id="shareButton"') || !html.includes('display: grid !important')) throw new Error("Always-visible Share control is missing.");
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
if (!serviceWorker.includes('nerukko-shell-v8') || !serviceWorker.includes('cache: "reload"')) throw new Error("Fresh app-shell cache version is missing.");
if (!worker.includes('Cache-Control') || !worker.includes('no-store, no-cache, must-revalidate')) throw new Error("Worker must prevent stale HTML/service-worker responses.");

// About and ownership details.
if (!html.includes("Crafted by Prasanna") || !html.includes("https://t.me/prasannaone")) throw new Error("About creator/Telegram credit is missing.");
if (!html.includes("optional white outline") || !html.includes("saving it locally")) throw new Error("About must explain on-device sticker creation.");
if (!html.includes("Google Gemini") || !html.includes("recent chat context")) throw new Error("About must disclose Bot processing by Gemini.");

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
if (!html.includes("indexedDB.open('nerukko-local-stickers', 1)")) throw new Error("Custom stickers should persist in local IndexedDB.");
if (!html.includes('id="saveStickerFavourite"') || !html.includes('id="stickerOutline"')) throw new Error('Sticker creator should save to favourites and support a white outline.');
if (!html.includes('height:min(40dvh,340px)') || !html.includes('grid-template-columns:repeat(4')) throw new Error("Sticker tray should be compact with a four-column grid.");
if (!html.includes('function updateTypingPresence()') || !html.includes("packet.type === 'typing'")) throw new Error("Ephemeral typing indicator is missing.");
if (!html.includes('function appendMessageTime(article)') || !html.includes('message.grouped') || !html.includes('function isNearMessageBottom()')) throw new Error("Message grouping/timestamps/scroll preservation are missing.");
if (!serviceWorker.includes("nerukko-shell-v8")) throw new Error("V8 service-worker cache version is missing.");
if (!html.includes("updateViaCache:'none'")) throw new Error("Service-worker updates should bypass HTTP cache.");
if (!html.includes('quota-limited') || !html.includes('memory.set(key, safeValue)')) throw new Error('Storage wrapper must survive runtime quota errors.');
if (/remove\.bg|background.?remov|rembg|bria\.ai/i.test(html)) throw new Error("Sticker creator must not add background-removal services.");

if (!workflow.includes('cp Stickers/*.zip public/Stickers/')) throw new Error('Deployment must publish all future sticker packs.');

console.log(`V8 sticker/UI checks passed (${count} WebP assets, ZIP_STORED).`);
