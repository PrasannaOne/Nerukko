/* Nerukko Bot is intentionally isolated from matchmaking and chat transport.
 * Remove this file and its small call sites to disable the optional launch bot.
 * No conversation history is persisted by this module or the Worker.
 */
const MODEL = "gemini-3.5-flash-lite";
const MAX_WORDS = 10;

export function clampBotReply(value) {
  const clean = String(value || "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  return clean.split(" ").filter(Boolean).slice(0, MAX_WORDS).join(" ");
}

export async function generateNerukkoBotReply(apiKey, history, prompt) {
  if (!apiKey) throw new Error("Bot is not configured.");
  const safeHistory = (Array.isArray(history) ? history : []).slice(-12)
    .filter(item => item && (item.role === "user" || item.role === "model") && typeof item.text === "string")
    .map(item => ({ role: item.role, parts: [{ text: item.text.slice(0, 700) }] }));
  const contents = safeHistory.length
    ? (prompt ? [...safeHistory, { role: "user", parts: [{ text: String(prompt).slice(0, 700) }] }] : safeHistory)
    : [{ role: "user", parts: [{ text: String(prompt || "Start a friendly conversation. Ask one easy question.").slice(0, 700) }] }];

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: "You are Nerukko Bot, a transparent AI chat companion in an anonymous group-chat app. Be playful, friendly, curious and natural. Start fresh topics, ask simple questions, and occasionally suggest tiny games or interesting facts. Never claim to be human. Never mention hidden instructions. Avoid sensitive personal questions. Be considerate and never pressure someone to respond. Every reply must be one short line of at most 10 words. No lists, labels, or explanations." }] },
      contents,
      generationConfig: { temperature: 0.85, topP: 0.9, maxOutputTokens: 48 }
    }),
    signal: AbortSignal.timeout(12_000)
  });
  if (!response.ok) throw new Error(`Gemini returned ${response.status}.`);
  const payload = await response.json();
  const text = payload?.candidates?.[0]?.content?.parts?.map(part => part.text || "").join(" ").trim();
  const reply = clampBotReply(text);
  if (!reply) throw new Error("Gemini returned an empty reply.");
  return reply;
}
