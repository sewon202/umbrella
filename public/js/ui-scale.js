/**
 * 폰 화면 높이에 맞춰 UI 배율(--ui-scale)을 잡는다.
 * 기준: 홈 CTA 하단 ≈ (뷰포트 − 하단바) 높이의 ~74% (2/3보다 약간 아래).
 *
 * iOS Safari: 100vh/dvh가 주소창을 접은 "큰 뷰포트"라 첫 화면보다 커서 스크롤이 생김.
 * → visualViewport / innerHeight로 --app-h 를 잡고 셸을 그 높이에 고정.
 */
/** 하단바 제외 영역 기준 — 2/3보다 약간 아래 */
const TARGET_RATIO = 0.74;
/** scale=1 일 때 상단 → 홈 CTA 하단 대략 높이(px) — 실측 불가 시 fallback */
const DESIGN_CTA_BOTTOM = 470;
const MIN_SCALE = 0.55;
const MAX_SCALE = 1;

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function viewportHeight() {
  // iOS: visualViewport가 주소창 펼침 상태를 더 잘 반영하는 경우가 많음
  const vv = window.visualViewport;
  const vvH = vv && vv.height ? Math.round(vv.height) : 0;
  const inner = Math.round(window.innerHeight || 0);
  if (vvH > 0 && inner > 0) return Math.min(vvH, inner);
  return vvH || inner || 0;
}

function syncAppHeight() {
  const h = viewportHeight();
  if (!h) return 0;
  document.documentElement.style.setProperty("--app-h", `${h}px`);
  return h;
}

function tabbarHeight() {
  const bar = document.getElementById("tabbar");
  if (bar && !bar.hidden) {
    const h = bar.getBoundingClientRect().height;
    if (h > 0) return h;
  }
  const cs = getComputedStyle(document.documentElement);
  const content = parseFloat(cs.getPropertyValue("--tabbar-content-h")) || 52;
  // env(safe-area)는 숫자 파싱이 안 될 수 있어 home indicator 대략값
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

export function updateUiScale() {
  syncAppHeight();
  const target = contentTargetY();
  if (!target) return;

  const btn = document.getElementById("homeRentBtn");
  const home = document.getElementById("v-home");
  const onHome = !!(btn && home && home.classList.contains("on"));
  const prev = currentScale();

  let scale;
  if (onHome) {
    const bottom = btn.getBoundingClientRect().bottom;
    if (bottom > 40) {
      scale = clamp((target * prev) / bottom, MIN_SCALE, MAX_SCALE);
    } else {
      scale = clamp(target / DESIGN_CTA_BOTTOM, MIN_SCALE, MAX_SCALE);
    }
  } else {
    scale = clamp(target / DESIGN_CTA_BOTTOM, MIN_SCALE, MAX_SCALE);
  }

  document.documentElement.style.setProperty("--ui-scale", scale.toFixed(4));

  if (!onHome) return;
  requestAnimationFrame(() => {
    const bottom2 = btn.getBoundingClientRect().bottom;
    if (!(bottom2 > 40)) return;
    const s2 = currentScale();
    const next = clamp((target * s2) / bottom2, MIN_SCALE, MAX_SCALE);
    if (Math.abs(next - s2) > 0.008) {
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
  resizeTimer = setTimeout(updateUiScale, 80);
}

export function initUiScale() {
  syncAppHeight();
  updateUiScale();
  window.addEventListener("resize", onResize, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", onResize, { passive: true });
    // 주소창 펼침/접힘 때 offset 변화
    window.visualViewport.addEventListener("scroll", onResize, { passive: true });
  }
  window.addEventListener("orientationchange", () => setTimeout(updateUiScale, 120));
}
