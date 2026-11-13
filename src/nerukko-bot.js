/* Nerukko Bot integration.
 * This module owns only Gemini request formatting and reply cleanup.
 * Room membership, request limits and Bot lifecycle live in worker.js.
 */
const MODEL = "gemini-3.5-flash-lite";
const MAX_WORDS = 10;
// Words that sound unfinished when a reply is cut off right after them.
const DANGLING = new Set(["a","an","the","and","but","or","so","to","of","in","on","at","with","for","that","if","because","my","your","is","are","was","i","as","than","then"]);
const MAX_HISTORY_ITEMS = 12;
const MAX_TEXT_LENGTH = 700;

export function clampBotReply(value) {
  const clean = String(value || "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  const words = clean.split(" ").filter(Boolean);
  if (words.length <= MAX_WORDS) return words.join(" ");
  // Too long: prefer ending on a finished sentence, otherwise cut cleanly without a dangling word.
  const head = words.slice(0, MAX_WORDS);
  let lastStop = -1;
  head.forEach((word, index) => { if (/[.!?]["')\]]*$/.test(word)) lastStop = index; });
  if (lastStop >= 1) return head.slice(0, lastStop + 1).join(" ");
  while (head.length > 2 && DANGLING.has(head[head.length - 1].toLowerCase().replace(/[^a-z]/g, ""))) head.pop();
  return head.join(" ").replace(/[,;:\-–—]+$/, "");
}

/**
 * Build a valid Gemini conversation.
 * The launch greeting is generated without history, so browser history can
 * begin with a model turn. Gemini conversations must begin with a user turn.
 * Drop leading model messages and merge accidental consecutive roles.
 */
export function buildGeminiContents(history, prompt = "") {
  const items = (Array.isArray(history) ? history : []).slice(-MAX_HISTORY_ITEMS);
  const contents = [];

  for (const item of items) {
    if (!item || (item.role !== "user" && item.role !== "model") || typeof item.text !== "string") continue;
    const text = item.text.replace(/[\r\n]+/g, " ").trim().slice(0, MAX_TEXT_LENGTH);
    if (!text) continue;
    if (!contents.length && item.role === "model") continue;

    const previous = contents[contents.length - 1];
    if (previous && previous.role === item.role) {
      previous.parts[0].text = `${previous.parts[0].text} ${text}`.slice(0, MAX_TEXT_LENGTH);
    } else {
      contents.push({ role: item.role, parts: [{ text }] });
    }
  }

  const nextPrompt = String(prompt || "").replace(/[\r\n]+/g, " ").trim().slice(0, MAX_TEXT_LENGTH);
  if (nextPrompt) {
    const previous = contents[contents.length - 1];
    if (previous?.role === "user") {
      previous.parts[0].text = `${previous.parts[0].text} ${nextPrompt}`.slice(0, MAX_TEXT_LENGTH);
    } else {
      contents.push({ role: "user", parts: [{ text: nextPrompt }] });
    }
  }

  if (!contents.length) {
    contents.push({
      role: "user",
      parts: [{ text: "Say a short, casual hello." }]
    });
  } else if (contents[contents.length - 1].role !== "user") {
    contents.push({
      role: "user",
      parts: [{ text: "React briefly and naturally." }]
    });
  }

  return contents;
}

export async function generateNerukkoBotReply(apiKey, history, prompt) {
  if (!apiKey) throw new Error("Bot is not configured.");

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{
            text: `You are Nerukko Bot, an AI participant in a friendly anonymous chat. Be warm, kind and upbeat, like a welcoming friend who is genuinely glad someone showed up. Keep every reply short: usually 4–8 words, never more than 10. One complete, friendly sentence only. No paragraphs, explanations, lists, or customer-support language. React to what the person actually said, show real interest, and match their energy. If they seem down, be gentle and encouraging. Occasionally add light humor or one small emoji, never more. Ask a simple question only now and then, never stacked. Avoid generic openers, repeated greetings, and scripted icebreakers. If the person sends a sticker, react to the gesture without guessing its image. If someone mentions hurting themselves, say you care and suggest talking to someone they trust. If someone is rude, stay calm and kind. Never claim to be human; if asked, say you're a friendly AI bot.`
          }]
        },
        contents: buildGeminiContents(history, prompt),
        generationConfig: { temperature: 0.9, topP: 0.94, maxOutputTokens: 48 }
      }),
      signal: AbortSignal.timeout(12_000)
    }
  );

  if (!response.ok) throw new Error(`Gemini returned ${response.status}.`);
  const payload = await response.json();
  const generated = payload?.candidates?.[0]?.content?.parts
    ?.map(part => part.text || "")
    .join(" ")
    .trim();
  const reply = clampBotReply(generated);
  if (!reply) throw new Error("Gemini returned an empty reply.");
  return reply;
}
