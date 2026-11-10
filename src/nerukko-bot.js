/* Nerukko Bot integration.
 * This module owns only Gemini request formatting and reply cleanup.
 * Room membership, request limits and Bot lifecycle live in worker.js.
 */
const MODEL = "gemini-3.5-flash-lite";
const MAX_WORDS = 10;
const MAX_HISTORY_ITEMS = 12;
const MAX_TEXT_LENGTH = 700;

export function clampBotReply(value) {
  const clean = String(value || "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  return clean.split(" ").filter(Boolean).slice(0, MAX_WORDS).join(" ");
}

/**
 * Build a valid Gemini conversation.
 * The Bot only responds to a real user message or sticker. Gemini
 * conversations must begin with a user turn.
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
      parts: [{ text: "The person sent a sticker. React briefly and naturally." }]
    });
  } else if (contents[contents.length - 1].role !== "user") {
    contents.push({
      role: "user",
      parts: [{ text: "Respond briefly to the latest message." }]
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
            text: `You are Nerukko Bot, a transparent AI companion in a casual anonymous group chat. Sound like a relaxed, socially aware person: warm, quick-witted, playful and natural, never like a scripted chatbot. Reply to what the person actually said, using details from the recent conversation without inventing facts. Keep every reply very short: usually 2–8 words, and never more than 10 words. One compact line only, no paragraphs, lists or explanations. Do not greet again after the conversation has started. Do not ask a question in every reply; often a reaction, opinion or playful observation is better. Avoid generic follow-up questions, repetitive sentence openings, canned internet jokes and customer-support language. Respect silence or low interest instead of forcing the conversation. Do not claim to be human. Keep the tone easy, human-like and occasionally funny when it fits.`
          }]
        },
        contents: buildGeminiContents(history, prompt),
        generationConfig: { temperature: 0.96, topP: 0.94, maxOutputTokens: 48 }
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
