"use strict";

const MAX_SDP_LENGTH = 65536;
const OPENAI_LIVE_SESSIONS_URL = "https://api.openai.com/v1/live/sessions";

function sendJson(response, status, body) {
  response.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.json(body);
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

module.exports = async function createLiveSession(request, response) {
  response.setHeader("Cache-Control", "no-store");
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return sendJson(response, 405, { error: "طريقة الطلب غير مدعومة." });
  }
  if (!isSameOrigin(request)) {
    return sendJson(response, 403, { error: "رُفض طلب إنشاء المحادثة." });
  }
  if (!process.env.OPENAI_API_KEY) {
    return sendJson(response, 503, { error: "لم يُضبط مفتاح خدمة المحادثة على الخادم بعد." });
  }

  let body = request.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (error) {
      return sendJson(response, 400, { error: "تعذّر قراءة طلب المحادثة." });
    }
  }
  const sdp = body && body.sdp;
  if (typeof sdp !== "string" || !sdp.trim() || sdp.length > MAX_SDP_LENGTH) {
    return sendJson(response, 400, { error: "عرض اتصال الميكروفون غير صالح." });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const upstream = await fetch(OPENAI_LIVE_SESSIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        session: {
          model: "gpt-live-1",
          audio: {
            output: {
              voice: "marin"
            }
          },
          instructions: "أنت بصير، مساعد صوتي هادئ وودود. تحدث بالعربية بأسلوب طبيعي وواضح ومختصر، واتبع لغة المستخدم ولهجته ما أمكن. اسأل للتوضيح عند الحاجة. Backchannel policy: استخدم إشارات استماع قصيرة باعتدال. Interruption policy: توقف عن الكلام عندما يقاطعك المستخدم واستمع إليه. Delegation policy: Backend tools: الاستدلال المتأني والبحث عن المعلومات الحديثة عبر الويب. Generate <|SpawnThinking|> when: يحتاج السؤال إلى استدلال متأنٍ أو معلومات حديثة. Do not generate <|SpawnThinking|> when: يكون السؤال محادثة بسيطة أو تحية أو يمكن الإجابة عنه من سياق الحوار. لا تدّعِ أنك ترى محيط المستخدم؛ الكاميرا في التطبيق ميزة مستقلة. لا تقدّم المساعدة الصوتية بديلًا عن وسائل التنقل الآمنة.",
          delegation: {
            type: "responses",
            responses: {
              model: "gpt-5.6-terra",
              instructions: "أجب بالعربية بوضوح واختصار مناسبين للرد الصوتي. استخدم بحث الويب للأسئلة التي تتطلب معلومات حديثة، وميّز بوضوح بين الحقائق المؤكدة وما هو غير مؤكد.",
              tools: [{ type: "web_search" }],
              tool_choice: "auto"
            }
          }
        },
        transport: {
          type: "webrtc",
          sdp
        }
      }),
      signal: controller.signal
    });
    const result = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      console.error("OpenAI Live session request failed:", upstream.status);
      return sendJson(response, 502, { error: "تعذّر إنشاء جلسة الذكاء الاصطناعي. تحقق من إعداد حساب الخدمة ثم حاول مجددًا." });
    }
    if (!result || typeof result.sdp !== "string" || !result.sdp) {
      console.error("OpenAI Live session returned an invalid SDP answer.");
      return sendJson(response, 502, { error: "وصل رد غير صالح من خدمة المحادثة." });
    }

    return sendJson(response, 201, { sdp: result.sdp });
  } catch (error) {
    const timedOut = error && error.name === "AbortError";
    console.error(timedOut ? "OpenAI Live session request timed out." : "OpenAI Live session request failed.");
    return sendJson(response, timedOut ? 504 : 502, {
      error: timedOut
        ? "استغرق تجهيز المحادثة وقتًا طويلًا. تحقق من الاتصال ثم حاول مرة أخرى."
        : "تعذّر الاتصال بخدمة المحادثة. تحقق من الإنترنت وحاول مرة أخرى."
    });
  } finally {
    clearTimeout(timeout);
  }
};
