/**
 * 화면 문과 서보를 같은 시각에 두는 보정.
 *
 * 서보는 2도마다 30ms, 0→90도를 1350ms 동안 일정하게 움직인다.
 * 화면 진행률도 그 직선이다. CSS ease 로 앞서가지 않는다.
 *
 * 시각
 *   S = 서버 시계, C = 클라이언트 시계, offset = S - C
 *   offset = serverNow + rtt/2 - recvAt
 *   명령이 서버에 찍힌 클라이언트 시각 cmdC = commandAt - offset
 *
 * 모터가 움직이기 시작한 클라이언트 시각
 *   start = cmdC + down
 *   down 은 서버 기록 → 모터 시작. 폴링 대기와 통신이 들어 있다.
 *
 * 상태가 돌아왔을 때 (모터가 이미 얼마나 움직였는지)
 *   age = sinceStart + uplink + echo
 *   uplink = 이번 왕복 rtt/2          보드 → 서버
 *   echo   = recvAt - (eventAt - offset)   서버에 찍힌 뒤 → 화면
 *   sinceStart 는 보드가 페이로드를 만들 때까지의 모터 시간
 *   start = recvAt - age
 *
 * 다음 문부터
 *   down 을 방금 구한 start - cmdC 쪽으로 당기고
 *   이번 rtt 가 평균보다 길면 down 에 그 차의 절반을 더한다.
 *   샘플이 쌓일수록 반영 비율을 낮춰 흔들림을 줄인다.
 */

export const SERVO_STEP_DEG = 2;
export const SERVO_STEP_MS = 30;
export const SERVO_TRAVEL_DEG = 90;
export const SERVO_POLL_MS = 200;
export const SERVO_SWEEP_MS = (SERVO_TRAVEL_DEG / SERVO_STEP_DEG) * SERVO_STEP_MS;

const STORE_KEY = "umbrella.doorSync.v1";

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function finite(n) {
  return typeof n === "number" && Number.isFinite(n);
}

function inRange(n, lo, hi) {
  return finite(n) && n >= lo && n <= hi;
}

function blend(prev, sample, n) {
  const alpha = n < 2 ? 0.6 : n < 6 ? 0.4 : 0.25;
  return prev + alpha * (sample - prev);
}

function eventCommandId(ev) {
  if (!ev) return "";
  if (ev.cmd) return String(ev.cmd);
  if (ev.payload && ev.payload.cmd) return String(ev.payload.cmd);
  return "";
}

export function clockOffset({ sentAt, recvAt, serverNow }) {
  const rtt = Math.max(0, (finite(recvAt) && finite(sentAt) ? recvAt - sentAt : 0));
  if (!finite(serverNow) || !finite(recvAt)) return { rtt, offset: 0 };
  return { rtt, offset: serverNow + rtt / 2 - recvAt };
}

export function predictDown({ rtt, downMs, rttMs, samples }) {
  const hop = Math.max(0, finite(rtt) ? rtt : 0) / 2;
  const prior = SERVO_POLL_MS / 2 + hop;
  if (!samples) return prior;
  const base = finite(downMs) ? downMs : prior;
  const drift = hop - (finite(rttMs) ? rttMs : 0) / 2;
  return Math.max(0, base + drift);
}

export function leadStart({ recvAt, commandAt, offset, downMs, rtt }) {
  const cmdClient = finite(commandAt)
    ? commandAt - (finite(offset) ? offset : 0)
    : recvAt - Math.max(0, finite(rtt) ? rtt : 0) / 2;
  return cmdClient + Math.max(0, downMs);
}

/** 서버에 찍힌 뒤 화면이 받기까지. 시계가 어긋나면 null. */
export function echoDelay({ recvAt, eventAt, offset }) {
  if (!finite(eventAt) || eventAt < 1e11 || !finite(recvAt)) return null;
  const lag = recvAt - (eventAt - (finite(offset) ? offset : 0));
  if (lag < -500 || lag > 20000) return null;
  return Math.max(0, lag);
}

export function motorAge({ sinceStartMs = 0, echoMs = 0, uplinkMs = 0 } = {}) {
  return Math.max(0, sinceStartMs) + Math.max(0, echoMs) + Math.max(0, uplinkMs);
}

function payloadOf(ev) {
  return (ev && ev.payload) || {};
}

/**
 * 돌아온 모터 상태로, 그 순간 모터가 이미 움직인 시간.
 * phase 가 없으면 시작 신호로 보고 sinceStart 는 0이다.
 */
export function ageFromEvent(ev, { recvAt, offset, uplinkMs, fallbackMove }) {
  const payload = payloadOf(ev);
  const action = String(payload.action || "");
  const reported = payload.phase === "start" || payload.phase === "done" ? payload.phase : "";
  // 위상 없는 이전 펌웨어: 열림 이벤트는 모터가 끝난 뒤, 닫힘 이벤트는 모터 직전이다.
  const closing = action.startsWith("auto_close") || action === "test_close";
  const phase = reported || (closing ? "start" : "done");
  const moveMs = inRange(Number(payload.move_ms), 400, 5000) ? Number(payload.move_ms) : fallbackMove;
  let since = inRange(Number(payload.since_start_ms), 0, 20000) ? Number(payload.since_start_ms) : null;
  if (since == null) since = phase === "done" ? moveMs : 0;
  if (phase === "done" && since < moveMs * 0.5) since = moveMs;
  const echo = echoDelay({ recvAt, eventAt: Number(ev && ev.created_at), offset });
  // 서버가 찍은 시각이면 echo 는 그 이후뿐이라, 보드→서버(rtt/2)를 더한다.
  // 보드가 직접 찍은 시각이면 그 지연이 echo 에 이미 들어 있다.
  const serverStamp = payload.stamp === "server";
  const age = motorAge({
    sinceStartMs: since,
    echoMs: echo == null ? 0 : echo,
    uplinkMs: serverStamp || echo == null ? Math.max(0, uplinkMs || 0) : 0,
  });
  return { phase, moveMs, age, echoMs: echo };
}

function blankState() {
  return {
    offset: 0,
    rttMs: 0,
    downMs: SERVO_POLL_MS / 2,
    moveMs: SERVO_SWEEP_MS,
    clockSamples: 0,
    motionSamples: 0,
  };
}

export function createDoorSync(storage) {
  const state = blankState();
  const seen = [];

  function remember(key) {
    if (seen.includes(key)) return false;
    seen.push(key);
    if (seen.length > 40) seen.shift();
    return true;
  }

  function load() {
    if (!storage) return;
    try {
      const raw = storage.getItem(STORE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (inRange(data.downMs, 0, 8000)) state.downMs = data.downMs;
      if (inRange(data.moveMs, 900, 2500)) state.moveMs = data.moveMs;
      if (finite(data.offset) && Math.abs(data.offset) < 120000) state.offset = data.offset;
      if (inRange(data.rttMs, 0, 8000)) state.rttMs = data.rttMs;
      if (inRange(data.clockSamples, 0, 100000)) state.clockSamples = data.clockSamples;
      if (inRange(data.motionSamples, 0, 100000)) state.motionSamples = data.motionSamples;
    } catch (_) { /* 저장된 보정이 깨져 있으면 펌웨어 기본값 */ }
  }

  let saveTimer = 0;
  function save() {
    if (!storage || saveTimer) return;
    const write = () => {
      saveTimer = 0;
      try {
        storage.setItem(STORE_KEY, JSON.stringify({
          offset: state.offset,
          rttMs: state.rttMs,
          downMs: state.downMs,
          moveMs: state.moveMs,
          clockSamples: state.clockSamples,
          motionSamples: state.motionSamples,
        }));
      } catch (_) { /* 저장 실패는 이번 세션 보정만 유지 */ }
    };
    if (typeof setTimeout !== "function") {
      write();
      return;
    }
    saveTimer = setTimeout(write, 0);
    if (saveTimer && typeof saveTimer.unref === "function") saveTimer.unref();
  }

  load();

  function noteRoundTrip({ sentAt, recvAt, serverNow, commandAt }) {
    const { rtt, offset } = clockOffset({ sentAt, recvAt, serverNow });
    const prevRtt = state.rttMs;
    if (!state.clockSamples) {
      state.offset = offset;
      state.rttMs = rtt;
    } else {
      state.offset = blend(state.offset, offset, state.clockSamples);
      state.rttMs = blend(state.rttMs, rtt, state.clockSamples);
    }
    state.clockSamples += 1;
    save();
    return {
      rtt,
      prevRtt,
      offset: state.offset,
      commandAt: finite(commandAt) ? commandAt : null,
      recvAt,
    };
  }

  function planLead(note) {
    const downMs = predictDown({
      rtt: note.rtt,
      downMs: state.downMs,
      rttMs: state.motionSamples ? note.prevRtt : state.rttMs,
      samples: state.motionSamples,
    });
    return {
      startAt: leadStart({
        recvAt: note.recvAt,
        commandAt: note.commandAt,
        offset: note.offset,
        downMs,
        rtt: note.rtt,
      }),
      moveMs: state.moveMs,
      progress: 0,
    };
  }

  function planFollow(at) {
    return { startAt: at || Date.now(), moveMs: state.moveMs, progress: 0 };
  }

  /**
   * 모터 상태 한 건을 반영한다.
   * role "lead" 는 열기(명령 시각과 비교해 down 을 고친다).
   * role "follow" 는 닫기(이미 움직인 만큼만 맞춘다).
   * 같은 이벤트는 한 번만 학습한다.
   */
  function observe(ev, ctx) {
    if (!ev || ev.kind !== "servo") return null;
    const want = ctx && ctx.commandId ? String(ctx.commandId) : "";
    const got = eventCommandId(ev);
    if (want && got && got !== want) return null;
    const key = `${ev.id || ev.created_at || ""}:${(ev.payload && ev.payload.action) || ""}:${(ev.payload && ev.payload.phase) || ""}`;
    const fresh = remember(key);
    const uplinkMs = Math.max(0, (ctx && ctx.rtt) || state.rttMs) / 2;
    const parsed = ageFromEvent(ev, {
      recvAt: ctx.recvAt,
      offset: ctx && finite(ctx.offset) ? ctx.offset : state.offset,
      uplinkMs,
      fallbackMove: state.moveMs,
    });
    const startAt = ctx.recvAt - parsed.age;
    if (fresh && inRange(parsed.moveMs, 900, 2500)) {
      state.moveMs = state.motionSamples
        ? blend(state.moveMs, parsed.moveMs, state.motionSamples)
        : parsed.moveMs;
    }
    if (fresh && ctx && ctx.role === "lead" && finite(ctx.commandAt)) {
      const cmdClient = ctx.commandAt - (finite(ctx.offset) ? ctx.offset : 0);
      const down = startAt - cmdClient;
      if (inRange(down, 0, 8000)) {
        state.downMs = state.motionSamples ? blend(state.downMs, down, state.motionSamples) : down;
        state.motionSamples += 1;
        save();
      } else if (fresh) save();
    } else if (fresh) save();
    return { startAt, moveMs: state.moveMs, progress: clamp(parsed.age / state.moveMs, 0, 1), phase: parsed.phase };
  }

  return {
    noteRoundTrip,
    planLead,
    planFollow,
    observe,
    motionDuration() { return state.moveMs; },
    snapshot() {
      return {
        offset: state.offset,
        rttMs: state.rttMs,
        downMs: state.downMs,
        moveMs: state.moveMs,
        clockSamples: state.clockSamples,
        motionSamples: state.motionSamples,
      };
    },
  };
}
