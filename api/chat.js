"use strict";

const MAX_MESSAGES = 10;
const MAX_MESSAGE_LENGTH = 1500;
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent";
const SYSTEM_INSTRUCTION = "أنت بصير، مساعد صوتي عربي ودود ومختصر. أجب بلغة المستخدم وبأسلوب واضح ومناسب للنطق. لا تدّعِ أنك ترى محيط المستخدم أو الكاميرا؛ إن سأل عما أمامه، وضّح أن وصف الكاميرا ميزة منفصلة. لا تقدّم ردك بديلًا عن وسائل التنقل الآمنة.";

function sendJson(response, status, body) {
  response.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  return response.json(body);
}

function isSameOrigin(request) {
  const origin = request.headers.origin;
  const host = request.headers["x-forwarded-host"] || request.headers.host;
  const protocol = (request.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  if (!origin || !host || (protocol !== "https" && protocol !== "http")) return false;

  try {
    const parsedOrigin = new URL(origin);
    return parsedOrigin.host === host && parsedOrigin.protocol === `${protocol}:`;
  } catch (error) {
    return false;
  }
}

function parseMessages(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MESSAGES) return null;

  const messages = [];
  for (const message of value) {
    if (!message || (message.role !== "user" && message.role !== "model")) return null;
    if (typeof message.text !== "string" || !message.text.trim() || message.text.length > MAX_MESSAGE_LENGTH) return null;
    messages.push({
      role: message.role,
      parts: [{ text: message.text.trim() }]
    });
  }
  if (messages[messages.length - 1].role !== "user") return null;
  return messages;
}

module.exports = async function generateChatReply(request, response) {
  response.setHeader("Cache-Control", "no-store");
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return sendJson(response, 405, { error: "طريقة الطلب غير مدعومة." });
  }
  if (!isSameOrigin(request)) {
    return sendJson(response, 403, { error: "رُفض طلب المحادثة." });
  }
  if (!process.env.GEMINI_API_KEY) {
    return sendJson(response, 503, { error: "لم يُضف مفتاح Gemini إلى الخادم." });
  }

  let body = request.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (error) {
      return sendJson(response, 400, { error: "تعذّرت قراءة رسالة المحادثة." });
    }
  }
  const contents = parseMessages(body && body.messages);
  if (!contents) {
    return sendJson(response, 400, { error: "رسالة المحادثة غير صالحة." });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const upstream = await fetch(GEMINI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        contents,
        generationConfig: { maxOutputTokens: 180, temperature: 0.6 }
      }),
      signal: controller.signal
    });
    const result = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      console.error("Gemini chat request failed:", upstream.status);
      const message = upstream.status === 429
        ? "انتهت الحصة المجانية مؤقتًا. انتظر حتى تتجدد ثم حاول مرة أخرى."
        : "تعذّر إنشاء رد من Gemini. تحقق من مفتاح الخدمة وحاول مجددًا.";
      return sendJson(response, upstream.status === 429 ? 429 : 502, { error: message });
    }

    const text = result && result.candidates && result.candidates[0] &&
      result.candidates[0].content && Array.isArray(result.candidates[0].content.parts)
      ? result.candidates[0].content.parts
        .map((part) => typeof part.text === "string" ? part.text : "")
        .join("")
        .trim()
      : "";
    if (!text) {
      console.error("Gemini chat returned no text candidate.");
      return sendJson(response, 502, { error: "وصل رد فارغ من Gemini. أعد صياغة السؤال وحاول مرة أخرى." });
    }

    return sendJson(response, 200, { text });
  } catch (error) {
    const timedOut = error && error.name === "AbortError";
    console.error(timedOut ? "Gemini chat request timed out." : "Gemini chat request failed.");
    return sendJson(response, timedOut ? 504 : 502, {
      error: timedOut
        ? "استغرق تجهيز الرد وقتًا طويلًا. تحقق من الاتصال وحاول مرة أخرى."
        : "تعذّر الاتصال بخدمة Gemini. تحقق من الإنترنت وحاول مرة أخرى."
    });
  } finally {
    clearTimeout(timeout);
  }
};
