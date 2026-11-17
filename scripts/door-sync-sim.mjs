import { createDoorSync, SERVO_SWEEP_MS } from "../public/js/door-sync.js";

function memory() {
  const mem = new Map();
  return {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, v),
  };
}

function trip(sync, { t0, rtt, serverOffset, trueDown, trueMove, uplink, echo, id }) {
  const sentAt = t0;
  const recvAt = t0 + rtt;
  const commandAt = t0 + rtt / 2 + serverOffset;
  const note = sync.noteRoundTrip({ sentAt, recvAt, serverNow: commandAt, commandAt });
  const plan = sync.planLead(note);
  const trueStart = t0 + rtt / 2 + trueDown;
  const end = trueStart + trueMove;
  const stampClient = end + uplink;
  sync.observe({
    id,
    kind: "servo",
    created_at: stampClient + serverOffset,
    cmd: "cmd",
    payload: { action: "open", phase: "done", move_ms: trueMove, since_start_ms: trueMove, cmd: "cmd", stamp: "server" },
  }, { ...note, recvAt: stampClient + echo, role: "lead", commandId: "cmd" });
  return { err: plan.startAt - trueStart, trueStart, plan };
}

const sync = createDoorSync(memory());
const errors = [];
for (let i = 0; i < 8; i++) {
  errors.push(trip(sync, {
    t0: 1_700_000_000_000 + i * 20000,
    rtt: 180,
    serverOffset: 5000,
    trueDown: 250,
    trueMove: SERVO_SWEEP_MS,
    uplink: 90,
    echo: 70,
    id: `steady-${i}`,
  }).err);
}

const noisy = createDoorSync(memory());
const noisyErr = [];
for (let i = 0; i < 10; i++) {
  const wobble = (i % 2 ? 24 : -24);
  noisyErr.push(trip(noisy, {
    t0: 1_700_000_000_000 + i * 20000,
    rtt: 220,
    serverOffset: -1200,
    trueDown: 320 + wobble,
    trueMove: 1400,
    uplink: 110,
    echo: 80,
    id: `noisy-${i}`,
  }).err);
}

const drift = createDoorSync(memory());
trip(drift, {
  t0: 1_700_000_000_000,
  rtt: 200,
  serverOffset: 100,
  trueDown: 260,
  trueMove: SERVO_SWEEP_MS,
  uplink: 100,
  echo: 60,
  id: "drift-0",
});
const slower = trip(drift, {
  t0: 1_700_000_000_000 + 20000,
  rtt: 200,
  serverOffset: 100,
  trueDown: 260,
  trueMove: SERVO_SWEEP_MS,
  uplink: 100,
  echo: 60,
  id: "drift-1",
});
const fasterNet = createDoorSync(memory());
for (let i = 0; i < 4; i++) {
  trip(fasterNet, {
    t0: 1_700_000_000_000 + i * 20000,
    rtt: 200,
    serverOffset: 100,
    trueDown: 260,
    trueMove: SERVO_SWEEP_MS,
    uplink: 100,
    echo: 60,
    id: `net-${i}`,
  });
}
const steadyNote = fasterNet.noteRoundTrip({
  sentAt: 1_700_000_100_000,
  recvAt: 1_700_000_100_200,
  serverNow: 1_700_000_100_200,
  commandAt: 1_700_000_100_200,
});
const before = fasterNet.planLead(steadyNote);
const slowNote = fasterNet.noteRoundTrip({
  sentAt: 1_700_000_200_000,
  recvAt: 1_700_000_200_400,
  serverNow: 1_700_000_200_400,
  commandAt: 1_700_000_200_400,
});
const afterSlow = fasterNet.planLead(slowNote);
const downOf = (note, plan) => plan.startAt - (note.commandAt - note.offset);
const startShift = downOf(slowNote, afterSlow) - downOf(steadyNote, before);

const closeSync = createDoorSync(memory());
const closed = closeSync.observe({
  id: "close-1",
  kind: "servo",
  created_at: 1_700_000_010_000,
  payload: { action: "auto_close", phase: "start", move_ms: 1350, since_start_ms: 0, stamp: "server" },
}, {
  recvAt: 1_700_000_010_180,
  offset: 0,
  rtt: 200,
  role: "follow",
});

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL", msg);
    console.error(JSON.stringify({ errors, noisyErr, snap: sync.snapshot(), noisy: noisy.snapshot(), slower, startShift, closed }, null, 2));
    process.exit(1);
  }
}

assert(Math.abs(errors[0]) > 20, "첫 예측은 학습 전이라 참값과 차이가 나야 한다");
assert(Math.abs(errors[7]) < 20, `8회 뒤에는 시작 시각 오차 20ms 안이어야 한다. 마지막 ${errors[7]}`);
assert(Math.abs(noisy.snapshot().downMs - 320) < 30, `흔들리는 지연의 중심을 따라야 한다. down=${noisy.snapshot().downMs}`);
assert(Math.abs(slower.err) < 20, `같은 조건의 두 번째 시도는 맞아야 한다. err=${slower.err}`);
assert(startShift > 70 && startShift < 130, `RTT가 200ms 늘면 시작을 약 100ms 늦춰야 한다. shift=${startShift}`);
assert(closed && closed.progress > 0.15 && closed.progress < 0.25, `닫힘 에코만큼 이미 진행돼야 한다. p=${closed && closed.progress}`);
assert(Math.abs(closeSync.snapshot().moveMs - 1350) < 1, "따라가는 닫힘은 열기 지연을 덮어쓰지 않는다");

console.log("door-sync ok", {
  firstMs: Math.round(errors[0]),
  eighthMs: Math.round(errors[7]),
  noisyDown: Math.round(noisy.snapshot().downMs),
  rttShiftMs: Math.round(startShift),
  closeProgress: Number(closed.progress.toFixed(3)),
});
