"use strict";

const LIVE_MODEL = "models/gemini-3.8-live";
const SYSTEM_INSTRUCTION = "أنت بصير، مساعدة صوتية ورفيقة محادثة للمكفوفين. تحدثي دائمًا بالعربية السعودية الطبيعية الواضحة، بتعابير سعودية دارجة من دون تكلف، وبصوت أنثوي هادئ وواضح. أجيبي عن الحديث مباشرة بصوتك، وتابعي سياقه ولا تكتفي بتحويل الكلام إلى نص. تصلك إطارات كاميرا متباعدة قد تكون محجوبة أو غير واضحة ولا تمثل كل ما حول المستخدم. بادري فورًا وباختصار إلى التحذير إذا ظهر بوضوح خطر قريب مثل مركبة متحركة، نار أو دخان، درج، حافة أو عائق؛ انصحيه بالتوقف والتحقق وطلب مساعدة شخص قريب قبل التحرك. إذا سأل عما أمامه أو عن سلامة الطريق، صفي فقط ما يظهر بوضوح، واذكري صراحة ما لا تستطيعين التأكد منه. لا تقولي أبدًا إن الطريق آمن أو خالٍ، ولا تؤكدي أن التحرك آمن؛ عدم ظهور خطر في الصورة لا يعني عدم وجوده. إذا لم تصلك صورة واضحة فقولي إنك لا تستطيعين التأكد، ولا تخمني الأشياء أو المسافات ولا تطلبي منه التحرك اعتمادًا على الكاميرا وحدها. إذا ظهر لهب أو دخان، لا تشجعيه على الطبخ أو الاقتراب؛ حذريه ووجهيه إلى الابتعاد إذا كان ذلك آمنًا وطلب مساعدة بشرية أو طوارئ عند الحاجة. لا تستبدلي العصا أو الكلب المرشد أو وسائل التنقل المساعدة. ابدئي بتحية سعودية قصيرة وودودة، ثم واصلي الحوار بطبيعية.";
const LIVE_CONFIG = {
  generationConfig: { responseModalities: ["AUDIO"] },
  inputAudioTranscription: { languageCodes: ["ar-SA"] },
  outputAudioTranscription: {},
  realtimeInputConfig: {
    automaticActivityDetection: { disabled: false },
    activityHandling: "START_OF_ACTIVITY_INTERRUPTS"
  },
  sessionResumption: {},
  contextWindowCompression: { slidingWindow: {} }
};
const SYSTEM_INSTRUCTION_CONTENT = { parts: [{ text: SYSTEM_INSTRUCTION }] };
const ALLOWED_CROSS_ORIGINS = new Set(["https://aleenabduallah.github.io"]);

function sendJson(response, status, body) {
  response.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  return response.json(body);
}

function getAllowedOrigin(request) {
  const origin = request.headers.origin;
  const host = request.headers["x-forwarded-host"] || request.headers.host;
  const protocol = (request.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  if (!origin || (protocol !== "https" && protocol !== "http")) return null;

  try {
    const parsedOrigin = new URL(origin);
    if (parsedOrigin.protocol !== "https:") return null;
    if (host && parsedOrigin.host === host && parsedOrigin.protocol === `${protocol}:`) return origin;
    return ALLOWED_CROSS_ORIGINS.has(origin) ? origin : null;
  } catch (error) {
    return null;
  }
}

module.exports = async function createLiveToken(request, response) {
  response.setHeader("Cache-Control", "no-store");
  const allowedOrigin = getAllowedOrigin(request);
  if (allowedOrigin) {
    response.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    response.setHeader("Access-Control-Max-Age", "600");
    response.setHeader("Vary", "Origin");
  }
  if (request.method === "OPTIONS") {
    if (!allowedOrigin) return sendJson(response, 403, { error: "رُفض طلب بدء المحادثة." });
    return response.status(204).end();
  }
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return sendJson(response, 405, { error: "طريقة الطلب غير مدعومة." });
  }
  if (!allowedOrigin) {
    return sendJson(response, 403, { error: "رُفض طلب بدء المحادثة." });
  }
  if (!process.env.GEMINI_API_KEY) {
    return sendJson(response, 503, { error: "لم يُضف مفتاح Gemini إلى إعدادات الخادم." });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const upstream = await fetch("https://generativelanguage.googleapis.com/v1beta/auth_tokens", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY
      },
      body: JSON.stringify({
        uses: 1,
        expireTime: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        newSessionExpireTime: new Date(Date.now() + 60 * 1000).toISOString(),
        bidiGenerateContentSetup: {
          model: LIVE_MODEL,
          systemInstruction: SYSTEM_INSTRUCTION_CONTENT,
          generationConfig: { responseModalities: ["AUDIO"] }
        },
        fieldMask: "model,systemInstruction,generationConfig.responseModalities"
      }),
      signal: controller.signal
    });
    const result = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      const providerMessage = result && result.error && typeof result.error.message === "string"
        ? result.error.message.replace(process.env.GEMINI_API_KEY, "[redacted]").slice(0, 400)
        : "";
      console.error("Gemini Live token request failed:", upstream.status, providerMessage);
      return sendJson(response, upstream.status === 429 ? 429 : 502, {
        error: upstream.status === 429
          ? "وصلت خدمة المحادثة الصوتية إلى حد الاستخدام الحالي. حاول لاحقًا."
          : "تعذّر بدء جلسة الصوت المباشر. تحقق من إعدادات Gemini وحاول مجددًا."
      });
    }
    if (!result || typeof result.name !== "string" || !result.name.startsWith("auth_tokens/")) {
      console.error("Gemini Live token response did not contain a valid token.");
      return sendJson(response, 502, { error: "وصل رد غير صالح من خدمة الصوت المباشر." });
    }

    return sendJson(response, 200, {
      token: result.name,
      model: LIVE_MODEL,
      config: LIVE_CONFIG
    });
  } catch (error) {
    const timedOut = error && error.name === "AbortError";
    console.error(
      timedOut ? "Gemini Live token request timed out." : "Gemini Live token request failed.",
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      error && error.cause && error.cause.code
    );
    return sendJson(response, timedOut ? 504 : 502, {
      error: timedOut
        ? "استغرق تجهيز الاتصال الصوتي وقتًا طويلًا. تحقق من الإنترنت وحاول مجددًا."
        : "تعذّر الاتصال بخدمة الصوت المباشر. تحقق من الإنترنت وحاول مجددًا."
    });
  } finally {
    clearTimeout(timeout);
  }
};
