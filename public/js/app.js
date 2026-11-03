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
  friendlyError,
  MAX_HW_SLOT,
  TOTAL_SLOTS,
  RENT_LIMIT_MS,
  STATIONS,
} from "/js/backend.js";

function applyUser(res) {
  state.user = {
    id: res.studentId,
    name: res.name,
    uid: res.uid,
    activeRental: res.activeRental || null,
  };
}

const STATION_NAMES = Object.fromEntries(STATIONS.map((s) => [s.code, s.name]));
const $ = (id) => document.getElementById(id);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const DOOR_MS = 720;
const DOOR_HOLD_MS = 2200;

const state = {
  user: null,
  station: "A1",
  slots: {},
  selected: null,
  openSlot: null,
  busy: false,
  returning: false,
  tab: "home",
};

function authHash() {
  const k = (location.hash || "").replace(/^#/, "").toLowerCase();
  return k === "signup" || k === "login" ? k : null;
}

function readStationFromHash() {
  const k = (location.hash || "").replace(/^#/, "").toUpperCase();
  if (k === "SIGNUP" || k === "LOGIN") return null;
  return STATION_NAMES[k] ? k : null;
}

/** QR / URL / 해시에서 대여소 코드 추출 (A1, B2, C3…) */
function parseStationCode(raw) {
  const text = String(raw || "").trim().toUpperCase();
  if (STATION_NAMES[text]) return text;
  const hash = text.match(/#([A-Z0-9]+)/);
  if (hash && STATION_NAMES[hash[1]]) return hash[1];
  const path = text.match(/(?:STATION|UMBRELLA)[=:/]([A-Z0-9]+)/);
  if (path && STATION_NAMES[path[1]]) return path[1];
  for (const code of Object.keys(STATION_NAMES)) {
    if (text.includes(code)) return code;
  }
  return null;
}

function setTabbar(visible) {
  $("tabbar").hidden = !visible;
  document.body.classList.toggle("no-tab", !visible);
}

function setTabActive(tab) {
  state.tab = tab;
  document.querySelectorAll(".tab").forEach((el) => {
    el.classList.toggle("on", el.dataset.tab === tab);
  });
}

function show(id, { tab } = {}) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("on"));
  $(id).classList.add("on");
  const shell = id === "v-home" || id === "v-settings";
  const qr = id === "v-qr";
  setTabbar(shell || qr);
  if (shell || qr) setTabActive(tab || (id === "v-settings" ? "settings" : id === "v-qr" ? "qr" : "home"));
  window.scrollTo(0, 0);
}

function setMsg(text) {
  $("msg").textContent = text || "";
}

function syncUserChrome() {
  if (!state.user) return;
  $("homeWho").textContent = `${state.user.name}님, 안녕하세요`;
  $("setName").textContent = state.user.name;
  $("setSid").textContent = state.user.id;
  $("placeName").textContent = STATION_NAMES[state.station] || state.station;
  $("placeCode").textContent = `대여소 코드 ${state.station}`;
}

function myRentalHere() {
  const r = state.user && state.user.activeRental;
  return r && r.station === state.station ? r : null;
}

async function refreshInventory() {
  const inv = await getStationInventory(state.station);
  state.slots = inv.slots;
  if (state.user) {
    state.user.activeRental = await getMyActiveRental(state.user.uid);
  }
}

async function enterStation(code) {
  const station = parseStationCode(code);
  if (!station) {
    $("placeErr").textContent = "알 수 없는 대여소 코드예요.";
    return;
  }
  state.station = station;
  location.hash = station;
  state.selected = null;
  state.openSlot = null;
  state.returning = false;
  $("tagBtn").hidden = true;
  $("placeErr").textContent = "";
  syncUserChrome();
  try { await refreshInventory(); } catch (_) {}
  tick();
  show("v-place");
}

async function login() {
  const studentId = $("sid").value.trim();
  const password = $("pw").value;
  $("loginErr").textContent = "";
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
  const studentId = $("joinSid").value.trim();
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
  try { await logoutUser(); } catch (_) {}
  Object.assign(state, {
    user: null, selected: null, openSlot: null, returning: false, busy: false, tab: "home",
  });
  $("tagBtn").hidden = true;
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
  const mine = myRentalHere();
  const returning = !!mine;
  const cab = $("cab");
  cab.innerHTML = "";
  $("pickTitle").textContent = returning ? "우산 반납" : "우산 번호 선택";
  $("pickDesc").textContent = returning
    ? "비어 있는 칸을 골라 우산을 넣어 주세요."
    : `1~${MAX_HW_SLOT}번 칸만 하드웨어와 연결돼 있어요.`;

  for (let i = 1; i <= TOTAL_SLOTS; i++) {
    const hw = i <= MAX_HW_SLOT;
    // 대여=보관중(in), 반납=빈 칸(out)
    const usable = hw && (returning ? state.slots[i] === "out" : state.slots[i] === "in");
    const wrap = document.createElement("div");
    wrap.className = "door-wrap";
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.slot = String(i);
    b.className = `door${state.selected === i ? " sel" : ""}${state.openSlot === i ? " open" : ""}`;
    b.disabled = !usable || state.busy || state.returning;
    const label = slotLabel(i, returning);
    b.setAttribute("aria-label", `${i}번 ${label}`);
    b.innerHTML = `<span class="n">${i}</span><span class="t">${label}</span>`;
    b.onclick = () => {
      state.selected = i;
      setMsg("");
      render();
    };
    wrap.appendChild(b);
    cab.appendChild(wrap);
  }

  const g = $("go");
  g.disabled = !state.selected || state.busy || state.returning;
  g.textContent = state.selected
    ? mine ? `${state.selected}번 문 열고 반납하기` : `${state.selected}번 우산 대여하기`
    : "번호를 선택해 주세요";
}

/** DOM 유지 + CSS transition 으로 자연스럽게 열기 */
async function playDoorOpen(slot) {
  state.openSlot = slot;
  let el = doorEl(slot);
  if (!el) {
    render();
    el = doorEl(slot);
  }
  if (!el) return;
  el.classList.remove("closing", "open", "opening");
  void el.offsetWidth;
  el.classList.add("opening", "open");
  await wait(DOOR_MS);
  el.classList.remove("opening");
}

/** 열린 상태에서 같은 요소로 닫기 transition */
async function playDoorClose(slot) {
  const el = doorEl(slot);
  if (!el) {
    state.openSlot = null;
    return;
  }
  el.classList.remove("opening");
  el.classList.add("open");
  void el.offsetWidth;
  el.classList.add("closing");
  el.classList.remove("open");
  await wait(DOOR_MS);
  el.classList.remove("closing");
  state.openSlot = null;
}

async function go() {
  if (!state.selected || state.busy) return;
  const slot = state.selected;
  const mine = myRentalHere();
  const isReturn = !!mine; // 이 대여소에서 활성 대여가 있으면 반납(빈 칸)
  const params = { station: state.station, slot, studentId: state.user.id, uid: state.user.uid };

  state.busy = true;
  setMsg(isReturn ? "반납을 처리하는 중…" : "대여를 처리하는 중…");
  render();

  try {
    if (isReturn) {
      await returnUmbrella(params);
      state.returning = true;
      $("tagBtn").hidden = false;
      setMsg(`${slot}번 문이 열렸어요. 우산을 넣고 문을 닫아 주세요.`);
      await playDoorOpen(slot);
    } else {
      const r = await rentUmbrella(params);
      state.user.activeRental = {
        rentalId: r.rentalId, station: state.station, slot,
        rented_at: r.rented_at, due_at: r.due_at,
      };
      setMsg(`${slot}번 문이 열렸어요. 우산을 꺼내 주세요.`);
      await playDoorOpen(slot);
      await wait(DOOR_HOLD_MS);
      await playDoorClose(slot);
    }
    await refreshInventory();
  } catch (e) {
    state.openSlot = null;
    setMsg(friendlyError(e));
  } finally {
    state.busy = false;
    state.selected = null;
    tick();
    render();
  }
}

function fmt(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const c = s % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(c).padStart(2, "0")}`;
}

function tick() {
  const r = state.user && state.user.activeRental;
  document.querySelectorAll(".timer").forEach((el) => {
    if (!r) { el.hidden = true; return; }
    el.hidden = false;
    const due = r.due_at || r.rented_at + RENT_LIMIT_MS;
    const left = due - Date.now();
    const over = left < 0;
    el.classList.toggle("over", over);
    el.querySelector(".tl").textContent = over ? "반납 기한이 지났어요" : "남은 대여시간";
    el.querySelector(".tv").textContent = (over ? "+" : "") + fmt(Math.abs(left));
    el.querySelector(".bar i").style.width = `${Math.max(0, Math.min(100, (left / RENT_LIMIT_MS) * 100))}%`;
    el.querySelector(".ts").textContent =
      `${r.station} ${r.slot}번 칸 · 반납 기한 ` +
      new Date(due).toLocaleString("ko-KR", { month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
  });
}

function goTab(tab) {
  if (!state.user) return;
  if (tab === "home") show("v-home", { tab: "home" });
  else if (tab === "qr") show("v-qr", { tab: "qr" });
  else if (tab === "settings") {
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
$("settingsLogout").onclick = logout;

$("tabHome").onclick = () => goTab("home");
$("tabQr").onclick = () => goTab("qr");
$("tabSettings").onclick = () => goTab("settings");
$("qrBack").onclick = () => goTab("home");
$("qrTempA1").onclick = () => enterStation("A1");

$("placeBack").onclick = () => show("v-qr", { tab: "qr" });
$("pickBack").onclick = () => show("v-place");
$("placeHome").onclick = () => goTab("home");
$("pickHome").onclick = () => goTab("home");

$("placeYes").onclick = async () => {
  state.selected = null;
  state.openSlot = null;
  setMsg("");
  try { await refreshInventory(); } catch (e) { setMsg(friendlyError(e)); }
  render();
  show("v-pick");
};
$("placeNo").onclick = () => show("v-qr", { tab: "qr" });

$("go").onclick = go;
$("tagBtn").onclick = async () => {
  state.returning = false;
  if (state.openSlot) await playDoorClose(state.openSlot);
  $("tagBtn").hidden = true;
  try { await refreshInventory(); } catch (_) {}
  tick();
  setMsg("반납이 완료됐어요.");
  render();
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

// 새로고침 시 세션 복구 (Firebase Auth / 로컬 24시간)
(async () => {
  try {
    const u = await restoreSession();
    if (u) {
      applyUser(u);
      syncUserChrome();
      tick();
      show("v-home", { tab: "home" });
      return;
    }
  } catch (e) {
    console.warn("[umbrella] session restore failed", e);
  }
  if (authHash() === "signup") show("v-signup");
  else show("v-login");
})();
