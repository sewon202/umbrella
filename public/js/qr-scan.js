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

let lensLock = null;
let lensTimer = 0;

function stopLensLock() {
  if (lensTimer) {
    clearInterval(lensTimer);
    lensTimer = 0;
  }
  lensLock = null;
}

/** 0.5는 초광각·접사다. 1이 있으면 그 일반 화각만 유지한다. */
function mainLensZoom(caps, settings) {
  const range = caps && caps.zoom;
  if (!range || typeof range.min !== "number" || typeof range.max !== "number") return null;
  if (range.min < 1 && range.max >= 1) return 1;
  if (typeof settings.zoom === "number") return settings.zoom;
  return null;
}

async function applyTrack(track, advanced) {
  if (!advanced.length) return;
  try {
    await track.applyConstraints({ advanced });
  } catch (_) {
    for (const item of advanced) {
      try { await track.applyConstraints({ advanced: [item] }); } catch (_) {}
    }
  }
}

/**
 * 초점·노출만 자동. 가까이 대도 렌즈나 배율은 바꾸지 않는다.
 * 사파리는 접사로 넘어갈 때 zoom 값이 바뀌므로, 처음 화각으로 되돌린다.
 */
async function holdRearLens(track) {
  stopLensLock();
  if (!track || typeof track.getCapabilities !== "function") return;
  const caps = track.getCapabilities() || {};
  const settings = typeof track.getSettings === "function" ? (track.getSettings() || {}) : {};
  const advanced = [
    { focusMode: "continuous" },
    { exposureMode: "continuous" },
  ];
  const zoom = mainLensZoom(caps, settings);
  if (zoom != null) advanced.push({ zoom });
  await applyTrack(track, advanced);
  if (zoom == null) return;
  lensLock = { track, zoom };
  lensTimer = setInterval(() => {
    const lock = lensLock;
    if (!lock || lock.track.readyState !== "live") return;
    const now = lock.track.getSettings ? lock.track.getSettings().zoom : null;
    if (typeof now !== "number" || Math.abs(now - lock.zoom) < 0.03) return;
    lock.track.applyConstraints({ advanced: [{ zoom: lock.zoom }] }).catch(() => {});
  }, 400);
}

async function openCameraStream() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error("이 브라우저에서는 카메라를 사용할 수 없어요.");
  }

  // 폰: 후면 기본 화각만. 해상도·줌을 매번 지정하면 배율이 조금씩 달라진다.
  if (isPhoneLike()) {
    const rearAttempts = [
      { audio: false, video: { facingMode: { exact: "environment" } } },
      { audio: false, video: { facingMode: { ideal: "environment" } } },
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
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      finish();
      return;
    }
    const onReady = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) finish();
    };
    video.addEventListener("loadedmetadata", onReady);
    video.addEventListener("loadeddata", onReady);
    video.addEventListener("playing", onReady);
    video.addEventListener("resize", onReady);
    setTimeout(finish, 1200);
  });
}

let stageObserver = null;
let epoch = 0;

function unwatchStage() {
  if (stageObserver) {
    stageObserver.disconnect();
    stageObserver = null;
  }
}

function waitForLayout() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

/** 항상 스테이지 전체를 같은 방식으로 채운다. 픽셀 크기는 열 때마다 배율을 바꾼다. */
export function fitQrVideoCover(video) {
  if (!video) return false;
  video.style.position = "absolute";
  video.style.inset = "0";
  video.style.margin = "0";
  video.style.transform = "none";
  video.style.objectFit = "cover";
  video.style.objectPosition = "center center";
  video.style.width = "100%";
  video.style.height = "100%";
  video.style.maxWidth = "none";
  video.style.maxHeight = "none";
  video.style.minWidth = "0";
  video.style.minHeight = "0";
  return video.videoWidth > 0 && video.videoHeight > 0;
}
function mountFreshVideo(stage) {
  const video = document.createElement("video");
  video.id = "qrVideo";
  video.className = "qr-video";
  video.muted = true;
  video.defaultMuted = true;
  video.autoplay = true;
  video.playsInline = true;
  video.setAttribute("playsinline", "true");
  video.setAttribute("webkit-playsinline", "true");
  video.setAttribute("muted", "");
  video.setAttribute("autoplay", "");
  const previous = stage.querySelector("video");
  if (previous) previous.replaceWith(video);
  else stage.prepend(video);
  return video;
}

function watchStage(video, stage) {
  unwatchStage();
  if (typeof ResizeObserver !== "function" || !stage) return;
  stageObserver = new ResizeObserver(() => {
    if (!running) return;
    if (document.querySelector("main")?.classList.contains("vt-busy")) return;
    fitQrVideoCover(video, stage);
  });
  stageObserver.observe(stage);
}

function clearVideoFit(video) {
  if (!video) return;
  video.style.position = "";
  video.style.inset = "";
  video.style.left = "";
  video.style.top = "";
  video.style.right = "";
  video.style.bottom = "";
  video.style.width = "";
  video.style.height = "";
  video.style.minWidth = "";
  video.style.minHeight = "";
  video.style.maxWidth = "";
  video.style.maxHeight = "";
  video.style.objectFit = "";
  video.style.transform = "";
  video.classList.remove("is-fitted");
}

/** 너무 크게 줄이면 인식이 느려진다. 뷰파인더 QR은 이 크기에서도 읽힌다. */
const SCAN_MAX_SIDE = 480;
let nativeBusy = false;

function scanCanvasSize(w, h) {
  const scale = Math.min(1, SCAN_MAX_SIDE / Math.max(w, h));
  return {
    w: Math.max(1, Math.round(w * scale)),
    h: Math.max(1, Math.round(h * scale)),
  };
}

function firstHit(tasks) {
  return new Promise((resolve) => {
    let left = tasks.length;
    let done = false;
    const finish = (hit) => {
      if (done) return;
      if (hit) {
        done = true;
        resolve(hit);
        return;
      }
      left -= 1;
      if (left <= 0) {
        done = true;
        resolve(null);
      }
    };
    for (const task of tasks) {
      Promise.resolve(task).then(
        (hit) => finish(hit || null),
        () => finish(null),
      );
    }
    if (!tasks.length) resolve(null);
  });
}

async function detectNative(video) {
  if (nativeBusy) return null;
  const det = await ensureDetector();
  if (!det || !video) return null;
  nativeBusy = true;
  const job = det.detect(video).then((codes) => {
    if (!codes || !codes.length) return null;
    const raw = String(codes[0].rawValue || "").trim();
    if (!raw) return null;
    return { raw, format: codes[0].format || "qr_code" };
  }).catch(() => null).finally(() => {
    nativeBusy = false;
  });
  let timer = 0;
  const timed = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), 180);
  });
  try {
    return await Promise.race([job, timed]);
  } finally {
    clearTimeout(timer);
  }
}

function detectJsQR(video, w, h) {
  return loadJsQR().then((decode) => {
    const size = scanCanvasSize(w, h);
    if (!canvasEl) canvasEl = document.createElement("canvas");
    canvasEl.width = size.w;
    canvasEl.height = size.h;
    const ctx = canvasEl.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, size.w, size.h);
    const imageData = ctx.getImageData(0, 0, size.w, size.h);
    const result = decode(imageData.data, imageData.width, imageData.height, {
      inversionAttempts: "dontInvert",
    });
    if (!result || !result.data) return null;
    const raw = String(result.data || "").trim();
    if (!raw) return null;
    return { raw, format: "qr_code" };
  }).catch(() => null);
}

async function detectOnce() {
  if (!videoReady || !videoEl || videoEl.readyState < 2) return null;
  const w = videoEl.videoWidth;
  const h = videoEl.videoHeight;
  if (!w || !h) return null;
  const video = videoEl;
  return firstHit([detectNative(video), detectJsQR(video, w, h)]);
}

async function loop() {
  if (!running) return;
  let hit = null;
  try {
    if (videoReady) {
      hit = await detectOnce();
      if (running && hit && onDecode) onDecode(hit);
    }
  } catch (_) {
    /* 한 프레임이 실패해도 다음 프레임을 계속 본다 */
  }
  if (!running) return;
  loopTimer = setTimeout(loop, hit ? 0 : 16);
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

async function haltCamera() {
  running = false;
  videoReady = false;
  onDecode = null;
  unwatchStage();
  stopLensLock();
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
    videoEl.remove();
    videoEl = null;
  }
}

function releaseStream(localStream) {
  if (!localStream) return;
  localStream.getTracks().forEach((t) => t.stop());
  if (stream === localStream) stream = null;
}

export async function startQrScan({ onResult, onError, whenStable }) {
  const mine = ++epoch;
  await haltCamera();
  if (mine !== epoch) return { ok: false, error: "cancelled" };

  onDecode = (hit) => onResult && onResult(hit);
  running = true;
  torchOn = false;
  videoReady = false;

  try {
    if (!window.isSecureContext) {
      throw new Error("HTTPS 또는 localhost에서만 카메라를 사용할 수 있어요.");
    }
    const stage = document.getElementById("qrFrame");
    const localStream = await openCameraStream();
    if (mine !== epoch) {
      releaseStream(localStream);
      return { ok: false, error: "cancelled" };
    }
    stream = localStream;
    await holdRearLens(localStream.getVideoTracks()[0]);
    if (mine !== epoch) {
      releaseStream(localStream);
      return { ok: false, error: "cancelled" };
    }
    if (whenStable && typeof whenStable.then === "function") await whenStable;
    await waitForLayout();
    if (mine !== epoch) {
      releaseStream(localStream);
      return { ok: false, error: "cancelled" };
    }

    // 화면 이동이 끝난 뒤의 새 태그. 움직이는 중에 재생하면 사파리가 작게 고정한다.
    const video = mountFreshVideo(stage);
    if (mine !== epoch) {
      localStream.getTracks().forEach((t) => t.stop());
      if (stream === localStream) stream = null;
      video.remove();
      return { ok: false, error: "cancelled" };
    }
    videoEl = video;
    // 재생 전에 화면 크기를 확정한다. 재생 후에 맞추면 사파리가 작은 크기로 고정한다.
    fitQrVideoCover(videoEl, stage);
    void videoEl.offsetWidth;
    videoEl.srcObject = stream;
    const played = videoEl.play();
    if (played && typeof played.catch === "function") played.catch(() => {});
    if (mine !== epoch) return { ok: false, error: "cancelled" };
    await waitForVideo(videoEl);
    if (mine !== epoch) return { ok: false, error: "cancelled" };

    watchStage(videoEl, stage);
    fitQrVideoCover(videoEl, stage);
    videoEl.classList.add("is-fitted");

    videoReady = true;
    const decoding = Promise.all([
      ensureDetector(),
      loadJsQR().catch(() => null),
    ]);
    await decoding;
    if (mine !== epoch) return { ok: false, error: "cancelled" };
    loop();
    return { ok: true };
  } catch (e) {
    if (mine !== epoch) return { ok: false, error: "cancelled" };
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
  epoch += 1;
  await haltCamera();
}
