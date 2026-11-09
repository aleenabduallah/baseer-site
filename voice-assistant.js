(() => {
"use strict";

const status = document.getElementById("voice-chat-status");
const transcript = document.getElementById("voice-chat-transcript");
const BrowserSpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const MAX_HISTORY = 8;

let recognition = null;
let state = "idle";
let messages = [];
let requestController = null;
let restartTimer = null;
let attempt = 0;
let resumeAfterVisibility = false;
let retryOnInteraction = false;

function updateState(nextState, message) {
  state = nextState;
  status.textContent = message;
}

function releaseRecognition() {
  if (restartTimer) {
    window.clearTimeout(restartTimer);
    restartTimer = null;
  }
  if (recognition) {
    const currentRecognition = recognition;
    recognition = null;
    currentRecognition.onresult = null;
    currentRecognition.onend = null;
    currentRecognition.onerror = null;
    try {
      currentRecognition.stop();
    } catch (error) {
      if (error.name !== "InvalidStateError") {
        console.error("Unable to stop browser speech recognition:", error);
      }
    }
  }
}

function stopConversation(message = "انتهت المحادثة الصوتية.") {
  attempt += 1;
  if (requestController) {
    requestController.abort();
    requestController = null;
  }
  releaseRecognition();
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  updateState("idle", message);
  window.dispatchEvent(new Event("baseer:conversation-stop"));
}

function scheduleListening(delay = 450) {
  if (state !== "listening" || document.hidden || restartTimer) return;
  restartTimer = window.setTimeout(() => {
    restartTimer = null;
    if (state !== "listening" || document.hidden || !recognition) return;
    try {
      recognition.start();
    } catch (error) {
      if (error.name === "InvalidStateError") {
        scheduleListening(500);
        return;
      }
      console.error("Unable to start browser speech recognition:", error);
      stopConversation("تعذّر تشغيل الاستماع الصوتي. المس الشاشة وحاول مرة أخرى.");
      retryOnInteraction = true;
    }
  }, delay);
}

function speakReply(userText, reply, currentAttempt) {
  if (currentAttempt !== attempt) return;
  transcript.textContent = `أنت: ${userText}\nبصير: ${reply}`;

  if (!("speechSynthesis" in window)) {
    updateState("idle", "ظهر الرد كتابةً، لكن هذا المتصفح لا يدعم النطق الصوتي.");
    window.dispatchEvent(new Event("baseer:conversation-stop"));
    retryOnInteraction = true;
    return;
  }

  updateState("speaking", "بصير يرد عليك...");
  const utterance = new SpeechSynthesisUtterance(reply);
  utterance.lang = "ar-SA";
  utterance.rate = 0.96;
  utterance.onend = () => {
    if (currentAttempt !== attempt || state !== "speaking") return;
    updateState("listening", "تحدث بعد سماع الرد؛ قد يتوقف عند نفاد الحصة المجانية.");
    scheduleListening();
  };
  utterance.onerror = (error) => {
    if (currentAttempt !== attempt || state !== "speaking") return;
    console.error("Unable to speak Gemini response:", error.error);
    updateState("listening", "تعذّر نطق الرد. يمكنك قراءة النص ثم متابعة الحديث.");
    scheduleListening();
  };
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

async function sendMessage(text) {
  const currentAttempt = attempt;
  const trimmedText = text.trim();
  if (!trimmedText || state !== "listening") return;

  if (recognition) recognition.stop();
  updateState("thinking", "وصل كلامك؛ بصير يجهّز الرد...");
  transcript.textContent = `أنت: ${trimmedText}`;
  requestController = new AbortController();

  try {
    const response = await fetch(new URL("./api/chat", document.baseURI), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ messages: [...messages, { role: "user", text: trimmedText }].slice(-MAX_HISTORY) }),
      signal: requestController.signal
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(result.error || "تعذّر الحصول على رد من Gemini. حاول مرة أخرى.");
      error.status = response.status;
      throw error;
    }
    if (currentAttempt !== attempt) return;

    const reply = typeof result.text === "string" ? result.text.trim() : "";
    if (!reply) throw new Error("لم يصل رد نصي من Gemini. حاول مرة أخرى.");
    messages = [...messages, { role: "user", text: trimmedText }, { role: "model", text: reply }].slice(-MAX_HISTORY);
    speakReply(trimmedText, reply, currentAttempt);
  } catch (error) {
    if (currentAttempt !== attempt || (error && error.name === "AbortError")) return;
    console.error("Unable to get a Gemini response:", error);
    if (error && (error.status === 429 || error.status === 503)) {
      stopConversation(error.message);
      retryOnInteraction = true;
      return;
    }
    updateState("listening", error && error.message ? error.message : "تعذّر الحصول على رد. حاول مرة أخرى.");
    scheduleListening(1400);
  } finally {
    if (currentAttempt === attempt) requestController = null;
  }
}

function createRecognition() {
  recognition = new BrowserSpeechRecognition();
  recognition.lang = "ar-SA";
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  recognition.onstart = () => {
    if (state === "listening") status.textContent = "تحدث الآن؛ سيجيب بصير بعد انتهاء كلامك.";
  };
  recognition.onresult = (event) => {
    if (state !== "listening") return;
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      if (result.isFinal && result[0].transcript.trim()) {
        void sendMessage(result[0].transcript);
        return;
      }
    }
  };
  recognition.onerror = (event) => {
    if (state !== "listening") return;
    if (event.error === "no-speech" || event.error === "aborted") return;
    const message = event.error === "not-allowed" || event.error === "service-not-allowed"
      ? "اسمح باستخدام الميكروفون وخدمة التعرّف على الكلام من إعدادات المتصفح."
      : event.error === "language-not-supported"
        ? "التعرّف على العربية غير مدعوم في هذا المتصفح. جرّب Chrome أو Edge."
        : event.error === "audio-capture"
          ? "لم يتم العثور على ميكروفون متصل."
          : "تعذّر التعرّف على كلامك. تحقق من الإنترنت وحاول مرة أخرى.";
    console.error("Browser speech recognition failed:", event.error);
    stopConversation(message);
    retryOnInteraction = true;
  };
  recognition.onend = () => {
    if (state === "listening" && !document.hidden) scheduleListening();
  };
}

function startConversation() {
  if (state !== "idle") return;
  if (!BrowserSpeechRecognition) {
    updateState("idle", "المحادثة الصوتية تحتاج Chrome أو Edge يدعم التعرّف على العربية.");
    retryOnInteraction = false;
    return;
  }
  if (location.protocol !== "https:" && location.hostname !== "localhost") {
    updateState("idle", "تحتاج المحادثة إلى فتح الرابط المنشور الآمن (HTTPS).");
    return;
  }

  attempt += 1;
  messages = [];
  transcript.textContent = "";
  updateState("listening", "جارٍ تشغيل الميكروفون... اسمح بإذن الميكروفون عند الطلب.");
  window.dispatchEvent(new Event("baseer:conversation-start"));
  createRecognition();
  retryOnInteraction = false;
  scheduleListening(300);
}

document.addEventListener("pointerdown", () => {
  if (retryOnInteraction && state === "idle") startConversation();
}, true);

window.addEventListener("pagehide", () => stopConversation("انتهت المحادثة الصوتية."));
document.addEventListener("visibilitychange", () => {
  if (document.hidden && state !== "idle") {
    resumeAfterVisibility = true;
    stopConversation("أُوقفت المحادثة عند مغادرة التطبيق.");
  } else if (!document.hidden && resumeAfterVisibility) {
    resumeAfterVisibility = false;
    startConversation();
  }
});

startConversation();
})();
