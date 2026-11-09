"use strict";

const MAX_MESSAGES = 10;
const MAX_MESSAGE_LENGTH = 1500;
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent";
const GEMINI_TTS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const SYSTEM_INSTRUCTION = "أنت بصير، مساعد صوتي عربي ودود ومختصر. أجب بلغة المستخدم وبأسلوب واضح ومناسب للنطق. إذا أُرسلت صورة مع آخر رسالة، صف ما يظهر فيها بدقة واذكر الأشياء ومواقعها النسبية، ولا تخمّن التفاصيل غير الواضحة. إذا لم تُرسل صورة، فلا تدّعِ أنك ترى محيط المستخدم واطلب منه تفعيل الكاميرا. لا تقدّم ردك بديلًا عن وسائل التنقل الآمنة.";
const MAX_IMAGE_LENGTH = 1400000;

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
  const image = body && body.image;
  if (image !== undefined) {
    if (typeof image !== "string" || image.length > MAX_IMAGE_LENGTH || !/^[A-Za-z0-9+/]+={0,2}$/.test(image)) {
      return sendJson(response, 400, { error: "صورة الكاميرا غير صالحة." });
    }
    contents[contents.length - 1].parts.push({
      inlineData: { mimeType: "image/jpeg", data: image }
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 50000);
  let text = "";
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

    text = result && result.candidates && result.candidates[0] &&
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

    const speechResponse = await fetch(GEMINI_TTS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY
      },
      body: JSON.stringify({
        model: "gemini-3.8-flash-tts",
        input: [{
          type: "user_input",
          content: [{
            type: "text",
            text,
            annotations: [{
              type: "speech_metadata",
              style: "Speak clearly in Arabic, at a calm, natural pace."
            }]
          }]
        }],
        response_format: { type: "audio" },
        generation_config: { speech_config: [{ voice: "Kore" }] }
      }),
      signal: controller.signal
    });
    const speechResult = await speechResponse.json().catch(() => null);
    if (!speechResponse.ok) {
      console.error("Gemini speech request failed:", speechResponse.status);
      const error = speechResponse.status === 429
        ? "وصلت إلى حد الاستخدام المجاني للصوت. انتظر قليلًا ثم حاول مجددًا."
        : "تعذّر إنشاء الرد الصوتي. حاول مجددًا بعد قليل.";
      return sendJson(response, speechResponse.status === 429 ? 429 : 502, { error, text });
    }

    const audio = speechResult && Array.isArray(speechResult.steps)
      ? speechResult.steps
        .flatMap((step) => Array.isArray(step.content) ? step.content : [])
        .find((part) => part.type === "audio" && typeof part.data === "string")
      : null;
    if (!audio || !audio.data || audio.data.length > 4000000) {
      console.error("Gemini speech response did not contain valid audio.");
      return sendJson(response, 502, { error: "وصل الرد مكتوبًا، لكن تعذّر تجهيز صوته. حاول مجددًا.", text });
    }

    return sendJson(response, 200, {
      text,
      audio: audio.data,
      audioMimeType: typeof audio.mime_type === "string" ? audio.mime_type : "audio/wav"
    });
  } catch (error) {
    const timedOut = error && error.name === "AbortError";
    console.error(timedOut ? "Gemini chat or speech request timed out." : "Gemini chat or speech request failed.");
    return sendJson(response, timedOut ? 504 : 502, {
      error: timedOut
        ? "استغرق تجهيز الرد الصوتي وقتًا طويلًا. تحقق من الاتصال وحاول مرة أخرى."
        : "تعذّر الاتصال بخدمة Gemini. تحقق من الإنترنت وحاول مرة أخرى.",
      ...(text ? { text } : {})
    });
  } finally {
    clearTimeout(timeout);
  }
};
