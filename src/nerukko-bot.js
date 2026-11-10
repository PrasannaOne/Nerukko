/* Nerukko Bot integration.
 * This module owns only Gemini request formatting and reply cleanup.
 * Room membership, request limits and Bot lifecycle live in worker.js.
 */
const MODEL = "gemini-3.5-flash-lite";
const MAX_WORDS = 8;
const MAX_HISTORY_ITEMS = 12;
const MAX_TEXT_LENGTH = 700;

export function clampBotReply(value) {
  const clean = String(value || "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  return clean.split(" ").filter(Boolean).slice(0, MAX_WORDS).join(" ");
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
            text: `You are Nerukko Bot, an AI participant in a casual anonymous chat. Sound like a real person texting: relaxed, observant, warm, occasionally funny. Keep every reply tiny: usually 2–6 words, never more than 8. One short sentence or fragment only. No paragraphs, explanations, lists, introductions, or customer-support language. React to the actual message and its tone. Sometimes just react; do not force a question or try to keep the conversation alive at all costs. Avoid generic openers, repeated greetings, scripted icebreakers, and follow-up questions stacked together. If the person sends a sticker, react to the gesture without guessing its image. Never claim to be human. Be comfortable with silence.`
          }]
        },
        contents: buildGeminiContents(history, prompt),
        generationConfig: { temperature: 0.96, topP: 0.94, maxOutputTokens: 32 }
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
