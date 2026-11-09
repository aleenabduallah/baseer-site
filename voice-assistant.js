(() => {
"use strict";

const status = document.getElementById("voice-chat-status");
const transcript = document.getElementById("voice-chat-transcript");
const audioPlayer = document.getElementById("voice-chat-audio");
const camera = document.getElementById("camera");
const BrowserSpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const MAX_HISTORY = 8;

let recognition = null;
let state = "idle";
let messages = [];
let requestController = null;
let restartTimer = null;
let attempt = 0;
let resumeAfterVisibility = false;
let audioObjectUrl = null;
let speechFallback = null;
let speechOutputUnlocked = false;
let recognitionRetryDelay = 800;
let recognitionNetworkFailures = 0;
let inputMode = "speech";
let microphoneStream = null;
let audioContext = null;
let audioAnalyser = null;
let audioMonitor = null;
let recorder = null;
let recorderChunks = [];
let speechStartedAt = 0;
let silenceStartedAt = 0;

async function captureCameraFrame() {
  if (!camera) return null;
  const cameraStatus = document.getElementById("camera-status");
  const deadline = Date.now() + (cameraStatus && cameraStatus.textContent.includes("جارٍ تجهيز المساعدة") ? 4000 : 0);
  while (camera.readyState < HTMLMediaElement.HAVE_CURRENT_DATA && Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, 150));
  }
  if (camera.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
      !camera.videoWidth || !camera.videoHeight) return null;

  const canvas = document.createElement("canvas");
  const scale = Math.min(1, 768 / Math.max(camera.videoWidth, camera.videoHeight));
  canvas.width = Math.round(camera.videoWidth * scale);
  canvas.height = Math.round(camera.videoHeight * scale);
  const context = canvas.getContext("2d");
  if (!context) return null;

  context.drawImage(camera, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.7).split(",")[1];
}

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

function stopAudioInput() {
  if (audioMonitor) {
    window.clearInterval(audioMonitor);
    audioMonitor = null;
  }
  if (recorder) {
    const currentRecorder = recorder;
    recorder = null;
    currentRecorder.ondataavailable = null;
    currentRecorder.onstop = null;
    if (currentRecorder.state !== "inactive") {
      try {
        currentRecorder.stop();
      } catch (error) {
        console.error("Unable to stop audio recording:", error);
      }
    }
  }
  recorderChunks = [];
  speechStartedAt = 0;
  silenceStartedAt = 0;
  if (microphoneStream) {
    microphoneStream.getTracks().forEach((track) => track.stop());
    microphoneStream = null;
  }
  if (audioContext) {
    const currentContext = audioContext;
    audioContext = null;
    audioAnalyser = null;
    void currentContext.close().catch((error) => {
      console.error("Unable to close audio input:", error);
    });
  }
}

function finishAudioRecording() {
  if (recorder && recorder.state === "recording") recorder.stop();
}

function startAudioRecorder() {
  if (state !== "listening" || document.hidden || inputMode !== "audio" ||
      !microphoneStream || recorder) return;

  try {
    const mimeType = typeof MediaRecorder.isTypeSupported === "function"
      ? ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]
        .find((type) => MediaRecorder.isTypeSupported(type))
      : "";
    recorder = mimeType
      ? new MediaRecorder(microphoneStream, { mimeType })
      : new MediaRecorder(microphoneStream);
    recorderChunks = [];
    speechStartedAt = 0;
    silenceStartedAt = 0;
    recorder.ondataavailable = (event) => {
      if (speechStartedAt && event.data.size) recorderChunks.push(event.data);
    };
    recorder.onstop = () => {
      const currentRecorder = recorder;
      recorder = null;
      const hasSpeech = speechStartedAt > 0;
      const clip = new Blob(recorderChunks, {
        type: currentRecorder && currentRecorder.mimeType ? currentRecorder.mimeType : "audio/mp4"
      });
      recorderChunks = [];
      speechStartedAt = 0;
      silenceStartedAt = 0;
      if (hasSpeech && clip.size > 0 && state === "listening") {
        void sendAudioMessage(clip);
      } else if (state === "listening") {
        scheduleListening(250);
      }
    };
    recorder.start(250);
    if (audioMonitor) window.clearInterval(audioMonitor);
    audioMonitor = window.setInterval(() => {
      if (state !== "listening" || !audioAnalyser || !recorder ||
          recorder.state !== "recording") return;
      const samples = new Uint8Array(audioAnalyser.fftSize);
      audioAnalyser.getByteTimeDomainData(samples);
      let total = 0;
      for (const sample of samples) {
        const amplitude = (sample - 128) / 128;
        total += amplitude * amplitude;
      }
      const volume = Math.sqrt(total / samples.length);
      const now = Date.now();
      if (volume >= 0.025) {
        if (!speechStartedAt) {
          speechStartedAt = now;
          recorderChunks = [];
        }
        silenceStartedAt = 0;
      } else if (speechStartedAt) {
        if (!silenceStartedAt) silenceStartedAt = now;
        if ((now - silenceStartedAt >= 1500 && now - speechStartedAt >= 500) ||
            now - speechStartedAt >= 12000) {
          finishAudioRecording();
        }
      }
    }, 100);
    status.textContent = speechOutputUnlocked
      ? "أستمع لك؛ تحدث، وسأجيبك بصوت."
      : "المحادثة جاهزة. المس الشاشة مرة لتفعيل صوت بصير، ثم تحدث.";
  } catch (error) {
    console.error("Unable to start audio recording:", error);
    stopConversation("تعذّر بدء تسجيل الصوت. تحقق من إذن الميكروفون ثم أعد تحميل الصفحة.");
  }
}

function resumeAudioInputFromGesture() {
  if (!audioContext || audioContext.state !== "suspended" || state !== "listening" ||
      inputMode !== "audio") return;
  audioContext.resume()
    .then(() => {
      if (audioContext && audioContext.state === "running") {
        status.textContent = "أستمع لك؛ تحدث، وسأجيب بعد انتهائك.";
        startAudioRecorder();
      }
    })
    .catch((error) => console.error("Unable to resume microphone audio processing:", error));
}

function resumeListeningAfterSpeech(currentAttempt) {
  if (currentAttempt !== attempt || state !== "speaking") return;
  updateState("listening", "أستمع لك؛ تحدث، وسأجيبك بصوت.");
  if (inputMode === "audio") {
    void startAudioFallback();
  } else {
    createRecognition();
    scheduleListening(300);
  }
}

function unlockSpeechOutputFromGesture() {
  if (speechOutputUnlocked || state !== "listening" || !("speechSynthesis" in window) ||
      typeof window.SpeechSynthesisUtterance !== "function") return;

  const currentAttempt = attempt;
  releaseRecognition();
  stopAudioInput();
  window.speechSynthesis.cancel();
  updateState("speaking", "بصير يرحب بك صوتيًا...");
  speechFallback = new window.SpeechSynthesisUtterance(
    "أهلًا، أنا بصير. خلنا نسولف! اسألني أي شيء، وسأجيبك بصوت."
  );
  speechFallback.lang = "ar-SA";
  speechFallback.rate = 0.95;
  const arabicVoice = window.speechSynthesis.getVoices()
    .find((voice) => /^ar(-|$)/i.test(voice.lang));
  if (arabicVoice) speechFallback.voice = arabicVoice;
  speechFallback.onstart = () => {
    speechOutputUnlocked = true;
  };
  speechFallback.onend = () => {
    speechFallback = null;
    resumeListeningAfterSpeech(currentAttempt);
  };
  speechFallback.onerror = (error) => {
    console.error("Unable to unlock spoken replies:", error.error);
    speechFallback = null;
    resumeListeningAfterSpeech(currentAttempt);
    status.textContent = "تعذّر تفعيل الصوت. تحقق من صوت الجهاز ثم المس الشاشة للمحاولة مجددًا.";
  };
  window.speechSynthesis.speak(speechFallback);
}

async function startAudioFallback() {
  inputMode = "audio";
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia ||
      typeof MediaRecorder === "undefined") {
    stopConversation("هذا المتصفح لا يدعم تسجيل الصوت للمحادثة. جرّبي Safari محدثًا أو جهازًا آخر.");
    return;
  }
  updateState("listening", "جارٍ تفعيل الميكروفون للمحادثة الصوتية...");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    });
    if (state !== "listening" || document.hidden) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    microphoneStream = stream;
    const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextConstructor) throw new Error("AudioContext is unavailable");
    audioContext = new AudioContextConstructor();
    await audioContext.resume();
    audioAnalyser = audioContext.createAnalyser();
    audioAnalyser.fftSize = 512;
    audioContext.createMediaStreamSource(microphoneStream).connect(audioAnalyser);
    if (audioContext.state !== "running") {
      status.textContent = "المتصفح يحتاج لمسة على الشاشة لتفعيل الاستماع؛ المس الشاشة مرة ثم تحدث.";
      return;
    }
    startAudioRecorder();
  } catch (error) {
    console.error("Unable to initialize audio recording:", error);
    const message = error && (error.name === "NotAllowedError" || error.name === "SecurityError")
      ? "اسمحي للمتصفح باستخدام الميكروفون ثم أعيدي تحميل الصفحة."
      : error && error.name === "NotFoundError"
        ? "لم يتم العثور على ميكروفون متصل."
        : "تعذّر تشغيل الميكروفون. تحققي من إعداداته وحاولي مرة أخرى.";
    stopConversation(message);
  }
}

function handleUserGesture() {
  if (!speechOutputUnlocked) {
    unlockSpeechOutputFromGesture();
  }
  resumeAudioInputFromGesture();
}

document.addEventListener("pointerdown", handleUserGesture, { passive: true });
document.addEventListener("click", handleUserGesture);
document.addEventListener("keydown", handleUserGesture);

function stopConversation(message = "انتهت المحادثة الصوتية.") {
  attempt += 1;
  if (requestController) {
    requestController.abort();
    requestController = null;
  }
  releaseRecognition();
  stopAudioInput();
  audioPlayer.pause();
  if (speechFallback && "speechSynthesis" in window) {
    window.speechSynthesis.cancel();
    speechFallback = null;
  }
  updateState("idle", message);
  window.dispatchEvent(new Event("baseer:conversation-stop"));
}

function scheduleListening(delay = 450) {
  if (state !== "listening" || document.hidden || restartTimer) return;
  restartTimer = window.setTimeout(() => {
    restartTimer = null;
    if (state !== "listening" || document.hidden) return;
    if (inputMode === "audio") {
      startAudioRecorder();
      return;
    }
    if (!recognition) return;
    try {
      recognition.start();
    } catch (error) {
      if (error.name === "InvalidStateError") {
        scheduleListening(500);
        return;
      }
      console.error("Unable to start browser speech recognition:", error);
      stopConversation("تعذّر تشغيل الاستماع الصوتي. المس الشاشة وحاول مرة أخرى.");
    }
  }, delay);
}

async function speakReply(userText, reply, audio, mimeType, currentAttempt) {
  if (currentAttempt !== attempt) return;
  transcript.textContent = "";

  let fallbackStarted = false;
  let hasAudioSource = false;
  const resumeListeningAfterReply = () => {
    if (currentAttempt !== attempt || state !== "speaking") return;
    audioPlayer.hidden = true;
    updateState("listening", "تحدث بعد سماع الرد؛ قد يتوقف عند نفاد الحصة المجانية.");
    scheduleListening();
  };
  const useSpeechFallback = (error) => {
    if (fallbackStarted || currentAttempt !== attempt || state !== "speaking") return;
    fallbackStarted = true;
    audioPlayer.pause();
    audioPlayer.onerror = null;

    if ("speechSynthesis" in window && typeof window.SpeechSynthesisUtterance === "function") {
      console.warn("Falling back to browser speech for the spoken reply.", error);
      audioPlayer.hidden = true;
      speechFallback = new window.SpeechSynthesisUtterance(reply);
      speechFallback.lang = "ar-SA";
      speechFallback.rate = 0.95;
      speechFallback.onend = () => {
        speechFallback = null;
        resumeListeningAfterReply();
      };
      speechFallback.onerror = (speechError) => {
        console.error("Browser speech fallback failed:", speechError.error);
        speechFallback = null;
        showAudioPlayerFallback();
      };
      window.speechSynthesis.speak(speechFallback);
      return;
    }

    console.error("No supported speech output is available.");
    stopConversation("تعذّر تشغيل الرد صوتيًا. حاول مرة أخرى.");
  };
  function showAudioPlayerFallback() {
    if (currentAttempt !== attempt || state !== "speaking") return;
    if (!hasAudioSource) {
      console.error("No playable generated audio is available.");
      stopConversation("تعذّر تشغيل الرد صوتيًا. حاول مرة أخرى.");
      return;
    }
    audioPlayer.hidden = false;
    updateState("speaking", "الرد جاهز صوتيًا. استخدم مشغل الصوت لسماعه.");
    audioPlayer.focus();
  }

  updateState("speaking", "بصير يرد عليك.");
  if (typeof audio !== "string" || !audio) {
    useSpeechFallback("Generated speech audio was unavailable.");
    return;
  }

  try {
    audioPlayer.pause();
    if (audioObjectUrl) URL.revokeObjectURL(audioObjectUrl);
    const binary = atob(audio);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    audioObjectUrl = URL.createObjectURL(new Blob([bytes], { type: mimeType || "audio/wav" }));
    audioPlayer.src = audioObjectUrl;
    hasAudioSource = true;
    audioPlayer.onended = resumeListeningAfterReply;
    audioPlayer.onerror = () => useSpeechFallback("Audio playback failed.");
    await audioPlayer.play();
  } catch (error) {
    if (currentAttempt !== attempt) return;
    useSpeechFallback(error);
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("تعذّرت قراءة التسجيل الصوتي."));
        return;
      }
      resolve(reader.result.split(",")[1]);
    };
    reader.onerror = () => reject(new Error("تعذّرت قراءة التسجيل الصوتي."));
    reader.readAsDataURL(blob);
  });
}

async function sendAudioMessage(blob) {
  if (state !== "listening") return;
  const mimeType = (blob.type || "").split(";")[0].toLowerCase();
  if (!["audio/aac", "audio/mp4", "audio/mpeg", "audio/ogg", "audio/wav", "audio/webm"].includes(mimeType)) {
    stopConversation("صيغة تسجيل الصوت غير مدعومة في هذا المتصفح.");
    return;
  }
  await sendTurn("سؤال صوتي", { blob, mimeType });
}

async function sendMessage(text) {
  const trimmedText = text.trim();
  if (!trimmedText || state !== "listening") return;
  await sendTurn(trimmedText);
}

async function sendTurn(userText, audioInput = null) {
  const currentAttempt = attempt;
  if (state !== "listening") return;
  let heardText = userText;
  if (inputMode === "speech" && recognition) recognition.stop();
  updateState("thinking", audioInput ? "وصل سؤالك؛ بصير يحلله ويجهّز الرد..." : "وصل كلامك؛ بصير يجهّز الرد...");
  transcript.textContent = `أنت: ${userText}`;
  requestController = new AbortController();

  try {
    const image = await captureCameraFrame();
    const audio = audioInput ? await blobToBase64(audioInput.blob) : null;
    const response = await fetch(new URL("./api/chat", document.baseURI), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        messages: [...messages, { role: "user", text: userText }].slice(-MAX_HISTORY),
        ...(image ? { image } : {}),
        ...(audio ? { audio: { data: audio, mimeType: audioInput.mimeType } } : {})
      }),
      signal: requestController.signal
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const errorMessage = result.error || "تعذّر الحصول على رد من Gemini. حاول مرة أخرى.";
      if (typeof result.text !== "string" || !result.text.trim()) {
        const error = new Error(errorMessage);
        error.status = response.status;
        throw error;
      }
      if (audioInput && typeof result.heard === "string" && result.heard.trim()) {
        heardText = result.heard.trim();
      }
      const reply = result.text.trim();
      messages = [...messages, { role: "user", text: heardText }, { role: "model", text: reply }].slice(-MAX_HISTORY);
      await speakReply(heardText, reply, result.audio, result.audioMimeType, currentAttempt);
      return;
    }
    if (currentAttempt !== attempt) return;

    const reply = typeof result.text === "string" ? result.text.trim() : "";
    if (!reply) throw new Error("لم يصل رد نصي من Gemini. حاول مرة أخرى.");
    if (audioInput && typeof result.heard === "string" && result.heard.trim()) {
      heardText = result.heard.trim();
    }
    messages = [...messages, { role: "user", text: heardText }, { role: "model", text: reply }].slice(-MAX_HISTORY);
    await speakReply(heardText, reply, result.audio, result.audioMimeType, currentAttempt);
  } catch (error) {
    if (currentAttempt !== attempt || (error && error.name === "AbortError")) return;
    console.error("Unable to get a Gemini response:", error);
    if (error && (error.status === 429 || error.status >= 500)) {
      stopConversation(error.message);
      return;
    }
    updateState("listening", error && error.message ? error.message : "تعذّر الحصول على رد. حاول مرة أخرى.");
    scheduleListening(1400);
  } finally {
    if (currentAttempt === attempt) requestController = null;
  }
}

function createRecognition() {
  if (!BrowserSpeechRecognition) {
    void startAudioFallback();
    return;
  }
  try {
    recognition = new BrowserSpeechRecognition();
  } catch (error) {
    console.error("Unable to create browser speech recognition:", error);
    void startAudioFallback();
    return;
  }
  recognition.lang = "ar-SA";
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  recognition.onstart = () => {
    if (state === "listening") {
      status.textContent = speechOutputUnlocked
        ? "أستمع لك؛ تحدث، وسأجيبك بصوت."
        : "المحادثة جاهزة. المس الشاشة مرة لتفعيل صوت بصير، ثم تحدث.";
    }
  };
  recognition.onresult = (event) => {
    if (state !== "listening") return;
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      if (result.isFinal && result[0].transcript.trim()) {
        recognitionNetworkFailures = 0;
        recognitionRetryDelay = 800;
        void sendMessage(result[0].transcript);
        return;
      }
    }
  };
  recognition.onerror = (event) => {
    if (state !== "listening") return;
    if (event.error === "aborted") return;
    if (event.error === "no-speech") {
      status.textContent = "ما سمعت كلامك؛ تحدث الآن وسأجيبك.";
      return;
    }
    if (event.error === "network") {
      recognitionNetworkFailures += 1;
      if (recognitionNetworkFailures >= 3 && typeof MediaRecorder !== "undefined") {
        releaseRecognition();
        status.textContent = "سأستخدم طريقة استماع بديلة لهذا المتصفح.";
        void startAudioFallback();
        return;
      }
      status.textContent = "تعذّر اتصال خدمة التعرّف على الكلام؛ سأعيد المحاولة تلقائيًا.";
      recognitionRetryDelay = Math.min(recognitionRetryDelay * 2, 10000);
      console.warn("Browser speech recognition network error; retrying.");
      return;
    }
    const message = event.error === "not-allowed" || event.error === "service-not-allowed"
      ? "اسمح باستخدام الميكروفون وخدمة التعرّف على الكلام من إعدادات المتصفح."
      : event.error === "language-not-supported"
        ? "التعرّف على العربية غير مدعوم في هذا المتصفح. جرّب Chrome أو Edge."
        : event.error === "audio-capture"
          ? "لم يتم العثور على ميكروفون متصل."
          : "تعذّر التعرّف على كلامك. تحقق من الإنترنت وحاول مرة أخرى.";
    console.error("Browser speech recognition failed:", event.error);
    stopConversation(message);
  };
  recognition.onend = () => {
    if (state === "listening" && !document.hidden) scheduleListening(recognitionRetryDelay);
  };
}

function startConversation() {
  if (state !== "idle") return;
  if (location.protocol !== "https:" && location.hostname !== "localhost") {
    updateState("idle", "تحتاج المحادثة إلى فتح الرابط المنشور الآمن (HTTPS).");
    return;
  }

  attempt += 1;
  messages = [];
  inputMode = "speech";
  recognitionNetworkFailures = 0;
  transcript.textContent = "";
  updateState("listening", "اسمح بالميكروفون، ثم المس الشاشة مرة لتفعيل رد بصير الصوتي.");
  window.dispatchEvent(new Event("baseer:conversation-start"));
  createRecognition();
  scheduleListening(300);
}

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
