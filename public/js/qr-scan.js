/**
 * 카메라 QR 스캔 (BarcodeDetector + jsQR 폴백)
 * - PC/모바일 모두 getUserMedia 시도 (후면 → 전면 → 기본)
 * - 영상 ready 전에는 디코딩하지 않음
 * - 뷰파인더 중앙만 디코딩
 */
let stream = null;
let running = false;
let loopTimer = null;
let jsQR = null;
let detector = null;
let videoEl = null;
let canvasEl = null;
let onDecode = null;
let coolUntil = 0;
let torchOn = false;
let videoReady = false;

async function loadJsQR() {
  if (jsQR) return jsQR;
  const mod = await import("https://cdn.jsdelivr.net/npm/jsqr@1.4.0/+esm");
  jsQR = mod.default || mod;
  return jsQR;
}

async function ensureDetector() {
  if (detector) return detector;
  if (typeof window.BarcodeDetector !== "function") return null;
  try {
    const formats = await BarcodeDetector.getSupportedFormats();
    if (formats.includes("qr_code")) {
      detector = new BarcodeDetector({ formats: ["qr_code"] });
    }
  } catch (_) {
    detector = null;
  }
  return detector;
}

function isPhoneLike() {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "")
    || (navigator.maxTouchPoints > 1 && window.matchMedia("(pointer: coarse)").matches);
}

async function openCameraStream() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error("이 브라우저에서는 카메라를 사용할 수 없어요.");
  }

  // 폰: 후면(environment)만 — 전면으로 폴백하지 않음
  if (isPhoneLike()) {
    const rearAttempts = [
      {
        audio: false,
        video: {
          facingMode: { exact: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      },
      {
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      },
    ];
    let lastErr = null;
    for (const constraints of rearAttempts) {
      try {
        return await navigator.mediaDevices.getUserMedia(constraints);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("후면 카메라를 열 수 없어요.");
  }

  // PC: 기본 웹캠
  const desktopAttempts = [
    { audio: false, video: { width: { ideal: 1280 }, height: { ideal: 720 } } },
    { audio: false, video: true },
  ];
  let lastErr = null;
  for (const constraints of desktopAttempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("카메라를 열 수 없어요.");
}

function waitForVideo(video) {
  return new Promise((resolve) => {
    const done = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) resolve();
      else requestAnimationFrame(done);
    };
    if (video.readyState >= 2 && video.videoWidth > 0) {
      resolve();
      return;
    }
    video.addEventListener("loadeddata", done, { once: true });
    video.addEventListener("playing", done, { once: true });
    setTimeout(done, 1200);
  });
}

function cropCenter(ctx, w, h, ratio = 0.55) {
  const side = Math.floor(Math.min(w, h) * ratio);
  const sx = Math.floor((w - side) / 2);
  const sy = Math.floor((h - side) / 2);
  return ctx.getImageData(sx, sy, side, side);
}

async function detectOnce() {
  if (!videoReady || !videoEl || videoEl.readyState < 2) return null;
  const w = videoEl.videoWidth;
  const h = videoEl.videoHeight;
  if (!w || !h) return null;

  if (!canvasEl) canvasEl = document.createElement("canvas");
  canvasEl.width = w;
  canvasEl.height = h;
  const ctx = canvasEl.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(videoEl, 0, 0, w, h);

  const det = await ensureDetector();
  if (det) {
    try {
      const side = Math.floor(Math.min(w, h) * 0.55);
      const sx = Math.floor((w - side) / 2);
      const sy = Math.floor((h - side) / 2);
      const crop = document.createElement("canvas");
      crop.width = side;
      crop.height = side;
      crop.getContext("2d").drawImage(canvasEl, sx, sy, side, side, 0, 0, side, side);
      const codes = await det.detect(crop);
      if (codes && codes.length) {
        const raw = String(codes[0].rawValue || "").trim();
        if (raw) return { raw, format: codes[0].format || "qr_code" };
      }
      return null;
    } catch (_) {
      /* jsQR 폴백 */
    }
  }

  const decode = await loadJsQR();
  const imageData = cropCenter(ctx, w, h, 0.55);
  const result = decode(imageData.data, imageData.width, imageData.height, {
    inversionAttempts: "dontInvert",
  });
  if (!result || !result.data) return null;
  const raw = String(result.data || "").trim();
  if (!raw) return null;
  return { raw, format: "qr_code" };
}

async function loop() {
  if (!running) return;
  try {
    if (videoReady && Date.now() >= coolUntil) {
      const hit = await detectOnce();
      if (hit && onDecode) onDecode(hit);
    }
  } catch (_) {
    /* keep looping */
  }
  loopTimer = setTimeout(loop, 300);
}

export function setScanCooldown(ms = 1600) {
  coolUntil = Date.now() + ms;
}

export function getTorchOn() {
  return torchOn;
}

export async function setTorch(on) {
  const track = stream && stream.getVideoTracks()[0];
  if (!track) return false;
  try {
    await track.applyConstraints({ advanced: [{ torch: !!on }] });
    torchOn = !!on;
    return true;
  } catch (_) {
    torchOn = false;
    return false;
  }
}

export async function startQrScan({ video, onResult, onError }) {
  await stopQrScan();
  videoEl = video;
  onDecode = (hit) => onResult && onResult(hit);
  running = true;
  torchOn = false;
  videoReady = false;

  try {
    if (!window.isSecureContext) {
      throw new Error("HTTPS 또는 localhost에서만 카메라를 사용할 수 있어요.");
    }
    stream = await openCameraStream();
    videoEl.srcObject = stream;
    videoEl.setAttribute("playsinline", "true");
    videoEl.muted = true;
    await videoEl.play();
    await waitForVideo(videoEl);
    videoReady = true;
    await ensureDetector();
    if (!detector) await loadJsQR().catch(() => {});
    // 카메라 안정화 전에는 디코딩 금지
    setScanCooldown(1400);
    loop();
    return { ok: true };
  } catch (e) {
    running = false;
    videoReady = false;
    const name = e && e.name;
    let msg = "카메라를 시작할 수 없어요.";
    if (name === "NotAllowedError" || name === "PermissionDeniedError") {
      msg = "카메라 권한이 필요해요. 브라우저에서 허용한 뒤 다시 시도해 주세요.";
    } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
      msg = "사용 가능한 카메라가 없어요.";
    } else if (e && e.message) {
      msg = e.message;
    }
    if (onError) onError(msg);
    return { ok: false, error: msg };
  }
}

export async function stopQrScan() {
  running = false;
  videoReady = false;
  onDecode = null;
  if (loopTimer) {
    clearTimeout(loopTimer);
    loopTimer = null;
  }
  try { await setTorch(false); } catch (_) {}
  torchOn = false;
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  if (videoEl) {
    try { videoEl.pause(); } catch (_) {}
    videoEl.srcObject = null;
  }
}
