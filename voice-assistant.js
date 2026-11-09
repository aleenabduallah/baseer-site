(() => {
"use strict";

const status = document.getElementById("voice-chat-status");
const transcript = document.getElementById("voice-chat-transcript");
const camera = document.getElementById("camera");
const TARGET_AUDIO_RATE = 16000;
const OUTPUT_AUDIO_RATE = 24000;
const CAMERA_FRAME_INTERVAL = 1000;
const LIVE_TOKEN_ENDPOINT = location.hostname === "aleenabduallah.github.io"
  ? "https://baseer-site-steel.vercel.app/api/live-token"
  : new URL("./api/live-token", document.baseURI);

let state = "idle";
let attempt = 0;
let resumeAfterVisibility = false;
let tokenController = null;
let liveSocket = null;
let sessionReady = false;
let sessionHandle = null;
let reconnectAttempts = 0;
let microphoneStream = null;
let audioContext = null;
let audioProcessor = null;
let silentGain = null;
let cameraTimer = null;
let nextPlaybackTime = 0;
const outputSources = new Set();

function updateState(nextState, message) {
  state = nextState;
  status.textContent = message;
}

function stopPlayback() {
  for (const source of outputSources) {
    source.onended = null;
    try {
      source.stop();
    } catch (error) {
      if (error.name !== "InvalidStateError") {
        console.error("Unable to stop live audio playback:", error);
      }
    }
    source.disconnect();
  }
  outputSources.clear();
  nextPlaybackTime = audioContext ? audioContext.currentTime : 0;
}

function stopAudioInput() {
  if (audioProcessor) {
    audioProcessor.onaudioprocess = null;
    audioProcessor.disconnect();
    audioProcessor = null;
  }
  if (silentGain) {
    silentGain.disconnect();
    silentGain = null;
  }
  if (microphoneStream) {
    microphoneStream.getTracks().forEach((track) => track.stop());
    microphoneStream = null;
  }
  if (audioContext) {
    const currentContext = audioContext;
    audioContext = null;
    void currentContext.close().catch((error) => {
      console.error("Unable to close live audio context:", error);
    });
  }
}

function sendRealtimeInput(message) {
  if (!sessionReady || !liveSocket || liveSocket.readyState !== WebSocket.OPEN) return false;
  liveSocket.send(JSON.stringify({ realtimeInput: message }));
  return true;
}

function resampleToPcm16(samples, sourceRate) {
  const outputLength = Math.floor(samples.length * TARGET_AUDIO_RATE / sourceRate);
  if (!outputLength) return new Int16Array(0);

  const result = new Int16Array(outputLength);
  const step = sourceRate / TARGET_AUDIO_RATE;
  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = index * step;
    const lowerIndex = Math.floor(sourceIndex);
    const upperIndex = Math.min(lowerIndex + 1, samples.length - 1);
    const fraction = sourceIndex - lowerIndex;
    const sample = samples[lowerIndex] * (1 - fraction) + samples[upperIndex] * fraction;
    result[index] = Math.max(-1, Math.min(1, sample)) * (sample < 0 ? 32768 : 32767);
  }
  return result;
}

function pcmToBase64(pcm) {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function initializeAudioInput(stream, currentAttempt) {
  const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextConstructor) throw new Error("AudioContext is unavailable");

  audioContext = new AudioContextConstructor();
  const source = audioContext.createMediaStreamSource(stream);
  audioProcessor = audioContext.createScriptProcessor(4096, 1, 1);
  silentGain = audioContext.createGain();
  silentGain.gain.value = 0;
  audioProcessor.onaudioprocess = (event) => {
    if (currentAttempt !== attempt || !sessionReady) return;
    const pcm = resampleToPcm16(event.inputBuffer.getChannelData(0), audioContext.sampleRate);
    if (!pcm.length) return;
    sendRealtimeInput({
      audio: {
        data: pcmToBase64(pcm),
        mimeType: `audio/pcm;rate=${TARGET_AUDIO_RATE}`
      }
    });
  };
  source.connect(audioProcessor);
  audioProcessor.connect(silentGain);
  silentGain.connect(audioContext.destination);

  resumeAudioContext();
}

function resumeAudioContext() {
  if (!audioContext || audioContext.state === "running") return;
  audioContext.resume()
    .then(() => {
      if (audioContext && audioContext.state === "running" && state === "listening") {
        status.textContent = "أستمع لك؛ قاطعني متى ما بغيت.";
      }
    })
    .catch((error) => console.error("Unable to resume live audio:", error));
}

function handleUserGesture() {
  resumeAudioContext();
}

window.addEventListener("baseer:announce", (event) => {
  const text = event.detail && event.detail.text;
  if (typeof text === "string" && text.trim()) {
    sendRealtimeInput({ text: `أبلغ المستخدم بهذه المعلومة المهمة بإيجاز وبصوتك: ${text.trim()}` });
  }
});

function decodePcm(data) {
  const binary = atob(data);
  const samples = new Int16Array(binary.length / 2);
  for (let index = 0; index < samples.length; index += 1) {
    const byteIndex = index * 2;
    let sample = binary.charCodeAt(byteIndex) | (binary.charCodeAt(byteIndex + 1) << 8);
    if (sample >= 0x8000) sample -= 0x10000;
    samples[index] = sample;
  }
  return samples;
}

function playAudioChunk(data, currentAttempt) {
  if (!audioContext || currentAttempt !== attempt) return;
  resumeAudioContext();
  const samples = decodePcm(data);
  if (!samples.length) return;

  const buffer = audioContext.createBuffer(1, samples.length, OUTPUT_AUDIO_RATE);
  const channel = buffer.getChannelData(0);
  for (let index = 0; index < samples.length; index += 1) {
    channel[index] = samples[index] / 32768;
  }

  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(audioContext.destination);
  source.onended = () => {
    outputSources.delete(source);
    source.disconnect();
    if (!outputSources.size && state === "speaking") {
      updateState("listening", "أستمع لك؛ قاطعني متى ما بغيت.");
    }
  };
  const startAt = Math.max(audioContext.currentTime + 0.025, nextPlaybackTime);
  nextPlaybackTime = startAt + buffer.duration;
  outputSources.add(source);
  source.start(startAt);
  if (state !== "speaking") updateState("speaking", "بصير يتكلم؛ تقدر تقاطعه متى ما بغيت.");
}

function captureCameraFrame() {
  if (!camera || camera.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
      !camera.videoWidth || !camera.videoHeight) return "";
  const canvas = document.createElement("canvas");
  const scale = Math.min(1, 640 / Math.max(camera.videoWidth, camera.videoHeight));
  canvas.width = Math.round(camera.videoWidth * scale);
  canvas.height = Math.round(camera.videoHeight * scale);
  const context = canvas.getContext("2d");
  if (!context) return "";
  context.drawImage(camera, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.65).split(",")[1];
}

function sendCameraFrame() {
  const frame = captureCameraFrame();
  if (frame) {
    sendRealtimeInput({
      video: { data: frame, mimeType: "image/jpeg" }
    });
  }
}

function startCameraFrames() {
  if (cameraTimer) window.clearInterval(cameraTimer);
  sendCameraFrame();
  cameraTimer = window.setInterval(sendCameraFrame, CAMERA_FRAME_INTERVAL);
}

function handleServerMessage(message, currentAttempt) {
  if (currentAttempt !== attempt) return;
  if (message.error) {
    const detail = message.error.message || "Gemini Live returned an error";
    console.error("Gemini Live session error:", detail);
    stopConversation("تعذّر استمرار المحادثة الصوتية. تحقق من حصة Gemini والاتصال ثم أعد تحميل الصفحة.");
    return;
  }
  if (message.sessionResumptionUpdate) {
    const update = message.sessionResumptionUpdate;
    if (update.resumable && typeof update.newHandle === "string") {
      sessionHandle = update.newHandle;
    }
  }
  if (message.goAway && liveSocket && liveSocket.readyState === WebSocket.OPEN) {
    liveSocket.close(1000, "Reconnect live session");
  }

  const serverContent = message.serverContent;
  if (!serverContent) return;
  if (serverContent.interrupted) {
    stopPlayback();
    updateState("listening", "أسمعك؛ تفضل.");
  }
  if (serverContent.inputTranscription && serverContent.inputTranscription.text) {
    transcript.textContent = `أنت: ${serverContent.inputTranscription.text}`;
  }
  if (serverContent.outputTranscription && serverContent.outputTranscription.text) {
    transcript.textContent += ` بصير: ${serverContent.outputTranscription.text}`;
  }
  if (serverContent.modelTurn && Array.isArray(serverContent.modelTurn.parts)) {
    for (const part of serverContent.modelTurn.parts) {
      if (part.inlineData && typeof part.inlineData.data === "string") {
        playAudioChunk(part.inlineData.data, currentAttempt);
      }
    }
  }
  if (serverContent.turnComplete && !outputSources.size && state !== "idle") {
    updateState("listening", "أستمع لك؛ قاطعني متى ما بغيت.");
  }
}

function connectLiveSocket(token, model, config, resumptionHandle, currentAttempt) {
  return new Promise((resolve, reject) => {
    const endpoint = new URL(
      "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained"
    );
    endpoint.searchParams.set("access_token", token);
    const socket = new WebSocket(endpoint.toString());
    socket.binaryType = "arraybuffer";
    liveSocket = socket;
    sessionReady = false;
    let setupComplete = false;
    const setupTimeout = window.setTimeout(() => {
      if (!setupComplete) {
        socket.close();
        reject(new Error("انتهت مهلة تهيئة جلسة الصوت."));
      }
    }, 15000);

    socket.onopen = () => {
      const setup = { ...config };
      if (resumptionHandle) setup.sessionResumption = { handle: resumptionHandle };
      socket.send(JSON.stringify({ setup: { model, ...setup } }));
    };
    socket.onmessage = async (event) => {
      let message;
      try {
        const data = typeof event.data === "string"
          ? event.data
          : event.data instanceof ArrayBuffer
            ? new TextDecoder().decode(event.data)
            : event.data instanceof Blob
              ? await event.data.text()
              : "";
        if (!data) throw new Error("Gemini Live returned an unsupported message type");
        message = JSON.parse(data);
      } catch (error) {
        console.error("Unable to parse Gemini Live response:", error);
        stopConversation("وصل رد غير صالح من خدمة المحادثة. أعد تحميل الصفحة للمحاولة.");
        return;
      }
      if (message.setupComplete) {
        setupComplete = true;
        sessionReady = true;
        window.clearTimeout(setupTimeout);
        resolve();
        return;
      }
      if (message.error && !setupComplete) {
        window.clearTimeout(setupTimeout);
        reject(new Error(message.error.message || "رفضت خدمة الصوت إعداد الجلسة."));
        socket.close();
        return;
      }
      handleServerMessage(message, currentAttempt);
    };
    socket.onerror = () => {
      if (!setupComplete) {
        window.clearTimeout(setupTimeout);
        reject(new Error("تعذّر فتح اتصال الصوت المباشر."));
      }
    };
    socket.onclose = (event) => {
      window.clearTimeout(setupTimeout);
      if (liveSocket !== socket || currentAttempt !== attempt || state === "idle") return;
      sessionReady = false;
      if (sessionHandle && reconnectAttempts < 2) {
        stopPlayback();
        reconnectAttempts += 1;
        updateState("connecting", "أعيد وصل المحادثة مع الاحتفاظ بسياقها...");
        window.setTimeout(() => {
          if (currentAttempt !== attempt || state === "idle") return;
          connectLiveSocket(token, model, config, sessionHandle, currentAttempt)
            .then(() => {
              if (currentAttempt === attempt) {
                updateState("listening", "رجع الاتصال؛ أستمع لك.");
              }
            })
            .catch((error) => {
              if (currentAttempt === attempt) {
                console.error("Unable to resume Gemini Live session:", error, event.code);
                stopConversation("انقطع الاتصال بالمحادثة. أعد تحميل الصفحة للبدء من جديد.");
              }
            });
        }, 500);
      } else {
        console.error("Gemini Live connection closed:", event.code, event.reason);
        stopConversation(event.code === 1008
          ? "رفضت خدمة Gemini جلسة الصوت. تحقق من تفعيل نموذج Live والحصة المتاحة."
          : "انقطع اتصال المحادثة الصوتية. تحقق من الإنترنت وحاول مجددًا.");
      }
    };
  });
}

async function createLiveToken(currentAttempt) {
  tokenController = new AbortController();
  const response = await fetch(LIVE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: "{}",
    signal: tokenController.signal
  });
  const result = await response.json().catch(() => ({}));
  if (currentAttempt !== attempt) throw new DOMException("Conversation was stopped", "AbortError");
  if (!response.ok) {
    const error = new Error(result.error || "تعذّر بدء جلسة الصوت المباشر.");
    error.status = response.status;
    throw error;
  }
  if (typeof result.token !== "string" || typeof result.model !== "string" ||
      !result.config || typeof result.config !== "object") {
    throw new Error("وصل إعداد غير صالح من خادم المحادثة.");
  }
  return result;
}

function microphoneErrorMessage(error) {
  if (error && (error.name === "NotAllowedError" || error.name === "SecurityError")) {
    return "اسمح باستخدام الميكروفون من إعدادات المتصفح ثم أعد تحميل الصفحة.";
  }
  if (error && error.name === "NotFoundError") return "لم يتم العثور على ميكروفون متصل.";
  if (error && error.name === "NotReadableError") return "الميكروفون مستخدم من تطبيق آخر. أغلقه وحاول مجددًا.";
  return "تعذّر تشغيل الميكروفون. تحقق من إذنه وإعدادات الجهاز.";
}

function liveErrorMessage(error) {
  if (error && error.name === "AbortError") return "";
  if (error && error.status === 429) {
    return "وصلت خدمة المحادثة الصوتية إلى حد الاستخدام الحالي. حاول لاحقًا.";
  }
  if (error && error.status === 503) return error.message;
  if (error && error.status >= 500) return error.message;
  if (error && error.name === "NotAllowedError") return microphoneErrorMessage(error);
  if (error && error.name === "NotFoundError") return microphoneErrorMessage(error);
  if (error && error.name === "NotReadableError") return microphoneErrorMessage(error);
  return error && error.message
    ? `تعذّر بدء المحادثة: ${error.message}`
    : "تعذّر بدء المحادثة الصوتية. تحقق من الإنترنت وأذونات الميكروفون.";
}

function stopConversation(message = "انتهت المحادثة الصوتية.") {
  attempt += 1;
  if (tokenController) {
    tokenController.abort();
    tokenController = null;
  }
  sessionReady = false;
  if (cameraTimer) {
    window.clearInterval(cameraTimer);
    cameraTimer = null;
  }
  stopPlayback();
  if (liveSocket) {
    const socket = liveSocket;
    liveSocket = null;
    socket.onclose = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onopen = null;
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  }
  stopAudioInput();
  transcript.textContent = "";
  updateState("idle", message);
  document.documentElement.classList.remove("voice-conversation-active");
  window.dispatchEvent(new Event("baseer:conversation-stop"));
}

async function startConversation() {
  if (state !== "idle") return;
  if (location.protocol !== "https:" && location.hostname !== "localhost") {
    updateState("idle", "افتح رابط بصير الآمن عبر HTTPS لبدء المحادثة.");
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia ||
      typeof WebSocket === "undefined") {
    updateState("idle", "هذا المتصفح لا يدعم المحادثة الصوتية المباشرة.");
    return;
  }

  const currentAttempt = ++attempt;
  sessionHandle = null;
  reconnectAttempts = 0;
  transcript.textContent = "";
  document.documentElement.classList.add("voice-conversation-active");
  updateState("connecting", "اسمح باستخدام الميكروفون لبدء المحادثة...");
  window.dispatchEvent(new Event("baseer:conversation-start"));

  const microphoneRequest = navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false
  }).then((stream) => {
    if (currentAttempt !== attempt) {
      stream.getTracks().forEach((track) => track.stop());
      throw new DOMException("Conversation was stopped", "AbortError");
    }
    microphoneStream = stream;
    return stream;
  });

  try {
    await microphoneRequest;
    if (currentAttempt !== attempt) return;
    initializeAudioInput(microphoneStream, currentAttempt);
    updateState("connecting", "جارٍ الاتصال بالمحادثة الصوتية...");
    const liveSession = await createLiveToken(currentAttempt);
    if (currentAttempt !== attempt) return;
    await connectLiveSocket(liveSession.token, liveSession.model, liveSession.config, null, currentAttempt);
    if (currentAttempt !== attempt) return;

    startCameraFrames();
    updateState("listening", audioContext.state === "running"
      ? "أستمع لك؛ تحدث مباشرة، وسأرد عليك."
      : "أستمع لك تلقائيًا. إذا لم تسمع ردي، المس الشاشة مرة لتفعيل الصوت.");
    const greetingAccepted = sendRealtimeInput({
      text: "ابدأ بتحية قصيرة وودودة باللهجة السعودية، وقل للمستخدم إنك جاهز للمحادثة."
    });
    if (!greetingAccepted) {
      stopConversation("انقطع اتصال المحادثة قبل بدء الاستماع. حاول مجددًا.");
    }
  } catch (error) {
    if (currentAttempt !== attempt) return;
    console.error("Unable to start Gemini Live conversation:", error);
    const microphoneError = error && [
      "NotAllowedError",
      "SecurityError",
      "NotFoundError",
      "NotReadableError"
    ].includes(error.name);
    const message = microphoneError
      ? microphoneErrorMessage(error)
      : liveErrorMessage(error);
    stopConversation(message || "تعذّر بدء المحادثة الصوتية.");
  } finally {
    if (currentAttempt === attempt) tokenController = null;
  }
}

document.addEventListener("pointerdown", handleUserGesture, { passive: true });
document.addEventListener("click", handleUserGesture);
document.addEventListener("keydown", handleUserGesture);

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
