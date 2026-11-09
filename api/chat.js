"use strict";

const MAX_MESSAGES = 10;
const MAX_MESSAGE_LENGTH = 1500;
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent";
const GEMINI_TTS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const SYSTEM_INSTRUCTION = "أنت بصير، رفيق محادثة صوتي عربي ودود وطبيعي. تحدث مع المستخدم كصديق، وافهم سياق كلامكما السابق، وأجب عن موضوعه بدل الاكتفاء بوصف الكاميرا. اسأل سؤال متابعة عند ملاءمته، وتجنب تكرار التحية أو الوصف في كل دور. اجعل الرد واضحًا ومناسبًا للنطق. إذا سأل عما أمامه أو عن صورة الكاميرا، صف الأشياء الظاهرة باختصار ودقة، ولا تخمّن التفاصيل غير الواضحة. لا تقل إنك ترى شيئًا إذا لم تصلك صورة. لا تقدّم ردك بديلًا عن وسائل التنقل الآمنة.";
const MAX_IMAGE_LENGTH = 1400000;
const MAX_AUDIO_LENGTH = 2800000;
const ALLOWED_AUDIO_TYPES = new Set([
  "audio/aac",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm"
]);

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

function parseConversationTurn(value) {
  const text = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end < start) return null;

  try {
    const conversationTurn = JSON.parse(text.slice(start, end + 1));
    return conversationTurn && typeof conversationTurn === "object" && !Array.isArray(conversationTurn)
      ? conversationTurn
      : null;
  } catch (error) {
    return null;
  }
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
  const audioInput = body && body.audio;
  if (audioInput !== undefined) {
    if (!audioInput || typeof audioInput.data !== "string" ||
        audioInput.data.length < 128 ||
        audioInput.data.length > MAX_AUDIO_LENGTH ||
        audioInput.data.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(audioInput.data) ||
        !ALLOWED_AUDIO_TYPES.has(audioInput.mimeType)) {
      return sendJson(response, 400, { error: "التسجيل الصوتي غير صالح." });
    }
    contents[contents.length - 1].parts[0].text =
      "أعد كائن JSON فقط بمفتاحين: heard وهو تفريغ كلام المستخدم في التسجيل الصوتي المرفق بدقة، وreply وهو جواب طبيعي ومناسب لمواصلة حديثكما مع الاستفادة من السياق. إذا سأل عما أمامه، استخدم لقطة الكاميرا المرفقة لوصف الأشياء الظاهرة.";
    contents[contents.length - 1].parts.push({
      inlineData: { mimeType: audioInput.mimeType, data: audioInput.data }
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 50000);
  let text = "";
  let heard = "";
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
        generationConfig: audioInput
          ? {
            maxOutputTokens: 240,
            temperature: 0.6,
            responseMimeType: "application/json",
            responseSchema: {
              type: "OBJECT",
              properties: {
                heard: { type: "STRING" },
                reply: { type: "STRING" }
              },
              required: ["heard", "reply"],
              propertyOrdering: ["heard", "reply"]
            }
          }
          : { maxOutputTokens: 180, temperature: 0.7 }
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
    if (audioInput && text) {
      const conversationTurn = parseConversationTurn(text);
      if (conversationTurn) {
        heard = typeof conversationTurn.heard === "string" ? conversationTurn.heard.trim() : "";
        text = typeof conversationTurn.reply === "string" ? conversationTurn.reply.trim() : "";
      } else {
        console.error("Gemini audio response did not contain a valid conversation object.");
        return sendJson(response, 502, { error: "تعذّر فهم التسجيل الصوتي. تحدث بوضوح وحاول مرة أخرى." });
      }
      if (!heard || !text) {
        console.error("Gemini audio response omitted the transcript or reply.");
        return sendJson(response, 502, { error: "لم أسمع سؤالك بوضوح. أعده بصوت أوضح من فضلك." });
      }
    }
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
              style: "Speak in natural, friendly conversational Arabic. Match the user's dialect when clear. Speak clearly at a calm pace."
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
      return sendJson(response, speechResponse.status === 429 ? 429 : 502, {
        error,
        text,
        ...(audioInput ? { heard } : {})
      });
    }

    const audio = speechResult && Array.isArray(speechResult.steps)
      ? speechResult.steps
        .flatMap((step) => Array.isArray(step.content) ? step.content : [])
        .find((part) => part.type === "audio" && typeof part.data === "string")
      : null;
    if (!audio || !audio.data || audio.data.length > 4000000) {
      console.error("Gemini speech response did not contain valid audio.");
      return sendJson(response, 502, {
        error: "تعذّر تجهيز الصوت المولّد. سيحاول المتصفح نطق الرد.",
        text,
        ...(audioInput ? { heard } : {})
      });
    }

    return sendJson(response, 200, {
      text,
      ...(audioInput ? { heard } : {}),
      audio: audio.data,
      audioMimeType: typeof audio.mime_type === "string" ? audio.mime_type : "audio/wav"
    });
  } catch (error) {
    const timedOut = error && error.name === "AbortError";
    const errorDetail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error(
      timedOut ? "Gemini chat or speech request timed out." : "Gemini chat or speech request failed.",
      errorDetail,
      error && error.cause && error.cause.code
    );
    return sendJson(response, timedOut ? 504 : 502, {
      error: timedOut
        ? "استغرق تجهيز الرد الصوتي وقتًا طويلًا. تحقق من الاتصال وحاول مرة أخرى."
        : "تعذّر الاتصال بخدمة Gemini. تحقق من الإنترنت وحاول مرة أخرى.",
      ...(text ? { text } : {}),
      ...(audioInput && heard ? { heard } : {})
    });
  } finally {
    clearTimeout(timeout);
  }
};
