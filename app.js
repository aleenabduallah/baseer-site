"use strict";

const video = document.getElementById("camera");
video.autoplay = true;
video.playsInline = true;
video.muted = true;
const stage = document.getElementById("camera-stage");
const placeholder = document.getElementById("camera-placeholder");
const description = document.getElementById("description");
const cameraStatus = document.getElementById("camera-status");
const voiceStatus = document.getElementById("voice-status");
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const arabicLabels = {
  person: "شخص",
  bicycle: "دراجة",
  car: "سيارة",
  motorcycle: "دراجة نارية",
  airplane: "طائرة",
  bus: "حافلة",
  train: "قطار",
  truck: "شاحنة",
  boat: "قارب",
  "traffic light": "إشارة مرور",
  "fire hydrant": "صنبور إطفاء",
  "stop sign": "علامة توقف",
  "parking meter": "عداد موقف",
  bench: "مقعد",
  bird: "طائر",
  cat: "قطة",
  dog: "كلب",
  horse: "حصان",
  sheep: "خروف",
  cow: "بقرة",
  elephant: "فيل",
  bear: "دب",
  zebra: "حمار وحشي",
  giraffe: "زرافة",
  backpack: "حقيبة ظهر",
  umbrella: "مظلة",
  handbag: "حقيبة يد",
  tie: "ربطة عنق",
  suitcase: "حقيبة سفر",
  frisbee: "قرص طائر",
  skis: "زلاجات",
  snowboard: "لوح تزلج",
  "sports ball": "كرة",
  kite: "طائرة ورقية",
  "baseball bat": "مضرب بيسبول",
  "baseball glove": "قفاز بيسبول",
  skateboard: "لوح تزلج",
  surfboard: "لوح ركوب الأمواج",
  "tennis racket": "مضرب تنس",
  bottle: "زجاجة",
  "wine glass": "كأس",
  cup: "كوب",
  fork: "شوكة",
  knife: "سكين",
  spoon: "ملعقة",
  bowl: "وعاء",
  banana: "موزة",
  apple: "تفاحة",
  sandwich: "شطيرة",
  orange: "برتقالة",
  broccoli: "بروكلي",
  carrot: "جزرة",
  "hot dog": "شطيرة نقانق",
  pizza: "بيتزا",
  donut: "كعكة دائرية",
  cake: "كعكة",
  chair: "كرسي",
  couch: "أريكة",
  "potted plant": "نبتة",
  bed: "سرير",
  "dining table": "طاولة",
  toilet: "مرحاض",
  tv: "تلفاز",
  laptop: "حاسوب محمول",
  mouse: "فأرة حاسوب",
  remote: "جهاز تحكم",
  keyboard: "لوحة مفاتيح",
  "cell phone": "هاتف",
  microwave: "ميكروويف",
  oven: "فرن",
  toaster: "محمصة",
  sink: "مغسلة",
  refrigerator: "ثلاجة",
  book: "كتاب",
  clock: "ساعة",
  vase: "مزهرية",
  scissors: "مقص",
  "teddy bear": "دب محشو",
  "hair drier": "مجفف شعر",
  toothbrush: "فرشاة أسنان"
};

let stream = null;
let model = null;
let detectionTimer = null;
let loading = false;
let lastAnnouncement = "";
let lastSpokenAt = 0;
let recognition = null;
let recognitionRestartTimer = null;
let cameraStarting = false;
let cameraPermissionBlocked = false;
let speaking = false;
let recognitionActive = false;
let recognitionAvailable = Boolean(SpeechRecognition);
let autoSpeak = true;
let cameraRequested = false;
let cameraStartId = 0;
let cameraStartController = null;

const furnitureLabels = new Set(["chair", "couch", "bed", "dining table"]);
const highConfidenceLabels = new Set(["person", "chair", "couch", "bed", "dining table", "toilet"]);
const CONFIDENCE_THRESHOLD = 0.72;
const FURNITURE_CONFIDENCE_THRESHOLD = 0.86;
const detectionHistory = [];

function setStatus(message, state) {
  cameraStatus.className = `status-pill${state ? ` is-${state}` : ""}`;
  cameraStatus.lastChild.textContent = ` ${message}`;
}

function speak(text) {
  if (!("speechSynthesis" in window)) {
    setDescription("المتصفح لا يدعم النطق الصوتي. جرّب متصفحًا حديثًا يدعم تحويل النص إلى كلام.");
    return;
  }
  window.speechSynthesis.cancel();
  speaking = true;
  if (recognitionActive) recognition.stop();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "ar-SA";
  utterance.rate = 0.92;
  utterance.pitch = 1;
  utterance.onstart = () => {
    voiceStatus.textContent = "النطق الصوتي يعمل.";
  };
  utterance.onend = resumeListening;
  utterance.onerror = (event) => {
    console.error("Unable to speak:", event.error);
    if (event.error !== "canceled" && event.error !== "interrupted") {
      voiceStatus.textContent = "تعذّر تشغيل الصوت. تأكد من تفعيل الصوت ووجود صوت عربي في إعدادات الجهاز.";
    }
    resumeListening();
  };
  window.speechSynthesis.speak(utterance);
}

function resumeListening() {
  speaking = false;
  if (recognition && !recognitionRestartTimer) {
    recognitionRestartTimer = window.setTimeout(() => {
      recognitionRestartTimer = null;
      startListening();
    }, 350);
  }
}

function setDescription(text, shouldSpeak = false) {
  description.textContent = text;
  lastAnnouncement = text;
  if (shouldSpeak && autoSpeak) speak(text);
}

function normalizeCommand(text) {
  return text
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/[؟?!.,،؛:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function handleVoiceCommand(transcript) {
  const command = normalizeCommand(transcript);
  if (!command) return;

  if (/اكتم الصوت|اوقف النطق|الغ النطق|اسكت/.test(command)) {
    autoSpeak = false;
    const confirmation = "تم إيقاف النطق التلقائي. قل: شغل النطق لتفعيله.";
    setDescription(confirmation);
    speak(confirmation);
  } else if (/شغل النطق|فعل النطق|تحدث تلقائيا/.test(command)) {
    autoSpeak = true;
    setDescription("تم تفعيل النطق التلقائي.", true);
  } else if (/^(يا )?بصير$/.test(command) || /مساعده|الاوامر|كيف استخدم/.test(command)) {
    setDescription("قل: ابدأ يا بصير، ماذا ترى، أعد الوصف، أو توقف يا بصير.", true);
  } else if (/ابدأ|ابدا|شغل الكاميرا|افتح الكاميرا|شغل المساعده/.test(command)) {
    speak("حاضر، أشغّل الكاميرا الآن.");
    startCamera();
  } else if (/توقف|وقف|اغلق الكاميرا|ايقاف|انهاء المساعده/.test(command)) {
    stopCamera();
    setDescription("تم إيقاف الكاميرا. قل: ابدأ يا بصير للمتابعة.", true);
  } else if (/ماذا تري|وش تشوف|شن تشوف|شنو تشوف|ما الذي امامي|شنو قدامي|صف لي|اقرا لي|اقرالي/.test(command)) {
    if (stream) {
      detectObjects(true);
    } else {
      setDescription("الكاميرا متوقفة. قل: ابدأ يا بصير أولاً.", true);
    }
  } else if (/اعد الوصف|كرر|مره اخري|مره اخرى|اسمعني/.test(command)) {
    if (lastAnnouncement) speak(lastAnnouncement);
  } else {
    setDescription("يمكنني تشغيل الكاميرا، وصف ما أمامك، أو إيقاف المساعدة. قل: ابدأ يا بصير، ماذا ترى، أو توقف يا بصير.", true);
  }
}

function startListening() {
  if (!recognition || speaking || document.hidden) return;
  try {
    recognition.start();
  } catch (error) {
    if (error.name !== "InvalidStateError") {
      console.error("Unable to start voice commands:", error);
      document.documentElement.classList.remove("voice-controls-active");
      voiceStatus.textContent = "تعذّر تفعيل الاستماع. اسمح باستخدام الميكروفون.";
    }
  }
}

function initializeVoiceCommands() {
  if (!recognitionAvailable) {
    voiceStatus.textContent = "الأوامر الصوتية غير متاحة في هذا المتصفح. جارٍ طلب إذن الكاميرا.";
    return;
  }

  recognition = new SpeechRecognition();
  recognition.lang = "ar-SA";
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  recognition.onstart = () => {
    recognitionActive = true;
    voiceStatus.textContent = "أستمع للأوامر الصوتية — قل: ابدأ يا بصير";
  };
  recognition.onresult = (event) => {
    const result = event.results[event.results.length - 1];
    const transcript = result[0].transcript.trim();
    if (result.isFinal) {
      handleVoiceCommand(transcript);
    } else {
      voiceStatus.textContent = `أستمع: ${transcript}`;
    }
  };
  recognition.onerror = (event) => {
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      recognitionAvailable = false;
      document.documentElement.classList.remove("voice-controls-active");
      voiceStatus.textContent = "تعذّر تفعيل الأوامر الصوتية؛ جارٍ تشغيل الكاميرا.";
      startCamera();
    } else if (event.error === "language-not-supported") {
      recognitionAvailable = false;
      document.documentElement.classList.remove("voice-controls-active");
      voiceStatus.textContent = "التعرّف على العربية غير مدعوم في هذا المتصفح.";
    } else if (event.error === "audio-capture") {
      recognitionAvailable = false;
      document.documentElement.classList.remove("voice-controls-active");
      voiceStatus.textContent = "لم يتم العثور على ميكروفون متصل.";
    }
  };
  recognition.onend = () => {
    recognitionActive = false;
    if (recognitionAvailable && !speaking && !document.hidden) {
      window.clearTimeout(recognitionRestartTimer);
      recognitionRestartTimer = window.setTimeout(() => {
        recognitionRestartTimer = null;
        startListening();
      }, 500);
    }
  };
  startListening();
}

function getPosition(centerX) {
  const x = centerX / video.videoWidth;
  if (x < 0.36) return "على يسارك";
  if (x > 0.64) return "على يمينك";
  return "أمامك";
}

function bboxOverlap(first, second) {
  const x1 = Math.max(first[0], second[0]);
  const y1 = Math.max(first[1], second[1]);
  const x2 = Math.min(first[0] + first[2], second[0] + second[2]);
  const y2 = Math.min(first[1] + first[3], second[1] + second[3]);
  if (x2 <= x1 || y2 <= y1) return 0;
  const intersection = (x2 - x1) * (y2 - y1);
  const area1 = first[2] * first[3];
  const area2 = second[2] * second[3];
  return intersection / Math.min(area1, area2);
}

function getRequiredThreshold(item) {
  if (furnitureLabels.has(item.class)) return FURNITURE_CONFIDENCE_THRESHOLD;
  if (highConfidenceLabels.has(item.class)) return 0.78;
  return CONFIDENCE_THRESHOLD;
}

function stabilizePredictions(predictions) {
  const now = Date.now();
  const candidates = predictions
    .filter((item) => item.score >= getRequiredThreshold(item))
    .map((item) => ({ ...item, score: Number(item.score.toFixed(3)) }))
    .sort((a, b) => b.score - a.score);

  detectionHistory.push({ time: now, predictions: candidates });
  while (detectionHistory.length && now - detectionHistory[0].time > 4200) detectionHistory.shift();

  return candidates.filter((candidate) => {
    if (!furnitureLabels.has(candidate.class)) return true;
    const matchingSamples = detectionHistory.filter((sample) => sample.predictions.some((previous) =>
      previous.class === candidate.class && bboxOverlap(candidate.bbox, previous.bbox) >= 0.35
    ));
    return matchingSamples.length >= 2;
  });
}

function describePredictions(predictions, forceAnnouncement = false) {
  const clearPredictions = stabilizePredictions(predictions)
    .slice(0, 3);

  if (clearPredictions.length === 0) return "";

  // Avoid a furniture label with another similar label competing for the same region.
  const furniture = clearPredictions.filter((item) => furnitureLabels.has(item.class));
  if (furniture.length) {
    for (const item of furniture) {
      const competing = clearPredictions.find((other) =>
        other !== item && furnitureLabels.has(other.class) && bboxOverlap(item.bbox, other.bbox) >= 0.45
      );
      if (competing) {
        return "أرى أثاثًا أمامك، لكن الشك في كونه طاولة أو سرير أو كرسي مرتفع؛ اقترب أو وجّه الكاميرا ببطء للحصول على وصف أدق.";
      }
    }
  }

  const descriptions = clearPredictions.map((item) => {
    const label = arabicLabels[item.class] || item.class;
    const position = getPosition(item.bbox[0] + item.bbox[2] / 2);
    return `${label} ${position}`;
  });

  if (descriptions.length === 1) return `أرى ${descriptions[0]}.`;
  return `أرى ${descriptions.slice(0, -1).join("، ")} و${descriptions[descriptions.length - 1]}.`;
}

async function detectObjects(forceAnnouncement = false) {
  if (loading) {
    if (forceAnnouncement) setDescription("لحظة، ما زلت أتعرف إلى ما أمامك.", true);
    return;
  }
  if (!model || !stream || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    if (forceAnnouncement) setDescription("الكاميرا ليست جاهزة بعد. قل: ابدأ يا بصير.", true);
    return;
  }
  loading = true;
  try {
    const predictions = await model.detect(video, 20, 0.08, 0.55);
    const message = describePredictions(predictions, forceAnnouncement);
    if (forceAnnouncement && !message) {
      setDescription("لم أتعرف إلى شيء واضح الآن. وجّه الكاميرا نحو الشيء وحاول مرة أخرى.", true);
    } else if (message && (forceAnnouncement || (message !== lastAnnouncement && Date.now() - lastSpokenAt > 4000))) {
      setDescription(message, true);
      lastSpokenAt = Date.now();
    }
  } catch (error) {
    console.error("Object detection failed:", error);
    setDescription("تعذّر تحليل صورة الكاميرا. أوقف المساعدة ثم حاول البدء من جديد.");
    stopCamera();
  } finally {
    loading = false;
  }
}

async function startCamera() {
  if (stream || cameraStarting) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setDescription("هذا المتصفح لا يتيح الكاميرا. افتح الموقع في متصفح حديث عبر اتصال آمن HTTPS أو من localhost.", true);
    return;
  }
  if (!window.cocoSsd || !window.tf) {
    setDescription("لم يتم تحميل نموذج التعرّف. تحقّق من اتصال الإنترنت ثم أعد تحميل الصفحة.", true);
    return;
  }

  cameraRequested = true;
  cameraStarting = true;
  const startId = ++cameraStartId;
  const startController = new AbortController();
  cameraStartController = startController;
  setStatus("جارٍ تجهيز المساعدة", "loading");
  setDescription("جارٍ تشغيل الكاميرا وتحميل نموذج التعرّف.");

  let requestedStream = null;
  try {
    if (navigator.permissions && navigator.permissions.query) {
      try {
        const permission = await navigator.permissions.query({ name: "camera" });
        if (permission.state === "denied") {
          cameraRequested = false;
          cameraPermissionBlocked = true;
          setDescription("إذن الكاميرا مرفوض. اسمح باستخدام الكاميرا من إعدادات المتصفح ثم حاول مجددًا.", true);
          setStatus("الكاميرا متوقفة");
          return;
        }
      } catch (error) {
        console.warn("Camera permission state is unavailable; requesting camera access directly:", error);
      }
    }
    if (startId !== cameraStartId || !cameraRequested) return;

    requestedStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      }
    });
    if (startId !== cameraStartId || !cameraRequested) {
      requestedStream.getTracks().forEach((track) => track.stop());
      return;
    }

    stream = requestedStream;
    stream.getTracks().forEach((track) => {
      track.addEventListener("ended", () => {
        if (stream !== requestedStream || track.readyState !== "ended") return;
        stopCamera();
        setDescription("انقطع اتصال الكاميرا. قل: ابدأ يا بصير لإعادة المحاولة.", true);
      }, { once: true });
    });
    video.srcObject = stream;
    await new Promise((resolve, reject) => {
      if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
        resolve();
        return;
      }
      const cleanup = () => {
        video.removeEventListener("loadedmetadata", onLoadedMetadata);
        video.removeEventListener("error", onVideoError);
        startController.signal.removeEventListener("abort", onAbort);
      };
      const onLoadedMetadata = () => {
        cleanup();
        resolve();
      };
      const onVideoError = () => {
        cleanup();
        reject(new Error("Camera metadata could not be loaded"));
      };
      const onAbort = () => {
        cleanup();
        reject(new Error("Camera startup was cancelled"));
      };
      video.addEventListener("loadedmetadata", onLoadedMetadata);
      video.addEventListener("error", onVideoError);
      startController.signal.addEventListener("abort", onAbort, { once: true });
      if (video.readyState >= HTMLMediaElement.HAVE_METADATA) onLoadedMetadata();
    });
    await video.play();
    if (startId !== cameraStartId || !cameraRequested) return;

    model = model || await window.cocoSsd.load({ base: "mobilenet_v2" });
    if (startId !== cameraStartId || !cameraRequested) return;
    placeholder.hidden = true;
    video.classList.add("is-visible");
    stage.classList.add("is-active");
    cameraPermissionBlocked = false;
    setStatus("المساعدة تعمل", "active");
    setDescription("الكاميرا تعمل. حرّكها ببطء، وسأصف لك ما أتعرف إليه.");
    detectionTimer = window.setInterval(detectObjects, 1100);
  } catch (error) {
    if (startId !== cameraStartId) {
      if (requestedStream) requestedStream.getTracks().forEach((track) => track.stop());
      return;
    }
    console.error("Unable to start camera or model:", error);
    stopCamera();
    const errorName = error && error.name;
    const message = errorName === "NotAllowedError" || errorName === "SecurityError"
      ? "لم يصل إذن الكاميرا. اسمح بالكاميرا من إعدادات Safari، ثم المس الشاشة مرة للمحاولة مجددًا."
      : errorName === "NotFoundError"
        ? "لم يتم العثور على كاميرا متصلة بهذا الجهاز."
        : "تعذّر تشغيل الكاميرا أو نموذج التعرّف. تحقّق من اتصال الإنترنت وإذن الكاميرا ثم حاول مجددًا.";
    setDescription(message, true);
    setStatus("الكاميرا متوقفة");
    cameraPermissionBlocked = errorName === "NotAllowedError" || errorName === "SecurityError";
  } finally {
    if (startId === cameraStartId) {
      cameraStarting = false;
      cameraStartController = null;
    }
  }
}

function stopCamera() {
  cameraRequested = false;
  cameraStartId += 1;
  cameraStarting = false;
  if (cameraStartController) {
    cameraStartController.abort();
    cameraStartController = null;
  }
  if (detectionTimer !== null) {
    window.clearInterval(detectionTimer);
    detectionTimer = null;
  }
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }
  video.srcObject = null;
  video.classList.remove("is-visible");
  stage.classList.remove("is-active");
  placeholder.hidden = false;
  setStatus("الكاميرا متوقفة");
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}

window.addEventListener("pagehide", stopCamera);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (recognitionRestartTimer) window.clearTimeout(recognitionRestartTimer);
    recognitionRestartTimer = null;
    if (recognition) recognition.stop();
    if (cameraRequested || stream || cameraStarting) {
      cameraStartId += 1;
      cameraStarting = false;
      if (cameraStartController) {
        cameraStartController.abort();
        cameraStartController = null;
      }
      if (detectionTimer !== null) {
        window.clearInterval(detectionTimer);
        detectionTimer = null;
      }
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
        stream = null;
      }
      video.srcObject = null;
      video.classList.remove("is-visible");
      stage.classList.remove("is-active");
      placeholder.hidden = false;
    }
  } else {
    startListening();
    if (cameraRequested && !stream && !cameraStarting) startCamera();  }
});
initializeVoiceCommands();

if (!recognitionAvailable) {
  speak("جارٍ تشغيل الكاميرا.");
  startCamera();
}

stage.addEventListener("pointerup", () => {
  if (recognitionAvailable && recognition) {
    startListening();
  }
  if (!stream && !cameraStarting && (!recognitionAvailable || cameraPermissionBlocked)) {
    speak("حاضر، أشغّل الكاميرا الآن.");
    startCamera();
  }
});

if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  navigator.serviceWorker.register("service-worker.js")
    .catch((error) => console.error("Unable to register the app service worker:", error));
}
