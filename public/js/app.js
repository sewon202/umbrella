import {
  getMode,
  login as apiLogin,
  signup,
  validatePassword,
  restoreSession,
  logoutUser,
  getStationInventory,
  getMyActiveRental,
  rentUmbrella,
  returnUmbrella,
  watchDeviceEvents,
  getAuthHeaders,
  friendlyError,
  MAX_HW_SLOT,
  TOTAL_SLOTS,
  RENT_LIMIT_MS,
  overdueFeeWon,
  savePaymentWallet,
  newPaymentId,
  paymentWallet,
  paymentMethodIssue,
  paymentMethodLabel,
  CARD_ISSUERS,
  STATIONS,
} from "/js/backend.js?v=117";
import { startQrScan, stopQrScan, setTorch, getTorchOn, fitQrVideoCover } from "/js/qr-scan.js?v=59";
import { createDoorSync } from "/js/door-sync.js?v=2";
import {
  initCampusMap,
  selectStation,
  clearStationSelection,
  resizeCampusMap,
  summarizeSlots,
  plannedSlotDetail,
} from "/js/map-view.js?v=92";
import { initUiScale, updateUiScale, setShellScrollLock } from "/js/ui-scale.js?v=64";
import {
  isRentDoorSettled,
  isRentDoorTimeout,
  isReturnDetected,
  isReturnDoorSettled,
  isReturnDoorTimeout,
  isServoStarted,
  pickMatchingEvent,
} from "/js/device-protocol.js?v=97";

initUiScale();

function applyUser(res) {
  const rental = res.activeRental ? keptRental(res.activeRental) : null;
  const wallet = paymentWallet(res);
  state.user = {
    id: res.studentId,
    name: res.name,
    uid: res.uid,
    activeRental: rental,
    lmsVerified: res.lmsVerified === true,
    lmsVerifiedAt: res.lmsVerifiedAt || null,
    paymentMethods: wallet.paymentMethods,
    defaultPaymentId: wallet.defaultPaymentId,
    paymentMethod: wallet.paymentMethod,
  };
}

/** 로그인·새로고침은 서버에 남은 대여 기한을 그대로 쓴다. */
function keptRental(rental) {
  const rentedAt = Number(rental.rented_at);
  const due = Number(rental.due_at);
  return {
    ...rental,
    rented_at: Number.isFinite(rentedAt) ? rentedAt : null,
    due_at: Number.isFinite(due)
      ? due
      : (Number.isFinite(rentedAt) ? rentedAt + RENT_LIMIT_MS : null),
  };
}

const STATION_NAMES = Object.fromEntries(STATIONS.map((s) => [s.code, s.name]));
const STATION_BY_KEY = (() => {
  const map = Object.create(null);
  for (const s of STATIONS) {
    map[s.code.toUpperCase()] = s.code;
    if (s.qr) map[String(s.qr).toUpperCase()] = s.code;
  }
  return map;
})();
const STATION_QR = Object.fromEntries(STATIONS.map((s) => [s.code, s.qr || s.code]));
const $ = (id) => document.getElementById(id);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const doorSync = createDoorSync(localStorage);
/** 서보 0→90도에 대응하는 화면 각도. 진행률은 모터와 같이 직선이다. */
const DOOR_TURN = -70;
let activeMotion = null;
/** 같은 대여소 QR이 이 횟수만큼 연속으로 읽혀야 넘어간다. */
const QR_CONFIRM_HITS = 2;
/** 같은 잘못된 QR을 붙잡고 있을 때 경고가 너무 빨리 겹치지 않게만 한다. 스캔은 멈추지 않는다. */
const INVALID_TOAST_GAP_MS = 700;
/** 보드 자동닫힘 대기 (아두이노 OPEN_MAX ≈ 25s + 여유) */
const DOOR_SENSOR_TIMEOUT_MS = 45000;

const state = {
  user: null,
  station: "A1",
  slots: {},
  selected: null,
  openSlot: null,
  busy: false,
  returning: false,
  paying: false,
  tab: "home",
};

/** 반납 대기 중 수동 확인(우산을 넣었어요) resolve */
let returnWaitResolve = null;

function authHash() {
  const k = (location.hash || "").replace(/^#/, "").toLowerCase();
  return k === "signup" || k === "login" ? k : null;
}

function resolveStationKey(token) {
  if (!token) return null;
  return STATION_BY_KEY[String(token).trim().toUpperCase()] || null;
}

function readStationFromHash() {
  const k = (location.hash || "").replace(/^#/, "").toUpperCase();
  if (k === "SIGNUP" || k === "LOGIN") return null;
  return resolveStationKey(k);
}

/**
 * QR / URL / 입력에서 내부 station code(A1…) 추출
 * 인쇄용 고유번호(A1234…)와 내부 코드 모두 허용. 짧은 우연 매칭은 막음.
 */
function parseStationCode(raw) {
  const text = String(raw || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim();
  if (!text) return null;
  const upper = text.toUpperCase().replace(/\s+/g, "");

  const direct = resolveStationKey(upper);
  if (direct) return direct;

  try {
    const url = new URL(text, location.origin);
    const hash = (url.hash || "").replace(/^#/, "").toUpperCase();
    const fromHash = resolveStationKey(hash);
    if (fromHash) return fromHash;
    const q = (url.searchParams.get("station") || url.searchParams.get("code") || "").toUpperCase();
    const fromQ = resolveStationKey(q);
    if (fromQ) return fromQ;
    for (const p of url.pathname.split("/").filter(Boolean)) {
      const hit = resolveStationKey(p);
      if (hit) return hit;
    }
  } catch (_) {
    /* not a URL */
  }

  const tagged = upper.match(/(?:STATION|UMBRELLA|LOCKER)[=:/_-]?([A-Z][A-Z0-9]{3,7})/);
  if (tagged) {
    const hit = resolveStationKey(tagged[1]);
    if (hit) return hit;
  }

  // URL 조각 등에서 고유번호(문자+숫자 4~8)만 허용 — A1 같은 짧은 우연 매칭 방지
  const tokens = upper.match(/[A-Z][A-Z0-9]{3,7}/g) || [];
  for (const t of tokens) {
    const hit = resolveStationKey(t);
    if (hit) return hit;
  }
  return null;
}

function setTabbar(visible) {
  $("tabbar").hidden = !visible;
  // 탭바 표시 여부가 바뀌면 CTA 2/3 기준 높이도 다시 잡음
  requestAnimationFrame(() => updateUiScale());
  document.body.classList.toggle("no-tab", !visible);
}

/**
 * 등장/퇴장 모션. reserve=true 이면 레이아웃 자리를 유지해 중앙 UI가 안 밀림.
 */
function setMotion(el, visible, { reserve = false } = {}) {
  if (!el) return;
  el.classList.add("ui-motion");
  if (visible) {
    el.hidden = false;
    el.classList.remove("ui-out");
    void el.offsetWidth;
    el.classList.add("ui-in");
    el.setAttribute("aria-hidden", "false");
    if (el.tagName === "BUTTON") el.tabIndex = 0;
  } else {
    el.classList.remove("ui-in");
    el.classList.add("ui-out");
    el.setAttribute("aria-hidden", "true");
    if (el.tagName === "BUTTON") el.tabIndex = -1;
    if (!reserve) {
      const hide = () => {
        if (el.classList.contains("ui-out")) el.hidden = true;
      };
      el.addEventListener("transitionend", hide, { once: true });
      setTimeout(hide, 320);
    } else {
      el.hidden = false;
    }
  }
}

function syncPickActions() {
  const go = $("go");
  const tag = $("tagBtn");
  if (state.returning) {
    setMotion(go, false, { reserve: true });
    setMotion(tag, true, { reserve: true });
  } else {
    setMotion(go, true, { reserve: true });
    setMotion(tag, false, { reserve: true });
  }
}

function setTabActive(tab) {
  state.tab = tab;
  document.querySelectorAll(".tab").forEach((el) => {
    el.classList.toggle("on", el.dataset.tab === tab);
  });
}

/** 화면 스택 깊이 — 토스식 push/pop 방향 추론 */
const NAV_DEPTH = {
  "v-login": 0,
  "v-signup": 1,
  "v-home": 10,
  "v-settings": 10,
  "v-pay-list": 11,
  "v-pay": 12,
  "v-qr": 20,
  "v-map": 20,
  "v-code": 21,
  "v-pick": 31,
  "v-return-done": 40,
};
const TAB_ORDER = { "v-home": 0, "v-qr": 1, "v-settings": 2 };

let navBusy = false;
let navCleanupTimer = 0;

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** 설정/QR과 같은 짧은 탭 전환을 쓰는 화면 (로그인·지도 포함) */
const FAST_NAV_ORDER = {
  "v-login": 0,
  "v-signup": 1,
  "v-home": 2,
  "v-qr": 3,
  "v-map": 3,
  "v-settings": 4,
};

/** 아래에서 올라오는 풀스크린 (지도·QR·코드) */
const RISE_VIEWS = new Set(["v-qr", "v-map", "v-code"]);

function inferNavDir(fromId, toId) {
  if (!fromId || fromId === toId) return "none";
  const toRise = RISE_VIEWS.has(toId);
  const fromRise = RISE_VIEWS.has(fromId);
  // 홈 → QR/지도: 아래에서 위로. 나갈 땐 아래로 내려감
  if (toRise && !fromRise) return "rise";
  if (fromRise && !toRise) return "sink";
  if (fromRise && toRise) return "fade";
  // 설정 → 결제수단: 홈·설정과 같은 가로 stagger
  if (fromId === "v-settings" && (toId === "v-pay" || toId === "v-pay-list")) return "tab-right";
  if ((fromId === "v-pay" || fromId === "v-pay-list") && (toId === "v-settings" || toId === "v-home")) return "tab-left";
  if (fromId === "v-pay-list" && toId === "v-pay") return "tab-right";
  if (fromId === "v-pay" && toId === "v-pay-list") return "tab-left";
  // 반납 완료 → 홈: 설정→홈과 같은 탭 stagger
  if (toId === "v-home" && fromId === "v-return-done") return "tab-left";
  const tabFrom = TAB_ORDER[fromId];
  const tabTo = TAB_ORDER[toId];
  // 하단 탭(홈↔설정): 토스식 짧은 슬라이드
  if (tabFrom != null && tabTo != null) return tabTo > tabFrom ? "tab-right" : "tab-left";
  // 로그인↔홈 등
  if (fromId in FAST_NAV_ORDER && toId in FAST_NAV_ORDER) {
    const a = FAST_NAV_ORDER[fromId];
    const b = FAST_NAV_ORDER[toId];
    if (a === b) return "fade";
    return b > a ? "tab-right" : "tab-left";
  }
  const dFrom = NAV_DEPTH[fromId] ?? 0;
  const dTo = NAV_DEPTH[toId] ?? 0;
  if (dTo === dFrom) return "fade";
  return dTo > dFrom ? "push" : "pop";
}

const NAV_KEYS = {
  /* 마지막 stagger(640ms)+dur(400ms) ≈ 1040 */
  "tab-right": { enter: "enter-tab-right", leave: "leave-tab-right", ms: 1150 },
  "tab-left": { enter: "enter-tab-left", leave: "leave-tab-left", ms: 1150 },
  push: { enter: "enter-push", leave: "leave-push", ms: 400 },
  pop: { enter: "enter-pop", leave: "leave-pop", ms: 400 },
  fade: { enter: "enter-fade", leave: "leave-fade", ms: 340 },
  rise: { enter: "enter-rise", leave: "leave-rise", ms: 900 },
  sink: { enter: "enter-sink", leave: "leave-sink", ms: 420 },
};

function clearNavLayer(el) {
  if (!el) return;
  el.classList.remove("vt-from", "vt-to");
  el.removeAttribute("data-vt");
  el.removeAttribute("data-vt-run");
}

function forceNavCleanup() {
  if (navCleanupTimer) {
    clearTimeout(navCleanupTimer);
    navCleanupTimer = 0;
  }
  const main = document.querySelector("main");
  if (main) main.classList.remove("vt-busy");
  document.documentElement.removeAttribute("data-nav-dir");
  document.querySelectorAll(".view.vt-from, .view.vt-to").forEach((v) => {
    if (v.classList.contains("vt-from")) v.classList.remove("on");
    clearNavLayer(v);
  });
  navBusy = false;
}

function applyShowChrome(id, { tab, immersiveMode } = {}) {
  const shell = id === "v-home" || id === "v-settings";
  const authLogin = id === "v-login";
  const authSignup = id === "v-signup";
  // immersiveMode: "defer" = 전환 중 홈 레이아웃 유지 / "qr"|"map" = 닫힘 애니 동안 유지
  if (immersiveMode === "defer") {
    /* qr-open/map-open 아직 적용하지 않음 — main 폭·배경 흔들림 방지 */
  } else if (immersiveMode === "qr") {
    document.body.classList.add("qr-open");
    document.body.classList.remove("map-open", "code-open");
  } else if (immersiveMode === "map") {
    document.body.classList.add("map-open");
    document.body.classList.remove("qr-open", "code-open");
  } else if (immersiveMode === "code") {
    document.body.classList.add("code-open");
    document.body.classList.remove("qr-open", "map-open");
  } else {
    document.body.classList.toggle("qr-open", id === "v-qr");
    document.body.classList.toggle("map-open", id === "v-map");
    document.body.classList.toggle("code-open", id === "v-code");
  }
  document.body.classList.toggle("auth-login", authLogin);
  document.body.classList.toggle("auth-signup", authSignup);
  setTabbar(shell);
  // iOS Safari: 홈/설정은 보이는 뷰포트에 고정 (주소창 때문에 생기던 페이지 스크롤 차단)
  setShellScrollLock(shell);
  if (shell) setTabActive(tab || (id === "v-settings" ? "settings" : "home"));
  else if (id === "v-qr" || id === "v-code") setTabActive("qr");
}

function finishShow(id) {
  const immersive = id === "v-qr" || id === "v-code" || id === "v-map";
  if (!immersive) window.scrollTo(0, 0);
  // QR/코드/지도: 배율 재계산 생략 — 뷰포트·키보드와 겹치면 줌처럼 보임
  if (immersive) return;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => updateUiScale({ force: true }));
  });
}

/**
 * 토스식 화면 전환 (Promise — 지도 초기화 등은 전환 끝난 뒤)
 * - 탭·로그인·지도: 10% 슬라이드 + fade (≈200ms)
 * - 보관함 스택: 짧은 push/pop
 */
function closeVerifyForm() {
  const form = $("verifyForm");
  if (!form) return;
  form.hidden = true;
  const pw = $("verifyPw");
  const err = $("verifyErr");
  if (pw) pw.value = "";
  if (err) err.textContent = "";
}

function show(id, { tab, dir, instant } = {}) {
  if (state.paying && id !== "v-pick" && id !== "v-return-done") return Promise.resolve();
  if (id !== "v-settings") closeVerifyForm();
  const to = $(id);
  if (!to) return Promise.resolve();

  if (navBusy) forceNavCleanup();

  const from = document.querySelector(".view.on");

  if (from && from.id === id) {
    applyShowChrome(id, { tab });
    finishShow(id);
    return Promise.resolve();
  }

  const motionOff = instant || prefersReducedMotion();
  const navDir = motionOff ? "none" : (dir || inferNavDir(from && from.id, id));
  const keys = NAV_KEYS[navDir];

  // rise: 전환 끝날 때까지 immersive 클래스 지연 / sink: 내릴 동안 유지(패딩 점프 방지)
  // ※ main max-width는 항상 430px — 폭 확장 버그는 CSS에서 제거됨
  let immersiveMode;
  if (navDir === "rise") immersiveMode = "defer";
  else if (navDir === "sink" && from?.id === "v-qr") immersiveMode = "qr";
  else if (navDir === "sink" && from?.id === "v-map") immersiveMode = "map";
  else if (navDir === "sink" && from?.id === "v-code") immersiveMode = "code";
  applyShowChrome(id, { tab, immersiveMode });

  if (!from || navDir === "none" || !keys) {
    document.querySelectorAll(".view.on").forEach((v) => v.classList.remove("on"));
    to.classList.add("on");
    applyShowChrome(id, { tab });
    finishShow(id);
    return Promise.resolve();
  }

  const main = document.querySelector("main");
  navBusy = true;
  if (main) main.classList.add("vt-busy");
  document.documentElement.setAttribute("data-nav-dir", navDir);

  from.classList.add("vt-from");
  to.classList.add("on", "vt-to");
  from.setAttribute("data-vt", keys.leave);
  to.setAttribute("data-vt", keys.enter);

  // 두 프레임 뒤 재생 — 스타일 확정 후 GPU 레이어 생성, 첫 프레임 드랍 완화
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        from.setAttribute("data-vt-run", "1");
        to.setAttribute("data-vt-run", "1");

        let done = false;
        const cleanup = () => {
          if (done) return;
          done = true;
          if (navCleanupTimer) {
            clearTimeout(navCleanupTimer);
            navCleanupTimer = 0;
          }
          to.removeEventListener("animationend", onEnd);
          from.classList.remove("on");
          clearNavLayer(from);
          clearNavLayer(to);
          if (main) main.classList.remove("vt-busy");
          document.documentElement.removeAttribute("data-nav-dir");
          navBusy = false;
          // 전환 끝난 뒤에야 qr-open/map-open 확정 — 배경 레이아웃 흔들림 방지
          applyShowChrome(id, { tab });
          finishShow(id);
          resolve();
        };

        const onEnd = (e) => {
          // 뷰 자체의 슬라이드 애니만 — 자식 stagger animationend 는 무시
          if (e.target !== to) return;
          // tab 은 stagger가 더 길므로 타임아웃으로만 정리 (조기 cleanup 방지)
          if (navDir === "tab-right" || navDir === "tab-left") return;
          cleanup();
        };
        to.addEventListener("animationend", onEnd);
        const payStagger = id === "v-pay" || id === "v-pay-list";
        const cleanupMs = payStagger && (navDir === "tab-right" || navDir === "tab-left") ? 1560 : keys.ms;
        navCleanupTimer = setTimeout(cleanup, cleanupMs);
      });
    });
  });
}

function setMsg(text) {
  $("msg").textContent = text || "";
}

function syncUserChrome() {
  if (!state.user) return;
  $("homeWho").textContent = `${state.user.name}님, 안녕하세요`;
  $("setName").textContent = state.user.name;
  $("setSid").textContent = state.user.id;
  renderVerifyState();
  renderPayState();
  const place = STATION_NAMES[state.station] || state.station;
  const code = STATION_QR[state.station] || state.station;
  const placeEl = $("pickPlace");
  const codeEl = $("pickPlaceCode");
  if (placeEl) placeEl.textContent = place;
  if (codeEl) codeEl.textContent = `대여소 코드 ${code}`;

  const renting = !!(state.user.activeRental);
  const btn = $("homeRentBtn");
  const label = btn && btn.querySelector(".home-rent-label");
  const sub = btn && btn.querySelector(".home-rent-sub");
  if (btn) {
    btn.setAttribute("aria-label", renting ? "우산 반납하기" : "우산 대여하기");
    btn.classList.toggle("is-return", renting);
  }
  if (label) label.textContent = renting ? "우산 반납하기" : "우산 대여하기";
  if (sub) sub.textContent = renting ? "QR 스캔으로 반납" : "QR 스캔으로 시작";
}

/** 반납은 대여소가 달라도 가능 — 활성 대여만 있으면 반납 선택 모드 */
function hasActiveRental() {
  return !!(state.user && state.user.activeRental);
}

async function refreshInventory() {
  const inv = await getStationInventory(state.station);
  state.slots = inv.slots;
  if (state.user) {
    state.user.activeRental = await getMyActiveRental(state.user.uid);
    syncUserChrome();
  }
}

async function enterStation(code) {
  const station = parseStationCode(code);
  if (!station) {
    if ($("v-code").classList.contains("on")) {
      $("codeErr").textContent = "알 수 없는 대여소 코드예요.";
    } else {
      showQrToast("알 수 없는 대여소 코드예요.");
    }
    return;
  }
  state.station = station;
  location.hash = station;
  state.selected = null;
  state.openSlot = null;
  state.returning = false;
  state.busy = false;
  syncPickActions();
  setMsg("");
  syncUserChrome();
  try { await refreshInventory(); } catch (e) { setMsg(friendlyError(e)); }
  tick();
  render();
  show("v-pick");
}

function cleanStudentId(value) {
  return String(value || "").replace(/[\s\u200B-\u200D\uFEFF]/g, "");
}

async function login() {
  const studentId = cleanStudentId($("sid").value);
  const password = $("pw").value.replace(/[\u200B-\u200D\uFEFF]/g, "");
  $("loginErr").textContent = "";
  if (!/^\d{6,10}$/.test(studentId)) {
    $("loginErr").textContent = "학번은 숫자 6~10자리로 입력해 주세요.";
    return;
  }
  try {
    const res = await apiLogin({ studentId, password });
    applyUser(res);
    $("pw").value = "";
    const fromHash = readStationFromHash();
    if (fromHash) state.station = fromHash;
    if (authHash()) history.replaceState(null, "", location.pathname + location.search);
    syncUserChrome();
    tick();
    show("v-home", { tab: "home" });
  } catch (e) {
    $("loginErr").textContent = friendlyError(e);
  }
}

async function signupSubmit() {
  const studentId = cleanStudentId($("joinSid").value);
  const name = $("joinName").value.trim();
  const password = $("joinPw").value;
  const out = $("joinErr");
  out.className = "err";
  out.textContent = "";
  try {
    if (!/^\d{6,10}$/.test(studentId)) throw new Error("학번은 숫자 6~10자리로 입력해 주세요.");
    if (!name) throw new Error("이름을 입력해 주세요.");
    validatePassword(password);
    if (password !== $("joinPw2").value) throw new Error("비밀번호가 서로 달라요.");
    $("joinBtn").disabled = true;
    out.textContent = "가입 중이에요…";
    await signup({ studentId, name, password });
    out.className = "ok";
    out.textContent = "가입 완료! 로그인해주세요.";
    $("sid").value = studentId;
    $("pw").value = "";
    ["joinSid", "joinName", "joinPw", "joinPw2"].forEach((id) => { $(id).value = ""; });
    setTimeout(() => {
      location.hash = "login";
      show("v-login");
      $("pw").focus();
    }, 700);
  } catch (e) {
    out.className = "err";
    out.textContent = friendlyError(e);
  } finally {
    $("joinBtn").disabled = false;
  }
}

function showAuth(which) {
  if (state.user) return;
  if (which === "signup") {
    location.hash = "signup";
    show("v-signup");
  } else {
    location.hash = "login";
    show("v-login");
  }
}

async function logout() {
  await closeQrCamera();
  try { await logoutUser(); } catch (_) {}
  Object.assign(state, {
    user: null, selected: null, openSlot: null, returning: false, busy: false, tab: "home",
  });
  syncPickActions();
  setTabbar(false);
  history.replaceState(null, "", location.pathname + location.search);
  show("v-login");
}

/** 대여: 보관중(in)만 / 반납: 비어있는 칸(out)만 */
function slotLabel(i, returning) {
  if (i > MAX_HW_SLOT) return "준비중";
  const s = state.slots[i];
  if (returning) {
    if (s === "out") return "비어있음";
    if (s === "in") return "보관중";
    return "반납 불가";
  }
  if (s === "in") return "보관중";
  if (s === "out") return "대여중";
  return "없음";
}

function doorEl(slot) {
  return document.querySelector(`.door[data-slot="${slot}"]`);
}

function render() {
  const isReturnPick = hasActiveRental(); // 활성 대여면 반납 모드 (대여소 무관)
  const cab = $("cab");
  cab.innerHTML = "";
  $("pickTitle").textContent = isReturnPick ? "우산 반납" : "우산 번호 선택";
  $("pickDesc").textContent = isReturnPick
    ? "비어 있는 칸을 골라 우산을 넣어 주세요."
    : `1~${MAX_HW_SLOT}번 칸만 하드웨어와 연결돼 있어요.`;

  const locked = !!(state.busy || state.returning);
  for (let i = 1; i <= TOTAL_SLOTS; i++) {
    const hw = i <= MAX_HW_SLOT;
    const status = state.slots[i];
    // 대여: 보관중(in) / 반납: 비어있음(out) — 반납 시 보관중 칸도 탭해 안내 가능
    const canAct = hw && (isReturnPick ? status === "out" : status === "in");
    const canTap = hw && !locked && (isReturnPick ? (status === "out" || status === "in") : canAct);
    const wrap = document.createElement("div");
    wrap.className = "door-wrap";
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.slot = String(i);
    const tone = !hw ? "door-prep" : canAct ? "door-hot" : "door-idle";
    b.className = [
      "door",
      tone,
      state.selected === i ? "sel" : "",
      state.openSlot === i ? "open" : "",
      locked ? "door-locked" : "",
    ].filter(Boolean).join(" ");
    // prep만 native disabled — 반납 빈 칸이 disabled에 묶이지 않게
    b.disabled = !hw;
    if (!canTap) b.setAttribute("aria-disabled", "true");
    else b.removeAttribute("aria-disabled");
    const label = slotLabel(i, isReturnPick);
    b.setAttribute("aria-label", `${i}번 ${label}`);
    b.innerHTML = `<span class="n">${i}</span><span class="t">${label}</span>`;
    b.onclick = (ev) => {
      ev.preventDefault();
      if (!hw || locked) return;
      if (isReturnPick) {
        // 반납: out만 선택, in은 안내만 (클릭은 먹어야 함)
        if (status !== "out" && status !== "in") return;
        state.selected = status === "out" ? i : null;
        setMsg(status === "out" ? "" : "이 칸에는 이미 우산이 있어 반납할 수 없어요.");
        render();
        return;
      }
      if (!canAct) return;
      state.selected = i;
      setMsg("");
      render();
    };
    wrap.appendChild(b);
    cab.appendChild(wrap);
  }

  const g = $("go");
  const sel = state.selected;
  const selCanReturn = sel && state.slots[sel] === "out";
  const selCanRent = sel && state.slots[sel] === "in";
  if (isReturnPick) {
    g.disabled = !sel || state.busy || state.returning || !selCanReturn;
    g.textContent = !sel
      ? "번호를 선택해 주세요"
      : selCanReturn
        ? `${sel}번 문 열고 반납하기`
        : "반납할 수 없는 칸이에요";
  } else {
    g.disabled = !sel || state.busy || state.returning || !selCanRent;
    g.textContent = sel ? `${sel}번 우산 대여하기` : "번호를 선택해 주세요";
  }
  syncPickActions();
}

function listenForDoor(station, onRows) {
  try {
    return watchDeviceEvents(station, onRows) || (() => {});
  } catch (_) {
    return () => {};
  }
}

function waitForMatching(station, slot, sinceMs, commandId, match, timeoutMs, onBatch) {
  return new Promise((resolve) => {
    let settled = false;
    let stop = () => {};
    const finish = (ev) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { stop(); } catch (_) { /* ignore */ }
      resolve(ev || null);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    stop = listenForDoor(station, (rows) => {
      if (typeof onBatch === "function") onBatch(rows);
      const ev = pickMatchingEvent(rows, { station, slot, since: sinceMs, commandId, match });
      if (ev) finish(ev);
    });
  });
}

/** 서보 시작 이벤트. 없으면 null. 화면이 먼저 열렸다고 말하지 않기 위한 확인 */
function waitForServoStart(station, slot, sinceMs, commandId, action) {
  return waitForMatching(
    station, slot, sinceMs, commandId,
    (ev) => isServoStarted(ev, action),
    15000
  );
}

/** 대여: 이번 commandId 의 닫힘만 인정. 타임아웃 이벤트는 성공이 아니다. */
function waitForRentDoorClose(station, slot, sinceMs, commandId, onBatch) {
  return waitForMatching(station, slot, sinceMs, commandId, isRentDoorSettled, DOOR_SENSOR_TIMEOUT_MS, onBatch)
    .then((ev) => {
      if (!ev) return { how: "unknown", ev: null };
      return { how: isRentDoorTimeout(ev) ? "timeout" : "sensor", ev };
    });
}

/**
 * 반납: RFID+IR 인식(return_ok) 후 보드 자동닫힘(auto_close_return)까지 대기.
 * 수동 「우산을 넣었어요」는 보드 없이 닫기 위한 폴백.
 */
function waitForReturnDoorClose(station, slot, sinceMs, commandId, onBatch) {
  return new Promise((resolve) => {
    let settled = false;
    let sawReturnOk = false;
    let stop = () => {};
    const finish = (how, ev) => {
      if (settled) return;
      settled = true;
      returnWaitResolve = null;
      clearTimeout(timer);
      try { stop(); } catch (_) { /* ignore */ }
      resolve({ how, ev: ev || null });
    };
    returnWaitResolve = () => finish("manual", null);
    const timer = setTimeout(() => finish("unknown", null), DOOR_SENSOR_TIMEOUT_MS);
    stop = listenForDoor(station, (rows) => {
      if (typeof onBatch === "function") onBatch(rows);
      if (!sawReturnOk && pickMatchingEvent(rows, {
        station, slot, since: sinceMs, commandId, match: isReturnDetected,
      })) {
        sawReturnOk = true;
        setMsg("우산이 인식됐어요. 문이 닫힐 때까지 기다려 주세요.");
      }
      const closed = pickMatchingEvent(rows, {
        station, slot, since: sinceMs, commandId, match: isReturnDoorSettled,
      });
      if (!closed) return;
      finish(isReturnDoorTimeout(closed) ? "timeout" : "sensor", closed);
    });
  });
}

function servoAction(row) {
  return String((row && row.payload && row.payload.action) || "");
}

/** 이미 구독 중인 이벤트에서만 연다. 보정용 통신을 따로 열지 않는다. */
function applyLead(rows, note) {
  if (!note) return;
  const ev = pickMatchingEvent(rows, {
    station: note.station,
    slot: note.slot,
    commandId: note.commandId,
    match: (row) => row && row.kind === "servo" && (servoAction(row) === "open" || servoAction(row) === "open_return"),
  });
  if (!ev) return;
  const next = doorSync.observe(ev, {
    recvAt: Date.now(),
    offset: note.offset,
    rtt: note.rtt,
    commandAt: note.commandAt,
    commandId: note.commandId,
    role: "lead",
  });
  if (next && activeMotion) activeMotion.retarget(next);
}

/** 서보와 같은 속도로 그린다. 모터보다 앞서 있으면 늦추지 않고, 뒤처지면 앞으로 당긴다. */
function trackDoor(el, fromDeg, toDeg, plan) {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.classList.add("is-synced");
  el.classList.remove("opening", "closing", "open");
  el.style.transition = "none";
  let startAt = plan.startAt;
  let moveMs = Math.max(1, plan.moveMs || 1);
  let finished = false;
  const at = (now) => Math.max(0, Math.min(1, (now - startAt) / moveMs));
  const apply = (p) => {
    el.style.transform = `rotateY(${fromDeg + (toDeg - fromDeg) * p}deg)`;
  };
  const retarget = (next) => {
    if (!next || finished) return;
    const now = Date.now();
    const nextMove = Math.max(1, next.moveMs || moveMs);
    const motorP = Math.max(0, Math.min(1, (now - next.startAt) / nextMove));
    if (motorP + 0.02 < at(now)) return;
    startAt = next.startAt;
    moveMs = nextMove;
  };
  const done = new Promise((resolve) => {
    if (reduce || at(Date.now()) >= 1) {
      apply(1);
      finished = true;
      resolve();
      return;
    }
    const frame = () => {
      if (finished) return;
      const p = at(Date.now());
      apply(p);
      if (p >= 0.999) {
        apply(1);
        finished = true;
        resolve();
        return;
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  return { done, retarget };
}

function settleDoor(el, open) {
  if (!el) return;
  el.classList.remove("is-synced", "opening", "closing");
  el.style.transition = "none";
  el.style.transform = "";
  el.classList.toggle("open", !!open);
  requestAnimationFrame(() => {
    if (el.isConnected) el.style.transition = "";
  });
}

function motionNote(res, sentAt) {
  const note = doorSync.noteRoundTrip({
    sentAt,
    recvAt: Date.now(),
    serverNow: res && res.serverNow,
    commandAt: res && res.commandAt,
  });
  note.station = state.station;
  note.slot = state.selected;
  note.commandId = res && res.id != null ? String(res.id) : "";
  return note;
}

async function playDoorOpen(slot, note) {
  state.openSlot = slot;
  let el = doorEl(slot);
  if (!el) {
    render();
    el = doorEl(slot);
  }
  if (!el) return;
  const plan = note ? doorSync.planLead(note) : doorSync.planFollow(Date.now());
  const motion = trackDoor(el, 0, DOOR_TURN, plan);
  activeMotion = motion;
  try {
    await motion.done;
  } finally {
    if (activeMotion === motion) activeMotion = null;
    settleDoor(el, true);
  }
}

async function playDoorClose(slot, ev, note) {
  const el = doorEl(slot);
  if (!el) {
    state.openSlot = null;
    return;
  }
  const ctx = {
    recvAt: Date.now(),
    offset: note && note.offset,
    rtt: note && note.rtt,
    commandId: note && note.commandId,
    role: "follow",
  };
  const plan = ev ? (doorSync.observe(ev, ctx) || doorSync.planFollow(Date.now())) : doorSync.planFollow(Date.now());
  const motion = trackDoor(el, DOOR_TURN, 0, plan);
  try {
    await motion.done;
  } finally {
    settleDoor(el, false);
    state.openSlot = null;
  }
}

async function go() {
  if (!state.selected || state.busy) return;
  const slot = state.selected;
  const isReturn = hasActiveRental();
  if (isReturn && state.slots[slot] !== "out") {
    setMsg("이 칸에는 이미 우산이 있어 반납할 수 없어요.");
    render();
    return;
  }
  const params = { station: state.station, slot, studentId: state.user.id, uid: state.user.uid };

  state.busy = true;
  setMsg(isReturn ? "반납을 처리하는 중…" : "대여를 처리하는 중…");
  render();

  let returnUiDone = false;
  try {
    if (isReturn) {
      const openedAt = Date.now();
      const rentalSnap = state.user.activeRental;
      const ret = await returnUmbrella(params);
      const note = motionNote(ret, openedAt);
      const cmdId = ret && ret.id;
      state.returning = true;
      state.busy = false;
      syncPickActions();
      setMsg(`${slot}번 문을 열어요. 우산을 걸어 넣어 주세요.`);
      const closePromise = waitForReturnDoorClose(state.station, slot, openedAt, cmdId, (rows) => applyLead(rows, note));
      await playDoorOpen(slot, note);
      render();

      const closed = await closePromise;
      const how = closed.how;
      if (how === "sensor") setMsg("문이 닫히는 중이에요…");
      else if (how === "manual") setMsg("확인됐어요. 문을 닫을게요.");
      else if (how === "timeout") setMsg("시간 안에 반납이 확인되지 않아 문이 닫혔어요. 반납 기록은 남아 있어요.");
      else setMsg("보드가 반납 완료를 확인하지 못했어요. 반납 기록은 남아 있어요.");

      if (how === "sensor" || how === "manual") await playDoorClose(slot, closed.ev, note);
      state.returning = false;
      syncPickActions();
      state.busy = false;
      state.selected = null;
      returnWaitResolve = null;
      if (how === "sensor" || how === "manual") {
        setMsg("");
        const returnedAt = Date.now();
        const fee = returnOverdueFee(rentalSnap, returnedAt);
        let paid = null;
        if (fee > 0) {
          state.paying = true;
          try {
            paid = await askOverduePayment(fee);
          } finally {
            state.paying = false;
          }
        }
        state.user.activeRental = null;
        try { await refreshInventory(); } catch (_) {}
        showReturnDone({
          rental: rentalSnap,
          returnStation: state.station,
          returnSlot: slot,
          returnedAt,
          fee: paid ? fee : 0,
          paymentMethod: paid,
        });
      } else {
        state.user.activeRental = null;
        try { await refreshInventory(); } catch (_) {}
      }
      returnUiDone = true;
    } else {
      const sentAt = Date.now();
      const r = await rentUmbrella(params);
      const note = motionNote(r, sentAt);
      state.user.activeRental = {
        rentalId: r.rentalId, station: state.station, slot,
        rented_at: r.rented_at, due_at: r.due_at,
      };
      const openedAt = sentAt;
      const cmdId = r && r.id;
      setMsg(`${slot}번 문을 열어요. 우산을 꺼내 주세요.`);
      render();
      const closePromise = waitForRentDoorClose(state.station, slot, openedAt, cmdId, (rows) => applyLead(rows, note));
      await playDoorOpen(slot, note);

      const closed = await closePromise;
      const how = closed.how;
      if (how === "sensor") setMsg("우산을 꺼냈어요. 문이 닫히는 중이에요…");

      if (how === "sensor") await playDoorClose(slot, closed.ev, note);
      await refreshInventory();
      state.busy = false;
      state.selected = null;
      returnWaitResolve = null;
      tick();
      syncUserChrome();
      goTab("home");
      if (how === "timeout") setMsg("시간 안에 우산이 확인되지 않아 문이 닫혔어요. 대여 기록은 남아 있어요.");
      else if (how !== "sensor") setMsg("보드가 대여 완료를 확인하지 못했어요. 대여 기록은 남아 있어요.");
      returnUiDone = true;
    }
  } catch (e) {
    state.openSlot = null;
    state.returning = false;
    setMsg(friendlyError(e));
  } finally {
    state.busy = false;
    state.selected = null;
    returnWaitResolve = null;
    if (!returnUiDone) {
      tick();
      render();
    } else {
      tick();
      syncUserChrome();
    }
  }
}

function showReturnDone({ rental, returnStation, returnSlot, returnedAt, fee, paymentMethod }) {
  const rentedAt = rental && rental.rented_at ? Number(rental.rented_at) : null;
  const endedAt = returnedAt || Date.now();
  const usedMs = rentedAt ? Math.max(0, endedAt - rentedAt) : null;
  const place = STATION_NAMES[returnStation] || STATION_QR[returnStation] || returnStation || "-";
  const qr = STATION_QR[returnStation] || returnStation || "";

  $("returnDoneDuration").textContent = usedMs != null ? fmt(usedMs) : "-";
  $("returnDonePlace").textContent = qr ? `${place} (${qr})` : place;
  $("returnDoneSlot").textContent = returnSlot ? `${returnSlot}번 칸` : "-";
  $("returnDoneAt").textContent = new Date(endedAt).toLocaleString("ko-KR", {
    month: "long", day: "numeric", hour: "numeric", minute: "2-digit",
  });
  const feeRow = $("returnDoneFeeRow");
  if (feeRow) {
    if (fee > 0) {
      feeRow.hidden = false;
      const label = paymentMethodLabel(paymentMethod);
      $("returnDoneFee").textContent = label
        ? `${fee.toLocaleString("ko-KR")}원 · ${label}`
        : `${fee.toLocaleString("ko-KR")}원`;
    } else {
      feeRow.hidden = true;
      $("returnDoneFee").textContent = "";
    }
  }

  show("v-return-done");
}

function returnOverdueFee(rental, returnedAt) {
  if (!rental) return 0;
  const due = Number(rental.due_at) || (Number(rental.rented_at) + RENT_LIMIT_MS);
  if (!due) return 0;
  return overdueFeeWon(returnedAt - due);
}

function digitsOnly(value, max) {
  const digits = String(value || "").replace(/\D/g, "");
  return max ? digits.slice(0, max) : digits;
}

function formatCardNumber(value) {
  return digitsOnly(value, 16).replace(/(\d{4})(?=\d)/g, "$1 ").trim();
}

function formatExpiry(value) {
  const digits = digitsOnly(value, 4);
  if (digits.length <= 2) return digits;
  return `${digits.slice(0, 2)}/${digits.slice(2)}`;
}

function formatPanGroups(value) {
  const digits = digitsOnly(value, 16);
  return [0, 1, 2, 3].map((i) => (digits.slice(i * 4, i * 4 + 4) + "••••").slice(0, 4)).join("  ");
}

function formatExpiryLabel(value) {
  const digits = digitsOnly(value, 4);
  if (digits.length < 2) return "MM/YY";
  return `${digits.slice(0, 2)}/${digits.slice(2) || "YY"}`;
}

function readPayFields(prefix) {
  return {
    issuer: ($(`${prefix}Issuer`) && $(`${prefix}Issuer`).value) || "",
    nickname: ($(`${prefix}Nickname`) && $(`${prefix}Nickname`).value.trim()) || "",
    number: digitsOnly($(`${prefix}Number`).value, 16),
    expiry: digitsOnly($(`${prefix}Expiry`).value, 4),
    cvc: digitsOnly($(`${prefix}Cvc`).value, 4),
    pw2: digitsOnly($(`${prefix}Pw2`).value, 2),
    registeredAt: Date.now(),
  };
}

function selectIssuer(prefix, name, { scroll } = {}) {
  const picked = CARD_ISSUERS.includes(name) ? name : CARD_ISSUERS[0];
  const hidden = $(`${prefix}Issuer`);
  if (hidden) hidden.value = picked;
  const box = $(`${prefix}Issuers`);
  if (!box) return picked;
  box.querySelectorAll(".pg-issuer").forEach((el) => {
    const on = el.dataset.issuer === picked;
    el.classList.toggle("on", on);
    el.setAttribute("aria-selected", on ? "true" : "false");
    if (on) {
      const left = el.offsetLeft - Math.max(0, (box.clientWidth - el.offsetWidth) / 2);
      box.scrollTo({ left: Math.max(0, left), behavior: scroll ? "smooth" : "auto" });
    }
  });
  return picked;
}

function mountIssuers(prefix) {
  const box = $(`${prefix}Issuers`);
  if (!box || box.childElementCount) return;
  box.innerHTML = CARD_ISSUERS.map((name) =>
    `<button type="button" class="pg-issuer" data-issuer="${name}" role="option">${name}</button>`
  ).join("");
  box.onclick = (event) => {
    const btn = event.target.closest(".pg-issuer");
    if (!btn) return;
    selectIssuer(prefix, btn.dataset.issuer, { scroll: true });
    paintPayCard(prefix === "pay" ? "payCard" : "charge", readPayFields(prefix));
  };
  selectIssuer(prefix, CARD_ISSUERS[0]);
}

function fillPayFields(prefix, pay) {
  const issuer = pay ? (pay.issuer || pay.brand || "") : "";
  const nickname = pay && pay.nickname && pay.nickname !== issuer ? pay.nickname : "";
  $(`${prefix}Nickname`).value = nickname;
  $(`${prefix}Number`).value = pay ? formatCardNumber(pay.number) : "";
  $(`${prefix}Expiry`).value = pay ? formatExpiry(pay.expiry) : "";
  $(`${prefix}Cvc`).value = pay ? pay.cvc : "";
  $(`${prefix}Pw2`).value = pay ? pay.pw2 : "";
  selectIssuer(prefix, pay && (pay.issuer || pay.brand));
}

function paintPayCard(prefix, fields = {}) {
  const pan = $(`${prefix}Pan`);
  const brandEl = $(`${prefix}Brand`);
  const nameEl = $(`${prefix}Name`);
  const expEl = $(`${prefix}Exp`);
  const nickname = String(fields.nickname || "").trim();
  if (pan) pan.textContent = formatPanGroups(fields.number);
  if (brandEl) brandEl.textContent = fields.issuer || fields.brand || "카드사";
  if (nameEl) nameEl.textContent = nickname || (state.user && state.user.name) || "학생";
  if (expEl) expEl.textContent = formatExpiryLabel(fields.expiry);
}

function renderPayState() {
  const el = $("setPayState");
  const missing = !(state.user && state.user.paymentMethods && state.user.paymentMethods.length);
  if (el) {
    el.hidden = !missing;
    el.textContent = missing ? "미등록" : "";
    el.classList.toggle("warn", missing);
    el.classList.remove("ok");
  }
  const btn = $("paySubmit");
  if (btn && !btn.disabled) btn.textContent = "등록하기";
}

function openPayForm() {
  if (!state.user) return;
  fillPayFields("pay", null);
  $("payErr").textContent = "";
  const hasList = (state.user.paymentMethods || []).length > 0;
  $("payBack").textContent = hasList ? "← 결제수단" : "← 설정";
  paintPayCard("payCard", readPayFields("pay"));
  renderPayState();
  show("v-pay");
}

function payText(value) {
  return String(value || "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

function sortedPaymentMethods() {
  const methods = [...(state.user && state.user.paymentMethods || [])];
  const def = state.user && state.user.defaultPaymentId;
  methods.sort((a, b) => (a.id === def ? -1 : b.id === def ? 1 : 0));
  return methods;
}

function renderPayList() {
  const box = $("payList");
  if (!box || !state.user) return;
  const methods = sortedPaymentMethods();
  box.innerHTML = methods.map((item, index) => {
    const on = item.id === state.user.defaultPaymentId;
    const sub = item.nickname && item.nickname !== item.issuer ? item.issuer : "";
    return `<div class="pay-swipe vt-stagger" data-stagger="${index + 2}" data-id="${payText(item.id)}">
      <button type="button" class="pay-swipe-delete" tabindex="-1" aria-label="삭제">
        <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M9 3.5h6l.7 1.5H20v2H4v-2h4.3L9 3.5zM6.2 9h11.6l-.7 11.1A2 2 0 0 1 15.1 22H8.9a2 2 0 0 1-2-1.9L6.2 9z"/></svg>
      </button>
      <button type="button" class="pay-list-item${on ? " on" : ""}">
        <span class="pay-list-copy">
          <strong>${payText(paymentMethodLabel(item))}</strong>
          ${sub ? `<span class="pay-list-sub">${payText(sub)}</span>` : ""}
        </span>
        <span class="${on ? "pay-list-badge" : "pay-list-set"}">${on ? "기본" : "기본으로"}</span>
      </button>
    </div>`;
  }).join("");
  const add = $("payAdd");
  if (add) add.dataset.stagger = String(methods.length + 2);
  closePaySwipes(box);
}

function paySwipeOffset(row) {
  const item = row && row.querySelector(".pay-list-item");
  if (!item) return 0;
  const match = /translate3d\((-?\d+(?:\.\d+)?)px/.exec(item.style.transform || "");
  return match ? Number(match[1]) : 0;
}

function setPaySwipe(row, x, animate) {
  const item = row.querySelector(".pay-list-item");
  const del = row.querySelector(".pay-swipe-delete");
  if (!item || !del) return;
  const revealed = Math.max(0, -x);
  const progress = Math.min(1, revealed / PAY_SWIPE_OPEN);
  const scale = 0.28 + 0.72 * progress;
  item.style.transition = animate ? "" : "none";
  del.style.transition = animate ? "" : "none";
  item.style.transform = `translate3d(${x}px,0,0)`;
  del.style.transform = `translateY(-50%) scale(${scale})`;
  del.style.opacity = String(Math.min(1, progress * 1.2));
  del.classList.toggle("is-ready", revealed > 36);
}

function closePaySwipes(box, except) {
  (box || $("payList")).querySelectorAll(".pay-swipe").forEach((row) => {
    if (row !== except) setPaySwipe(row, 0, true);
  });
}

const PAY_SWIPE_OPEN = 72;

function bindPaySwipe() {
  const box = $("payList");
  if (!box || box.dataset.swipe) return;
  box.dataset.swipe = "1";
  let drag = null;
  let suppressClick = false;

  box.addEventListener("pointerdown", (event) => {
    const row = event.target.closest(".pay-swipe");
    if (!row || event.target.closest(".pay-swipe-delete")) return;
    closePaySwipes(box, row);
    drag = {
      row,
      x: event.clientX,
      y: event.clientY,
      start: paySwipeOffset(row),
      pid: event.pointerId,
      axis: null,
      moved: false,
    };
    row.classList.add("is-dragging");
  });

  box.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pid) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.axis) {
      if (Math.hypot(dx, dy) < 8) return;
      drag.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      if (drag.axis === "y") {
        drag.row.classList.remove("is-dragging");
        drag = null;
        return;
      }
    }
    if (drag.axis !== "x") return;
    drag.moved = true;
    let next = drag.start + dx;
    if (next > 0) next *= 0.18;
    const limit = -Math.min(drag.row.offsetWidth * 0.72, 220);
    if (next < limit) next = limit + (next - limit) * 0.22;
    setPaySwipe(drag.row, next, false);
  });

  const endDrag = (event) => {
    if (!drag || (event && event.pointerId !== drag.pid)) return;
    const row = drag.row;
    row.classList.remove("is-dragging");
    const x = paySwipeOffset(row);
    const open = drag.moved && x < -PAY_SWIPE_OPEN * 0.42;
    setPaySwipe(row, open ? -PAY_SWIPE_OPEN : 0, true);
    if (drag.moved) suppressClick = true;
    drag = null;
  };
  box.addEventListener("pointerup", endDrag);
  box.addEventListener("pointercancel", endDrag);

  box.addEventListener("click", async (event) => {
    if (suppressClick) {
      suppressClick = false;
      event.preventDefault();
      return;
    }
    const del = event.target.closest(".pay-swipe-delete");
    if (del) {
      const id = del.closest(".pay-swipe").dataset.id;
      openPayDelete(id);
      return;
    }
    const item = event.target.closest(".pay-list-item");
    if (!item || !state.user) return;
    const row = item.closest(".pay-swipe");
    if (row && paySwipeOffset(row) < -8) {
      setPaySwipe(row, 0, true);
      return;
    }
    const id = row && row.dataset.id;
    if (!id || id === state.user.defaultPaymentId) return;
    try {
      await storePaymentWallet(state.user.paymentMethods, id);
      renderPayList();
    } catch (ex) {
      const err = $("payListErr");
      if (err) err.textContent = ex.message || "기본 결제수단을 바꾸지 못했어요.";
    }
  });
}

function openPayDelete(id) {
  const dialog = $("payDelete");
  if (!dialog) return;
  dialog.dataset.id = id;
  dialog.hidden = false;
  requestAnimationFrame(() => dialog.classList.add("is-in"));
}

function closePayDelete() {
  const dialog = $("payDelete");
  if (!dialog) return;
  dialog.classList.remove("is-in");
  dialog.hidden = true;
}

async function confirmPayDelete() {
  const dialog = $("payDelete");
  const id = dialog && dialog.dataset.id;
  closePayDelete();
  if (!id || !state.user) return;
  const methods = (state.user.paymentMethods || []).filter((item) => item.id !== id);
  let defaultId = state.user.defaultPaymentId;
  if (!methods.some((item) => item.id === defaultId)) defaultId = methods[0] ? methods[0].id : "";
  try {
    await storePaymentWallet(methods, defaultId);
    if (!methods.length) show("v-settings", { tab: "settings" });
    else renderPayList();
  } catch (ex) {
    const err = $("payListErr");
    if (err) err.textContent = ex.message || "결제수단을 삭제하지 못했어요.";
    renderPayList();
  }
}
function openPayList() {
  if (!state.user) return;
  renderPayList();
  show("v-pay-list");
}

function openPayments() {
  if (!state.user) return;
  if ((state.user.paymentMethods || []).length) openPayList();
  else openPayForm();
}

async function storePaymentWallet(methods, defaultPaymentId) {
  if (methods.length > 5) throw new Error("결제수단은 5개까지 등록할 수 있어요.");
  const saved = await savePaymentWallet({ paymentMethods: methods, defaultPaymentId });
  state.user.paymentMethods = saved.paymentMethods;
  state.user.defaultPaymentId = saved.defaultPaymentId;
  state.user.paymentMethod = saved.paymentMethod;
  renderPayState();
  return saved;
}

function bindPayTyping(prefix, cardPrefix) {
  const number = $(`${prefix}Number`);
  const expiry = $(`${prefix}Expiry`);
  const cvc = $(`${prefix}Cvc`);
  const pw2 = $(`${prefix}Pw2`);
  const nickname = $(`${prefix}Nickname`);
  const paint = () => paintPayCard(cardPrefix, readPayFields(prefix));
  number.oninput = () => {
    number.value = formatCardNumber(number.value);
    paint();
  };
  expiry.oninput = () => {
    expiry.value = formatExpiry(expiry.value);
    paint();
  };
  if (nickname) nickname.oninput = paint;
  cvc.oninput = () => { cvc.value = digitsOnly(cvc.value, 4); };
  pw2.oninput = () => { pw2.value = digitsOnly(pw2.value, 2); };
}

function askOverduePayment(fee) {
  const overlay = $("payOverlay");
  const form = $("payOverlayForm");
  const err = $("payOverlayErr");
  const btn = $("payOverlaySubmit");
  const amount = `${fee.toLocaleString("ko-KR")}원`;
  $("payTitle").textContent = amount;
  err.textContent = "";
  btn.disabled = false;
  fillPayFields("payOverlay", null);

  const paint = () => {
    const saved = state.user && state.user.paymentMethod;
    const has = !!paymentMethodLabel(saved);
    const fields = has ? saved : readPayFields("payOverlay");
    paintPayCard("charge", fields);
    form.hidden = has;
    const fine = $("payOverlayFine");
    if (fine) fine.textContent = has ? "기본 결제수단으로 결제해요." : "카드를 등록하면 이 금액이 결제돼요.";
    btn.textContent = has ? `${amount} 결제하기` : "등록하고 결제하기";
  };
  paint();
  bindPayTyping("payOverlay", "charge");
  const tall = !paymentMethodLabel(state.user && state.user.paymentMethod);
  overlay.classList.toggle("is-tall", tall);
  overlay.hidden = false;
  overlay.classList.remove("is-in");
  requestAnimationFrame(() => {
    void overlay.offsetWidth;
    overlay.classList.add("is-in");
  });

  const hideOverlay = () => new Promise((done) => {
    overlay.classList.remove("is-in");
    const sheet = overlay.querySelector(".pay-checkout");
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      overlay.hidden = true;
      overlay.classList.remove("is-tall");
      done();
    };
    if (sheet) {
      const onEnd = (event) => {
        if (event.target !== sheet) return;
        sheet.removeEventListener("transitionend", onEnd);
        finish();
      };
      sheet.addEventListener("transitionend", onEnd);
    }
    setTimeout(finish, 520);
  });

  return new Promise((resolve) => {
    btn.onclick = async () => {
      err.textContent = "";
      const registering = !paymentMethodLabel(state.user && state.user.paymentMethod);
      const fields = registering ? readPayFields("payOverlay") : null;
      const issue = fields ? paymentMethodIssue(fields) : "";
      if (issue) {
        err.textContent = issue;
        return;
      }
      btn.disabled = true;
      try {
        if (fields) {
          const card = { ...fields, id: newPaymentId(), registeredAt: Date.now() };
          const methods = [...(state.user.paymentMethods || []), card];
          await storePaymentWallet(methods, state.user.defaultPaymentId || card.id);
          paint();
        }
        btn.textContent = "결제 중…";
        await wait(1100);
        const paid = state.user.paymentMethod;
        btn.onclick = null;
        await hideOverlay();
        resolve(paid);
      } catch (ex) {
        err.textContent = ex.message || "결제에 실패했어요.";
        btn.disabled = false;
        paint();
      }
    };
  });
}

function fmt(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const c = s % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(c).padStart(2, "0")}`;
}

function syncTimerSlot(slotId, timerId, forceShow) {
  const slotEl = $(slotId);
  const timer = $(timerId);
  if (!slotEl || !timer) return;
  const show = forceShow || (timer && !timer.hidden && !slotEl.classList.contains("is-leaving"));
  if (show) slotEl.classList.add("has-timer");
  else if (!slotEl.classList.contains("is-leaving")) slotEl.classList.remove("has-timer");
}

function tick() {
  const r = state.user && state.user.activeRental;
  document.querySelectorAll(".timer").forEach((el) => {
    if (!r) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.classList.remove("is-return-done");
    const due = r.due_at || r.rented_at + RENT_LIMIT_MS;
    const left = due - Date.now();
    const over = left < 0;
    const overdueMs = over ? Math.abs(left) : 0;
    const fee = overdueFeeWon(overdueMs);
    el.classList.toggle("over", over);
    el.querySelector(".tl").textContent = over ? "반납 기한이 지났어요" : "남은 대여시간";
    el.querySelector(".tv").textContent = (over ? "+" : "") + fmt(Math.abs(left));
    const tf = el.querySelector(".tf");
    if (tf) {
      if (over && fee > 0) {
        tf.hidden = false;
        tf.textContent = `예상 추가요금 ${fee.toLocaleString("ko-KR")}원`;
      } else {
        tf.hidden = true;
        tf.textContent = "";
      }
    }
    const bar = el.querySelector(".bar i");
    if (bar) bar.style.width = `${Math.max(0, Math.min(100, (left / RENT_LIMIT_MS) * 100))}%`;
    const stationLabel = STATION_NAMES[r.station] || STATION_QR[r.station] || r.station;
    const ts = el.querySelector(".ts");
    if (ts) {
      if (over) {
        ts.textContent =
          `${stationLabel} ${r.slot}번 칸 · 5분마다 1,000원`;
      } else {
        ts.textContent =
          `${stationLabel} ${r.slot}번 칸 · 반납 기한 ` +
          new Date(due).toLocaleString("ko-KR", { month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
      }
    }
  });
  syncTimerSlot("pickTimerSlot", "pickTimer", !!(r && $("pickTimer") && !$("pickTimer").hidden));
  syncTimerSlot("homeTimerSlot", "homeTimer", !!(r && $("homeTimer") && !$("homeTimer").hidden));
}

let qrToastTimer = null;
let qrHandling = false;
let qrBusy = false;
let qrSession = 0;
let qrConfirmKey = null;
let qrConfirmCount = 0;
let lastInvalidRaw = "";
let lastInvalidToastAt = 0;

function setQrHint(text) {
  const el = $("qrHint");
  if (el) el.textContent = text || "";
}

function syncTorchButton() {
  const on = getTorchOn();
  const btn = $("qrTorch");
  const label = $("qrTorchLabel");
  if (btn) {
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }
  if (label) label.textContent = on ? "라이트 끄기" : "라이트 켜기";
}

function hideQrToast() {
  const t = $("qrToast");
  if (!t) return;
  t.classList.remove("show", "shake");
}

function vibrateScanError() {
  try {
    if (typeof navigator.vibrate === "function") navigator.vibrate([30, 40, 50]);
  } catch (_) {}
}

function showQrToast(message, { vibrate = false } = {}) {
  const t = $("qrToast");
  const msg = $("qrToastMsg");
  if (!t || !msg) return;
  msg.textContent = message;
  t.hidden = false;
  t.classList.remove("show", "shake");
  void t.offsetWidth;
  t.classList.add("show");
  if (vibrate) vibrateScanError();
  requestAnimationFrame(() => t.classList.add("shake"));
  if (qrToastTimer) clearTimeout(qrToastTimer);
  qrToastTimer = setTimeout(() => {
    t.classList.remove("show", "shake");
  }, 2400);
}

function resetQrConfirm() {
  qrConfirmKey = null;
  qrConfirmCount = 0;
  lastInvalidRaw = "";
  lastInvalidToastAt = 0;
}

function showInvalidQr(message, raw, { vibrate = false } = {}) {
  const now = Date.now();
  if (raw === lastInvalidRaw && now - lastInvalidToastAt < INVALID_TOAST_GAP_MS) return;
  lastInvalidRaw = raw;
  lastInvalidToastAt = now;
  showQrToast(message, { vibrate });
  setQrHint("올바른 대여소 QR인지 확인해 주세요");
}

function hideQrSuccess() {
  const box = $("qrSuccess");
  if (!box) return;
  box.classList.remove("is-on");
  box.hidden = true;
}

async function showQrSuccess(station) {
  const box = $("qrSuccess");
  const text = $("qrSuccessText");
  const label = STATION_NAMES[station] || station;
  const qr = STATION_QR[station] || station;
  if (text) text.textContent = `${label} · ${qr}`;
  if (box) {
    box.hidden = false;
    box.classList.remove("is-on");
    void box.offsetWidth;
    box.classList.add("is-on");
  }
  await wait(640);
  hideQrSuccess();
}

function cameraIsLive() {
  const video = $("qrVideo");
  return $("v-qr").classList.contains("on")
    && !navBusy
    && $("qrFrame").classList.contains("ready")
    && !!(video && video.srcObject);
}

async function openQrCamera({ session = ++qrSession, whenStable = null, force = false } = {}) {
  if (!force && cameraIsLive()) return;
  hideQrToast();
  hideQrSuccess();
  resetQrConfirm();
  $("qrRetryCam").hidden = true;
  setQrHint("카메라를 준비하는 중…");
  $("qrFrame").classList.remove("denied", "ready");
  qrHandling = false;
  syncTorchButton();

  const res = await startQrScan({
    whenStable,
    onResult: handleQrPayload,
    onError: (msg) => {
      if (session !== qrSession) return;
      setQrHint(msg);
      $("qrFrame").classList.add("denied");
      $("qrRetryCam").hidden = false;
      showQrToast(msg);
    },
  });
  if (session !== qrSession) return;
  if (!$("v-qr").classList.contains("on")) {
    stopQrScan();
    return;
  }
  if (res.ok) {
    const video = $("qrVideo");
    fitQrVideoCover(video, $("qrFrame"));
    if (video) video.classList.add("is-fitted");
    $("qrFrame").classList.add("ready");
    setQrHint("대여소 QR을 네모 안에 맞춰 주세요");
  }
  syncTorchButton();
}

function presentQr({ instant = false } = {}) {
  if (cameraIsLive()) return;
  if (qrBusy) return;
  qrBusy = true;
  const session = ++qrSession;
  hideMapSheet();
  const shown = Promise.resolve(show("v-qr", { tab: "qr", instant }));
  openQrCamera({ session, whenStable: shown }).finally(() => {
    if (session === qrSession) qrBusy = false;
  });
}

async function closeQrCamera() {
  qrSession += 1;
  qrBusy = false;
  resetQrConfirm();
  $("qrFrame").classList.remove("ready", "denied");
  await stopQrScan();
  hideQrToast();
  hideQrSuccess();
  syncTorchButton();
}

async function handleQrPayload(hit) {
  if (qrHandling) return;
  const raw = String((hit && hit.raw) || "").trim();
  if (!raw) return;

  const format = String((hit && hit.format) || "").toLowerCase();
  if (format && format !== "qr_code") {
    showInvalidQr("QR 코드만 인식할 수 있어요", raw);
    setQrHint("대여소 QR을 다시 비춰 주세요");
    return;
  }

  const station = parseStationCode(raw);
  if (!station) {
    if (raw.replace(/\s+/g, "").length >= 4) {
      showInvalidQr("등록되지 않은 보관함이에요", raw, { vibrate: true });
    }
    return;
  }

  if (qrConfirmKey !== station) {
    qrConfirmKey = station;
    qrConfirmCount = 1;
    setQrHint("인식 중…");
    return;
  }
  qrConfirmCount += 1;
  if (qrConfirmCount < QR_CONFIRM_HITS) {
    setQrHint("인식 중…");
    return;
  }

  qrHandling = true;
  hideQrToast();
  setQrHint("인식 완료");
  try {
    await showQrSuccess(station);
    await closeQrCamera();
    await enterStation(station);
  } finally {
    qrHandling = false;
    resetQrConfirm();
  }
}

async function openCodeEntry() {
  closeQrCamera();
  $("codeErr").textContent = "";
  $("codeInput").value = "";
  // instant: 페이드·자동포커스 없이 전환 — iOS 줌인/줌아웃 느낌 방지
  await show("v-code", { instant: true });
}

function submitCodeEntry() {
  const raw = $("codeInput").value.trim();
  $("codeErr").textContent = "";
  if (!raw) {
    $("codeErr").textContent = "코드를 입력해 주세요.";
    return;
  }
  const station = parseStationCode(raw);
  if (!station) {
    $("codeErr").textContent = "잘못된 대여소 코드예요. 다시 확인해 주세요.";
    const input = $("codeInput");
    input.classList.remove("shake");
    void input.offsetWidth;
    input.classList.add("shake");
    return;
  }
  enterStation(station);
}

let mapSheetStation = null;

function resetMapSlotsPanel() {
  const panel = $("mapSlotsPanel");
  const box = $("mapSlots");
  const btn = $("mapSlotsBtn");
  if (panel) panel.classList.remove("is-open");
  if (box) box.innerHTML = "";
  if (btn) {
    btn.textContent = "보관함 현황 보기";
    btn.setAttribute("aria-expanded", "false");
  }
}

function hideMapSheet() {
  const sheet = $("mapSheet");
  if (!sheet) return;
  sheet.classList.remove("open");
  sheet.hidden = true;
  resetMapSlotsPanel();
  mapSheetStation = null;
  clearStationSelection();
}

async function openMapSheet(station) {
  mapSheetStation = station;
  selectStation(station.code, true);
  $("mapStationName").textContent = station.name;
  $("mapStationMeta").textContent = `코드 ${station.qr || station.code}`;
  resetMapSlotsPanel();

  const live = station.live !== false;
  const stats = $("mapStats");
  const planned = $("mapPlanned");
  const goRent = $("mapGoRent");
  const slotsBtn = $("mapSlotsBtn");

  if (live) {
    stats.hidden = false;
    planned.hidden = true;
    $("mapRentN").textContent = "…";
    $("mapReturnN").textContent = "…";
    goRent.disabled = false;
    goRent.textContent = "이 대여소 QR 스캔";
  } else {
    stats.hidden = true;
    planned.hidden = false;
    goRent.disabled = true;
    goRent.textContent = "추후 지원 예정";
    slotsBtn.dataset.ready = "1";
    slotsBtn._slotDetail = plannedSlotDetail();
  }

  const sheet = $("mapSheet");
  sheet.hidden = false;
  void sheet.offsetWidth;
  sheet.classList.add("open");

  if (!live) return;

  try {
    const inv = await getStationInventory(station.code);
    const sum = summarizeSlots(inv.slots);
    $("mapRentN").textContent = String(sum.rentable);
    $("mapReturnN").textContent = String(sum.returnable);
    slotsBtn.dataset.ready = "1";
    slotsBtn._slotDetail = sum.detail;
  } catch (e) {
    $("mapRentN").textContent = "-";
    $("mapReturnN").textContent = "-";
    $("mapStationMeta").textContent = friendlyError(e);
    slotsBtn.dataset.ready = "0";
    slotsBtn._slotDetail = [];
  }
}

function toggleMapSlots() {
  const panel = $("mapSlotsPanel");
  const box = $("mapSlots");
  const btn = $("mapSlotsBtn");
  if (!panel || !box || !btn) return;

  if (panel.classList.contains("is-open")) {
    panel.classList.remove("is-open");
    btn.textContent = "보관함 현황 보기";
    btn.setAttribute("aria-expanded", "false");
    return;
  }

  const detail = btn._slotDetail || [];
  if (!detail.length) {
    box.innerHTML = `<div class="map-slot"><div class="t">현황을 불러오지 못했어요</div></div>`;
  } else {
    box.innerHTML = detail.map((d) => `
      <div class="map-slot ${d.status}">
        <div class="n">${d.slot}</div>
        <div class="t">${d.label}</div>
      </div>
    `).join("");
  }
  // 레이아웃 한 프레임 잡힌 뒤 열어 슬라이드 애니메이션 시작
  void panel.offsetHeight;
  panel.classList.add("is-open");
  btn.textContent = "현황 접기";
  btn.setAttribute("aria-expanded", "true");
}

async function openCampusMap() {
  closeQrCamera();
  hideMapSheet();
  // 전환이 끝난 뒤 지도 SDK 초기화 — 전환 중 버벅임 방지
  await show("v-map");
  await initCampusMap($("mapCanvas"), {
    onStationSelect: (station) => openMapSheet(station),
  });
  resizeCampusMap();
}

function goTab(tab) {
  if (!state.user || state.paying) return;
  if (tab === "home") {
    closeQrCamera();
    hideMapSheet();
    // 대여 직후 홈 버튼으로 오면 CTA가 갱신되어야 함 (반납하기)
    syncUserChrome();
    tick();
    show("v-home", { tab: "home" });
    // 서버 activeRental 재확인 (로컬 state와 어긋난 경우 보정)
    refreshInventory().catch(() => {});
  } else if (tab === "qr") {
    presentQr();
  } else if (tab === "settings") {
    closeQrCamera();
    hideMapSheet();
    syncUserChrome();
    show("v-settings", { tab: "settings" });
  }
}

// ---------- boot ----------
const hashed = readStationFromHash();
if (hashed) state.station = hashed;
console.info("[umbrella] backend =", getMode(), "station =", state.station);
setTabbar(false);

$("loginBtn").onclick = login;
$("pw").onkeydown = $("sid").onkeydown = (e) => { if (e.key === "Enter") login(); };
$("joinBtn").onclick = signupSubmit;
$("goSignup").onclick = (e) => { e.preventDefault(); showAuth("signup"); };
$("goLogin").onclick = (e) => { e.preventDefault(); showAuth("login"); };
$("settingsPayment").onclick = () => openPayments();
$("payBack").onclick = () => {
  if ((state.user && state.user.paymentMethods || []).length) openPayList();
  else show("v-settings", { tab: "settings" });
};
$("payListBack").onclick = () => show("v-settings", { tab: "settings" });
$("payAdd").onclick = () => openPayForm();
bindPaySwipe();
$("payDeleteCancel").onclick = () => closePayDelete();
$("payDeleteOk").onclick = () => confirmPayDelete();
$("payDelete").onclick = (event) => {
  if (event.target === $("payDelete")) closePayDelete();
};
bindPayTyping("pay", "payCard");
mountIssuers("pay");
mountIssuers("payOverlay");
$("payForm").onsubmit = async (e) => {
  e.preventDefault();
  const err = $("payErr");
  const btn = $("paySubmit");
  err.textContent = "";
  if (!state.user) {
    err.textContent = "로그인 후 등록해 주세요.";
    return;
  }
  const fields = readPayFields("pay");
  const issue = paymentMethodIssue(fields);
  if (issue) {
    err.textContent = issue;
    return;
  }
  btn.disabled = true;
  btn.textContent = "저장 중…";
  try {
    const card = { ...fields, id: newPaymentId(), registeredAt: Date.now() };
    const methods = [...(state.user.paymentMethods || []), card];
    await storePaymentWallet(methods, state.user.defaultPaymentId || card.id);
    openPayList();
  } catch (ex) {
    err.textContent = ex.message || "결제수단을 저장하지 못했어요.";
  } finally {
    btn.disabled = false;
    renderPayState();
  }
};

function renderVerifyState() {
  const el = $("setVerifyState");
  const again = $("verifyAgain");
  const submit = $("verifySubmit");
  const verified = !!(state.user && state.user.lmsVerified);
  if (el) {
    el.textContent = verified ? "인증됨" : "미인증";
    el.classList.toggle("ok", verified);
  }
  if (again) again.hidden = !verified;
  if (submit && !submit.disabled) submit.textContent = "인증하기";
}
$("verifyAgain").onclick = () => {
  const form = $("verifyForm");
  if (!form) return;
  form.hidden = false;
  $("verifyPw").focus();
};
$("settingsVerify").onclick = () => {
  const form = $("verifyForm");
  if (!form) return;
  form.hidden = !form.hidden;
  if (!form.hidden) $("verifyPw").focus();
};
$("verifyForm").onsubmit = async (e) => {
  e.preventDefault();
  const err = $("verifyErr");
  const btn = $("verifySubmit");
  err.textContent = "";
  if (!state.user) {
    err.textContent = "로그인 후 인증해 주세요.";
    return;
  }
  btn.disabled = true;
  btn.textContent = "확인 중…";
  try {
    const url = getMode() === "firebase"
      ? (window.UMBRELLA && window.UMBRELLA.verifyStudentUrl)
      : "/api/verify-student";
    if (!url) throw new Error("재학생 인증 주소가 설정되지 않았어요.");
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(await getAuthHeaders()),
      },
      body: JSON.stringify({
        studentId: state.user.id,
        password: $("verifyPw").value.replace(/[\u200B-\u200D\uFEFF]/g, ""),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error(data.error || "재학생 인증에 실패했어요.");
    }
    state.user.lmsVerified = true;
    state.user.lmsVerifiedAt = data.verifiedAt;
    $("verifyPw").value = "";
    $("verifyForm").hidden = true;
    renderVerifyState();
    const t = $("settingsToast");
    t.hidden = false;
    t.textContent = "재학생 인증이 완료됐어요.";
    requestAnimationFrame(() => t.classList.add("show"));
    setTimeout(() => t.classList.remove("show"), 1800);
  } catch (ex) {
    err.textContent = ex.message || "재학생 인증에 실패했어요.";
  } finally {
    btn.disabled = false;
    btn.textContent = "인증하기";
  }
};
$("settingsLogout").onclick = logout;

$("tabHome").onclick = () => goTab("home");
$("tabQr").onclick = () => goTab("qr");
$("tabSettings").onclick = () => goTab("settings");
$("homeRentBtn").onclick = () => goTab("qr");
$("homeMapBtn").onclick = () => openCampusMap();
$("returnDoneRent").onclick = () => goTab("qr");
$("returnDoneHome").onclick = () => goTab("home");
$("mapBack").onclick = () => goTab("home");
$("mapSheetClose").onclick = () => hideMapSheet();
$("mapSlotsBtn").onclick = () => toggleMapSlots();
$("mapGoRent").onclick = () => {
  if (!mapSheetStation || mapSheetStation.live === false) return;
  state.station = mapSheetStation.code;
  goTab("qr");
};
$("qrBack").onclick = () => goTab("home");
$("qrRetryCam").onclick = () => {
  qrBusy = false;
  openQrCamera({ force: true });
};
$("qrManual").onclick = openCodeEntry;
$("qrTorch").onclick = async () => {
  const next = !getTorchOn();
  const ok = await setTorch(next);
  syncTorchButton();
  if (!ok) showQrToast("이 기기에서는 라이트를 켤 수 없어요");
};

$("codeBack").onclick = () => presentQr({ instant: true });
$("codeToQr").onclick = () => presentQr({ instant: true });
$("codeSubmit").onclick = submitCodeEntry;
$("codeInput").onkeydown = (e) => {
  if (e.key === "Enter") submitCodeEntry();
};
$("codeInput").oninput = () => {
  $("codeErr").textContent = "";
  $("codeInput").value = $("codeInput").value.toUpperCase().replace(/[^A-Z0-9]/g, "");
};

$("pickBack").onclick = () => goTab("qr");
$("pickHome").onclick = () => goTab("home");

document.addEventListener("visibilitychange", () => {
  if (document.hidden) closeQrCamera();
  else if ($("v-qr").classList.contains("on") && state.user) {
    qrBusy = false;
    openQrCamera({ force: true });
  }
});

window.addEventListener("resize", () => {
  if (!$("v-qr").classList.contains("on")) return;
  if (!$("qrFrame").classList.contains("ready")) return;
  fitQrVideoCover($("qrVideo"), $("qrFrame"));
}, { passive: true });

$("go").onclick = go;
$("tagBtn").onclick = () => {
  // 임시 수동 확인 — 보드 RFID+IR 인식이 오면 자동으로도 닫힘
  if (typeof returnWaitResolve === "function") returnWaitResolve();
};

window.addEventListener("hashchange", async () => {
  const auth = authHash();
  if (!state.user && auth) {
    show(auth === "signup" ? "v-signup" : "v-login");
    return;
  }
  const code = readStationFromHash();
  if (!code || !state.user) return;
  state.station = code;
  syncUserChrome();
  try { await refreshInventory(); } catch (_) {}
});

setInterval(tick, 1000);

// 첫 페인트와 맞춰 로그인/가입 셸을 바로 고정 (세션 복구 전에 버튼이 튀지 않게)
{
  const bootAuth = authHash() === "signup" ? "v-signup" : "v-login";
  if (bootAuth === "v-signup") {
    $("v-login").classList.remove("on");
    $("v-signup").classList.add("on");
  }
  applyShowChrome(bootAuth);
}

// 새로고침 시 세션 복구 (Firebase Auth / 로컬 24시간)
(async () => {
  try {
    const u = await restoreSession();
    if (u) {
      applyUser(u);
      syncUserChrome();
      tick();
      show("v-home", { tab: "home", instant: true });
      return;
    }
  } catch (e) {
    console.warn("[umbrella] session restore failed", e);
  }
  if (authHash() === "signup") show("v-signup", { instant: true });
  else show("v-login", { instant: true });
})();
