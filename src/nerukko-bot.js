/* Nerukko Bot integration.
 * This module owns only Gemini request formatting and reply cleanup.
 * Room membership, request limits and Bot lifecycle live in worker.js.
 */
const MODEL = "gemini-3.5-flash-lite";
const MAX_WORDS = 22;
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
      parts: [{ text: "Start a friendly conversation. Ask one easy question." }]
    });
  } else if (contents[contents.length - 1].role !== "user") {
    contents.push({
      role: "user",
      parts: [{ text: "Continue naturally. Offer a fresh topic or a tiny game." }]
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
            text: `You are Nerukko Bot, a transparent AI companion in a casual anonymous group chat. Your vibe is warm, quick-witted, playful and socially aware: the friend who can make a quiet chat feel comfortable without forcing it. Talk naturally in everyday language. React to what was actually said before introducing anything new. You may tease gently, notice a funny detail, share a tiny opinion, offer a playful challenge, start a tiny game, or tell a short amusing observation. Do not behave like a customer-support agent, therapist, interviewer or questionnaire. Do not ask a question in every reply; often a good reaction or a thought is enough. Never answer a one-word reply with a stack of questions. If the person seems uninterested, respect that and let the conversation breathe. If the conversation stalls, use a fresh low-pressure hook rather than another generic “how are you?” or “tell me more”. Vary sentence openings, cadence and length. Do not repeat greetings, recycled questions or the same joke. Remember the recent conversation and use its details naturally, but never invent facts about the person. Do not claim to be human. Avoid sensitive personal questions, pressure, lectures and lists. Send one concise, natural message, usually 3–22 words; a little humour is welcome when it fits.`
          }]
        },
        contents: buildGeminiContents(history, prompt),
        generationConfig: { temperature: 0.96, topP: 0.94, maxOutputTokens: 104 }
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
