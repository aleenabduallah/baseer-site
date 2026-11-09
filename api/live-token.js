"use strict";

const LIVE_MODEL = "models/gemini-3.8-live";
const SYSTEM_INSTRUCTION = "أنت بصير، مساعد صوتي عربي ودود يتحدث مع المستخدم بشكل طبيعي ومستمر باللهجة السعودية متى كان ذلك مناسبًا. افهم كلامه وأجب عنه مباشرة بصوت عربي واضح، وتابع سياق الحديث ولا تكتفِ بتحويل كلامه إلى نص. تستطيع رؤية إطارات الكاميرا التي تصلك أثناء المحادثة؛ لا تصف ما فيها إلا إذا سأل المستخدم عما أمامه أو طلب وصفًا بصريًا. عند الوصف، كن موجزًا ودقيقًا ولا تخمّن التفاصيل أو المسافات، ونبّه إلى المخاطر الواضحة دون أن تستبدل وسائل التنقل الآمنة. ابدأ بتحية عربية قصيرة وودودة، ثم واصل الحوار بطبيعية.";
const LIVE_CONFIG = {
  responseModalities: ["AUDIO"],
  systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
  inputAudioTranscription: { languageCodes: ["ar-SA"] },
  outputAudioTranscription: {},
  realtimeInputConfig: {
    automaticActivityDetection: { disabled: false },
    activityHandling: "START_OF_ACTIVITY_INTERRUPTS"
  },
  sessionResumption: {},
  contextWindowCompression: { slidingWindow: {} }
};
const LIVE_CONSTRAINED_CONFIG = {
  responseModalities: LIVE_CONFIG.responseModalities,
  systemInstruction: LIVE_CONFIG.systemInstruction
};

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

module.exports = async function createLiveToken(request, response) {
  response.setHeader("Cache-Control", "no-store");
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return sendJson(response, 405, { error: "طريقة الطلب غير مدعومة." });
  }
  if (!isSameOrigin(request)) {
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
        liveConnectConstraints: {
          model: LIVE_MODEL,
          config: LIVE_CONSTRAINED_CONFIG
        }
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
          : "تعذّر بدء جلسة الصوت المباشر. تحقق من إعدادات Gemini وحاول مجددًا.",
        diagnostic: {
          upstreamStatus: upstream.status,
          message: providerMessage
        }
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
