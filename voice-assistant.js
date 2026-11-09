"use strict";

const status = document.getElementById("voice-chat-status");
const transcript = document.getElementById("voice-chat-transcript");
const audio = document.getElementById("voice-chat-audio");

let connection = null;
let events = null;
let microphone = null;
let connectionAttempt = 0;
let connectionAbortController = null;
let state = "idle";
let transcriptBuffer = "";
let resumeAfterVisibility = false;

audio.autoplay = true;
audio.playsInline = true;

function updateState(nextState, message) {
  state = nextState;
  status.textContent = message;
}

function waitForIceGathering(peer, signal, timeoutMs = 12000) {
  if (peer.iceGatheringState === "complete") return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("انتهت مهلة تجهيز اتصال الصوت."));
    }, timeoutMs);

    function cleanup() {
      window.clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", onStateChange);
      signal.removeEventListener("abort", onAbort);
    }

    function onStateChange() {
      if (peer.iceGatheringState !== "complete") return;
      cleanup();
      resolve();
    }

    function onAbort() {
      cleanup();
      reject(new DOMException("Connection was cancelled.", "AbortError"));
    }

    peer.addEventListener("icegatheringstatechange", onStateChange);
    signal.addEventListener("abort", onAbort, { once: true });
    if (peer.iceGatheringState === "complete") {
      cleanup();
      resolve();
    } else if (signal.aborted) {
      onAbort();
    }
  });
}

function handleServerEvent(event) {
  let message;
  try {
    message = JSON.parse(event.data);
  } catch (error) {
    console.warn("Unable to read voice conversation event:", error);
    return;
  }

  if (message.type === "session.started" || message.type === "session.created") {
    updateState("active", "المحادثة جاهزة. تحدث الآن، ويمكنك مقاطعة بصير في أي وقت.");
  } else if (message.type === "input_audio_buffer.speech_started") {
    status.textContent = "أستمع إليك...";
  } else if (message.type === "response.created") {
    status.textContent = "بصير يجيبك... تحدث لمقاطعته.";
  } else if (message.type === "response.output_audio_transcript.delta" && typeof message.delta === "string") {
    transcriptBuffer += message.delta;
  } else if (message.type === "response.output_audio_transcript.done" && typeof message.transcript === "string") {
    transcriptBuffer = message.transcript;
    transcript.textContent = transcriptBuffer;
  } else if (message.type === "response.done" && state === "active") {
    status.textContent = "تحدث متى شئت، وسيستمع بصير ويرد عليك.";
  } else if (message.type === "error") {
    console.error("Voice conversation service error:", message.error);
    status.textContent = "حدث خطأ في المحادثة الصوتية. أنهِ الجلسة وحاول مرة أخرى.";
  }
}

function releaseResources() {
  if (connectionAbortController) {
    connectionAbortController.abort();
    connectionAbortController = null;
  }
  if (events) {
    events.close();
    events = null;
  }
  if (connection) {
    const currentConnection = connection;
    connection = null;
    currentConnection.ontrack = null;
    currentConnection.onconnectionstatechange = null;
    currentConnection.close();
  }
  if (microphone) {
    microphone.getTracks().forEach((track) => track.stop());
    microphone = null;
  }
  audio.pause();
  audio.srcObject = null;
  window.dispatchEvent(new Event("baseer:conversation-stop"));
}

function stopConversation(message = "انتهت المحادثة الصوتية.") {
  connectionAttempt += 1;
  releaseResources();
  updateState("idle", message);
}

async function startConversation() {
  const attempt = ++connectionAttempt;
  connectionAbortController = new AbortController();
  const abortSignal = connectionAbortController.signal;
  updateState("connecting", "جارٍ طلب إذن الميكروفون وتجهيز المحادثة...");
  transcript.textContent = "";
  transcriptBuffer = "";
  window.dispatchEvent(new Event("baseer:conversation-start"));

  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.RTCPeerConnection) {
      throw new Error("هذا المتصفح لا يدعم المحادثة الصوتية المباشرة.");
    }
    if (location.protocol !== "https:" && location.hostname !== "localhost") {
      throw new Error("تحتاج المحادثة الصوتية إلى موقع HTTPS منشور مع خادم محادثة.");
    }

    microphone = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    if (attempt !== connectionAttempt) {
      microphone.getTracks().forEach((track) => track.stop());
      microphone = null;
      return;
    }

    connection = new RTCPeerConnection();
    const currentConnection = connection;
    microphone.getAudioTracks().forEach((track) => currentConnection.addTrack(track, microphone));
    currentConnection.ontrack = (event) => {
      audio.srcObject = event.streams[0] || new MediaStream([event.track]);
      audio.play().catch((error) => {
        console.error("Unable to play the assistant audio:", error);
        status.textContent = "تعذّر تشغيل صوت بصير. تحقق من إعدادات الصوت ثم أعد المحاولة.";
      });
    };
    currentConnection.onconnectionstatechange = () => {
      if (connection !== currentConnection || currentConnection.connectionState !== "failed") return;
      stopConversation("انقطع اتصال المحادثة. تحقق من الإنترنت ثم حاول مجددًا.");
    };
    events = currentConnection.createDataChannel("oai-events");
    events.onmessage = handleServerEvent;
    events.onopen = () => {
      if (connection === currentConnection) {
        updateState("active", "المحادثة جاهزة. تحدث الآن، ويمكنك مقاطعة بصير في أي وقت.");
      }
    };
    events.onerror = (error) => {
      console.error("Voice conversation event channel failed:", error);
      status.textContent = "تعذّر استقبال المحادثة الصوتية. أنهِ الجلسة وحاول مرة أخرى.";
    };

    const offer = await currentConnection.createOffer();
    await currentConnection.setLocalDescription(offer);
    await waitForIceGathering(currentConnection, abortSignal);
    if (attempt !== connectionAttempt) return;

    const response = await fetch(new URL("./api/session", document.baseURI), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ sdp: currentConnection.localDescription.sdp }),
      signal: abortSignal
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(result.error || `تعذّر إنشاء جلسة المحادثة (${response.status}).`);
    }
    if (typeof result.sdp !== "string" || !result.sdp) {
      throw new Error("استجابة خدمة المحادثة غير مكتملة.");
    }
    if (attempt !== connectionAttempt) return;

    await currentConnection.setRemoteDescription({ type: "answer", sdp: result.sdp });
    if (attempt === connectionAttempt) {
      updateState("active", "تم الاتصال. تحدث بالعربية، ويمكنك مقاطعة بصير في أي وقت.");
    }
  } catch (error) {
    if (attempt !== connectionAttempt) return;
    console.error("Unable to start the voice conversation:", error);
    const message = error && error.name === "NotAllowedError"
      ? "لم يُسمح باستخدام الميكروفون. فعّل إذن الميكروفون من إعدادات المتصفح."
      : error && error.name === "TypeError"
        ? "تعذّر الوصول إلى خادم المحادثة. تحقق من الإنترنت ومن نشر الخادم وإعداد مفتاح الخدمة."
        : error && error.message
          ? error.message
          : "تعذّر بدء المحادثة الصوتية. تحقق من الاتصال وحاول مرة أخرى.";
    stopConversation(message);
  }
}

window.addEventListener("pagehide", () => stopConversation("انتهت المحادثة الصوتية."));
document.addEventListener("pointerdown", () => {
  if (!audio.srcObject || !audio.paused) return;
  audio.play().then(() => {
    status.textContent = "تم تفعيل الصوت. تحدث بالعربية لمتابعة المحادثة.";
  }).catch((error) => {
    console.error("Unable to resume assistant audio after user interaction:", error);
    status.textContent = "تعذّر تشغيل صوت بصير. تحقق من إعدادات الصوت في المتصفح.";
  });
}, true);
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
