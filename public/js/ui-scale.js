/**
 * 폰 화면 높이에 맞춰 UI 배율(--ui-scale)을 잡는다.
 * 기준: 홈 CTA 하단 ≈ (뷰포트 − 하단바) 높이의 ~74% (2/3보다 약간 아래).
 *
 * 홈 대여시간 칸은 배율에 넣지 않는다 — 칸이 열리면 UI를 축소하지 않고 아래로만 민다.
 * 설정 등 다른 탭은 홈(타이머 제외)에서 잡힌 배율을 그대로 쓴다.
 *
 * iOS Safari: 100vh/dvh가 주소창을 접은 "큰 뷰포트"라 첫 화면보다 커서 스크롤이 생김.
 * → visualViewport / innerHeight로 --app-h 를 잡고 셸을 그 높이에 고정.
 *
 * 키보드: visualViewport가 줄어들며 레이아웃·배율이 뭉개지지 않도록
 * 입력 포커스 중에는 --app-h / --ui-scale 갱신을 멈춘다.
 */
/** 하단바 제외 영역 기준 — 2/3보다 약간 아래 */
const TARGET_RATIO = 0.74;
/** scale=1 일 때 상단 → 홈 CTA 하단 대략 높이(px) — 실측 불가 시 fallback */
const DESIGN_CTA_BOTTOM = 470;
const MIN_SCALE = 0.55;
const MAX_SCALE = 1;

/** 키보드 없는 상태의 기준 높이 (키보드로 줄어든 값으로 덮어쓰지 않음) */
let layoutBaselineH = 0;
/** 홈에서 타이머 제외하고 맞춘 배율 — 설정 등에서 재사용 */
let lastHomeBaseScale = 0;

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function isTextInputFocused() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag === "INPUT") {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    return !["button", "submit", "reset", "checkbox", "radio", "file", "hidden", "range", "color"].includes(type);
  }
  return !!el.isContentEditable;
}

function rawViewportHeight() {
  const vv = window.visualViewport;
  const vvH = vv && vv.height ? Math.round(vv.height) : 0;
  const inner = Math.round(window.innerHeight || 0);
  // 둘 중 큰 쪽 — 키보드는 visualViewport만 줄이는 경우가 많음
  if (vvH > 0 && inner > 0) return Math.max(vvH, inner);
  return vvH || inner || 0;
}

function viewportHeight() {
  const h = rawViewportHeight();
  if (!h) return layoutBaselineH || 0;
  // 입력 중 급감 = 키보드 → 기준 높이 유지 (화면 압축 방지)
  if (isTextInputFocused() && layoutBaselineH && h < layoutBaselineH - 60) {
    return layoutBaselineH;
  }
  return h;
}

function syncAppHeight({ force = false } = {}) {
  const measured = rawViewportHeight();
  if (!measured && !layoutBaselineH) return 0;

  if (isTextInputFocused() && layoutBaselineH && !force) {
    // 키보드 열린 동안 --app-h 고정
    document.documentElement.style.setProperty("--app-h", `${layoutBaselineH}px`);
    return layoutBaselineH;
  }

  const h = measured || layoutBaselineH;
  if (force || !layoutBaselineH || Math.abs(h - layoutBaselineH) > 40) {
    // 회전 등으로 크게 바뀔 때만 기준 갱신. 키보드로 작아진 값은 무시.
    if (!isTextInputFocused() || force) {
      layoutBaselineH = h;
    }
  } else if (!isTextInputFocused()) {
    layoutBaselineH = h;
  }

  const apply = layoutBaselineH || h;
  document.documentElement.style.setProperty("--app-h", `${apply}px`);
  return apply;
}

function tabbarHeight() {
  const bar = document.getElementById("tabbar");
  if (bar && !bar.hidden) {
    const h = bar.getBoundingClientRect().height;
    if (h > 0) return h;
  }
  const cs = getComputedStyle(document.documentElement);
  const content = parseFloat(cs.getPropertyValue("--tabbar-content-h")) || 52;
  return content + 34;
}

function currentScale() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--ui-scale").trim();
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function contentTargetY() {
  const vh = viewportHeight();
  if (!vh) return 0;
  return (vh - tabbarHeight()) * TARGET_RATIO;
}

/** 대여시간 슬롯이 차지한 높이(+마진) — 스케일 계산에서 제외 */
function homeTimerLayoutExtra() {
  const slot = document.getElementById("homeTimerSlot");
  if (!slot) return 0;
  const h = slot.getBoundingClientRect().height;
  if (!(h > 0.5)) return 0;
  const mb = parseFloat(getComputedStyle(slot).marginBottom) || 0;
  return h + mb;
}

/** 타이머를 빼서 본 홈 CTA 하단 Y (배율 산정용) */
function homeCtaBottomForScale(btn) {
  if (!btn) return 0;
  const bottom = btn.getBoundingClientRect().bottom;
  if (!(bottom > 40)) return 0;
  return Math.max(40, bottom - homeTimerLayoutExtra());
}

export function updateUiScale({ force = false } = {}) {
  // 키보드로 뷰포트만 줄어든 경우 배율·높이 재계산하지 않음
  if (!force && isTextInputFocused()) {
    syncAppHeight();
    return;
  }

  syncAppHeight({ force });

  // QR/코드/지도 풀스크린: 배율 고정 (전환·키보드 시 확대/축소감 방지)
  if (
    document.body.classList.contains("qr-open") ||
    document.body.classList.contains("code-open") ||
    document.body.classList.contains("map-open")
  ) {
    return;
  }

  const target = contentTargetY();
  if (!target) return;

  const btn = document.getElementById("homeRentBtn");
  const home = document.getElementById("v-home");
  const onHome = !!(btn && home && home.classList.contains("on"));
  const prev = currentScale();

  let scale;
  if (onHome) {
    const bottom = homeCtaBottomForScale(btn);
    if (bottom > 40) {
      scale = clamp((target * prev) / bottom, MIN_SCALE, MAX_SCALE);
    } else {
      scale = clamp(target / DESIGN_CTA_BOTTOM, MIN_SCALE, MAX_SCALE);
    }
    lastHomeBaseScale = scale;
  } else if (lastHomeBaseScale > 0) {
    // 설정 등: 홈(타이머 무시)에서 맞춘 배율 유지 — 타이머 때문에 작아지지 않게
    scale = clamp(lastHomeBaseScale, MIN_SCALE, MAX_SCALE);
  } else {
    scale = clamp(target / DESIGN_CTA_BOTTOM, MIN_SCALE, MAX_SCALE);
  }

  document.documentElement.style.setProperty("--ui-scale", scale.toFixed(4));

  if (!onHome) return;
  requestAnimationFrame(() => {
    if (isTextInputFocused()) return;
    const bottom2 = homeCtaBottomForScale(btn);
    if (!(bottom2 > 40)) return;
    const s2 = currentScale();
    const next = clamp((target * s2) / bottom2, MIN_SCALE, MAX_SCALE);
    if (Math.abs(next - s2) > 0.008) {
      lastHomeBaseScale = next;
      document.documentElement.style.setProperty("--ui-scale", next.toFixed(4));
    }
  });
}

/** 홈/설정처럼 한 화면에 맞출 때 문서 스크롤 잠금 (iOS 바운스·주소창 스크롤 완화) */
export function setShellScrollLock(locked) {
  document.documentElement.classList.toggle("shell-lock", !!locked);
  document.body.classList.toggle("shell-lock", !!locked);
}

let resizeTimer = 0;
function onResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => updateUiScale(), 80);
}

function onFocusIn(e) {
  const t = e.target;
  if (!t) return;
  const tag = t.tagName;
  if (tag !== "INPUT" && tag !== "TEXTAREA" && !t.isContentEditable) return;
  // 포커스 직전 높이를 기준으로 고정
  syncAppHeight();
}

function onFocusOut() {
  // 키보드 닫힌 뒤 한 박자 뒤 기준 높이 재측정
  setTimeout(() => updateUiScale({ force: true }), 120);
}

export function initUiScale() {
  // HTML 인라인으로 이미 잡은 --app-h가 실측과 비슷하면 유지 (로그인 하단 버튼 점프 방지)
  const existing = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue("--app-h")
  );
  const measured = rawViewportHeight();
  if (existing > 100 && measured > 0 && Math.abs(existing - measured) <= 24) {
    layoutBaselineH = Math.round(existing);
    document.documentElement.style.setProperty("--app-h", `${layoutBaselineH}px`);
  } else {
    syncAppHeight({ force: true });
  }
  updateUiScale({ force: true });
  window.addEventListener("resize", onResize, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", onResize, { passive: true });
    window.visualViewport.addEventListener("scroll", onResize, { passive: true });
  }
  window.addEventListener("orientationchange", () => {
    layoutBaselineH = 0;
    setTimeout(() => updateUiScale({ force: true }), 160);
  });
  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("focusout", onFocusOut, true);
}
