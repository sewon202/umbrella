import {
  getMode,
  signup,
  login as apiLogin,
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

const STATION_NAMES = Object.fromEntries(STATIONS.map((s) => [s.code, s.name]));

const $ = (id) => document.getElementById(id);

const state = {
  user: null,            // { id, name, uid, activeRental }
  station: "A1",
  slots: {},
  selected: null,
  openSlot: null,
  busy: false,
  returning: false,
};

function readStationFromHash() {
  const k = (location.hash || "#A1").slice(1).toUpperCase();
  return STATION_NAMES[k] ? k : "A1";
}

function show(id) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("on"));
  $(id).classList.add("on");
  window.scrollTo(0, 0);
}

function setMsg(text) {
  $("msg").textContent = text || "";
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

// ---------- 인증 ----------
async function login() {
  const studentId = $("sid").value.trim();
  const password = $("pw").value;
  $("loginErr").textContent = "";
  try {
    const res = await apiLogin({ studentId, password });
    state.user = {
      id: res.studentId,
      name: res.name,
      uid: res.uid,
      activeRental: res.activeRental || null,
    };
    $("pw").value = "";
    $("who1").textContent = $("who2").textContent = `${state.user.name}님`;
    $("placeName").textContent = STATION_NAMES[state.station];
    $("placeCode").textContent = `대여소 코드 ${state.station}`;
    $("placeErr").textContent = "";
    await refreshInventory();
    tick();
    show("v-place");
  } catch (e) {
    $("loginErr").textContent = friendlyError(e);
  }
}

async function signupInline() {
  const studentId = $("joinSid").value.trim();
  const name = $("joinName").value.trim();
  const password = $("joinPw").value;
  const out = $("joinErr");
  out.style.color = "var(--err)";
  try {
    if (!/^\d{6,10}$/.test(studentId)) throw new Error("학번은 숫자 6~10자리로 입력해 주세요.");
    if (!name) throw new Error("이름을 입력해 주세요.");
    if (!password || password.length < 6) throw new Error("비밀번호는 6자 이상이어야 해요.");
    await signup({ studentId, name, password });
    out.style.color = "#2E7D32";
    out.textContent = "회원가입 성공! 위 로그인 창에서 로그인해 주세요.";
    ["joinSid", "joinName", "joinPw"].forEach((id) => ($(id).value = ""));
  } catch (e) {
    out.textContent = friendlyError(e);
  }
}

async function logout() {
  try { await logoutUser(); } catch (_) {}
  Object.assign(state, { user: null, selected: null, openSlot: null, returning: false });
  $("tagBtn").hidden = true;
  show("v-login");
}

// ---------- 슬롯 UI ----------
function slotLabel(i, mine) {
  if (i > MAX_HW_SLOT) return "준비중";
  if (mine) return i === mine.slot ? "내 칸" : "사용 불가";
  const s = state.slots[i];
  if (s === "in") return "보관중";
  if (s === "out") return "대여중";
  return "없음";
}

function render() {
  const mine = myRentalHere();
  const cab = $("cab");
  cab.innerHTML = "";
  $("pickTitle").textContent = mine ? "우산 반납" : "우산 번호 선택";
  $("pickDesc").textContent = mine
    ? `내가 빌린 ${mine.slot}번 칸에 우산을 넣어 주세요.`
    : `1~${MAX_HW_SLOT}번 칸만 하드웨어와 연결돼 있어요.`;

  for (let i = 1; i <= TOTAL_SLOTS; i++) {
    const hw = i <= MAX_HW_SLOT;
    const usable = hw && (mine ? i === mine.slot : state.slots[i] === "in");
    const b = document.createElement("button");
    b.className = `door${state.selected === i ? " sel" : ""}${state.openSlot === i ? " open" : ""}`;
    b.disabled = !usable || state.busy || state.returning;
    const label = slotLabel(i, mine);
    b.setAttribute("aria-label", `${i}번 ${label}`);
    b.innerHTML = `<span class="n">${i}</span><span class="t">${label}</span>`;
    b.onclick = () => {
      state.selected = i;
      setMsg("");
      render();
    };
    cab.appendChild(b);
  }

  const g = $("go");
  g.disabled = !state.selected || state.busy || state.returning;
  g.textContent = state.selected
    ? mine ? `${state.selected}번 문 열고 반납하기` : `${state.selected}번 우산 대여하기`
    : "번호를 선택해 주세요";
}

async function go() {
  if (!state.selected || state.busy) return;
  const slot = state.selected;
  const mine = myRentalHere();
  const isReturn = mine && mine.slot === slot;
  const params = { station: state.station, slot, studentId: state.user.id, uid: state.user.uid };

  state.busy = true;
  setMsg(isReturn ? "반납을 처리하는 중…" : "대여를 처리하는 중…");
  render();

  try {
    if (isReturn) {
      await returnUmbrella(params);
      state.returning = true;
      $("tagBtn").hidden = false;
      setMsg(`${slot}번 문이 열려요. 우산을 넣고 문을 닫아 주세요.`);
    } else {
      const r = await rentUmbrella(params);
      state.user.activeRental = {
        rentalId: r.rentalId, station: state.station, slot,
        rented_at: r.rented_at, due_at: r.due_at,
      };
      setMsg(`${slot}번 문이 열려요. 우산을 꺼내 주세요.`);
      setTimeout(() => { state.openSlot = null; render(); }, 4000);
    }
    state.openSlot = slot;
    await refreshInventory();
  } catch (e) {
    setMsg(friendlyError(e));
  } finally {
    state.busy = false;
    state.selected = null;
    tick();
    render();
  }
}

// ---------- 타이머 ----------
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

// ---------- 바인딩 ----------
state.station = readStationFromHash();
console.info("[umbrella] backend =", getMode(), "station =", state.station);

$("loginBtn").onclick = login;
$("joinBtn").onclick = signupInline;
$("pw").onkeydown = $("sid").onkeydown = (e) => { if (e.key === "Enter") login(); };
document.querySelectorAll(".logout").forEach((b) => (b.onclick = logout));

$("placeYes").onclick = async () => {
  state.selected = null;
  state.openSlot = null;
  setMsg("");
  try { await refreshInventory(); } catch (e) { setMsg(friendlyError(e)); }
  render();
  show("v-pick");
};
$("placeNo").onclick = () => {
  $("placeErr").textContent = "가까운 대여소의 QR 코드를 다시 스캔해 주세요.";
};
$("go").onclick = go;
$("tagBtn").onclick = async () => {
  state.returning = false;
  state.openSlot = null;
  $("tagBtn").hidden = true;
  try { await refreshInventory(); } catch (_) {}
  tick();
  setMsg("반납이 완료됐어요.");
  render();
};

window.addEventListener("hashchange", async () => {
  state.station = readStationFromHash();
  if (state.user) {
    $("placeName").textContent = STATION_NAMES[state.station];
    $("placeCode").textContent = `대여소 코드 ${state.station}`;
    try { await refreshInventory(); } catch (_) {}
    render();
  }
});

setInterval(tick, 1000);
