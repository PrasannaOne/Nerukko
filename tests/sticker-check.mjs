import fs from "node:fs";
import path from "node:path";

const root = path.resolve(".");
const html = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
const zip = fs.readFileSync(path.join(root, "Stickers/blackcat.zip"));
if (new RegExp("gi" + "phy", "i").test(html)) throw new Error("External sticker provider code remains in the client.");
if (!html.includes("STICKER_ZIP_URL = '/Stickers/blackcat.zip?v=1'")) throw new Error("Sticker pack URL is missing.");
if (!html.includes('id="stickerButton"') || !html.includes('id="stickerGrid"')) throw new Error("Sticker picker controls are missing.");
if (!html.includes('<span>Share</span>') || !html.includes('id="shareButton"')) throw new Error("Visible Share control is missing.");
if (!html.includes("$('stickerButton').hidden = false;")) throw new Error("Stickers should be visible in group and private chats.");
if (!html.includes("state.mode !== 'private' && !sticker")) throw new Error("Group image uploads must remain blocked while stickers are allowed.");
if (!html.includes("(state.mode === 'private' || (packet.kind === 'sticker' && packet.mime === 'image/webp'))")) throw new Error("Incoming group media must be WebP stickers only.");
if (!html.includes("Crafted by Prasanna ❤️") || !html.includes("https://t.me/prasannaone")) throw new Error("About creator/Telegram credit is missing.");

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
console.log(`Sticker checks passed (${count} WebP files, ZIP_STORED).`);
