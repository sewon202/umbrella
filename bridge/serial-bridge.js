/**
 * USB 시리얼 브리지: 아두이노(USB) ↔ 백엔드(local Express | Firebase)
 *
 *   npm run bridge               # firebase-config.js 설정에 따라 자동
 *   npm run bridge:firebase      # Firebase 강제
 *   BACKEND=local npm run bridge # 로컬 Express 강제
 *   npm run bridge -- --port /dev/cu.usbmodemXXXX
 *
 * 시리얼 프로토콜 (줄 단위)
 *   PC → MCU : PING | OPEN <slot>
 *   MCU → PC : PONG | ACK OPEN n | DONE OPEN n | EVENT RFID n UID | EVENT IR n | EVENT SERVO n action
 */
const { SerialPort } = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SERVER = process.env.SERVER_URL || "http://127.0.0.1:3000";
const DEVICE_KEY = process.env.DEVICE_KEY || "umbrella-device";
const STATION = (process.env.STATION || "A1").toUpperCase();
const BAUD = 9600;
const PING_MS = 2000;
const CMD_TIMEOUT_MS = 20000;

// ---------- 설정 ----------
function loadConfig() {
  const code = fs.readFileSync(path.join(__dirname, "..", "public", "firebase-config.js"), "utf8");
  const sandbox = { window: {} };
  vm.runInNewContext(code, sandbox);
  return sandbox.window.UMBRELLA || {};
}

function resolveBackend(cfg) {
  const env = process.env.BACKEND;
  if (env === "firebase" || env === "local") return env;
  if (cfg.backend === "firebase" || cfg.backend === "local") return cfg.backend;
  const fb = cfg.firebase || {};
  return fb.projectId && fb.projectId !== "YOUR_PROJECT_ID" && fb.apiKey !== "YOUR_API_KEY"
    ? "firebase" : "local";
}

const argValue = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};

async function pickPort() {
  const forced = argValue("--port") || process.env.SERIAL_PORT;
  if (forced) return forced;
  const all = await SerialPort.list();
  const candidates = all.filter((p) =>
    /usbmodem|usbserial|Arduino|UNO/i.test([p.path, p.manufacturer, p.friendlyName].join(" "))
  );
  if (!candidates.length) {
    console.error("USB 시리얼 포트를 찾지 못했어요. 보드를 USB로 연결하세요.");
    console.error("사용 가능 포트:", all.map((p) => p.path).join(", ") || "(없음)");
    process.exit(1);
  }
  if (candidates.length > 1) {
    console.log("후보 포트:", candidates.map((p) => p.path).join(", "), "→ 첫 번째 사용 (--port 로 지정 가능)");
  }
  return candidates[0].path;
}

// ---------- 백엔드 어댑터 ----------
function localBackend() {
  async function call(method, urlPath, body) {
    const res = await fetch(SERVER + urlPath, {
      method,
      headers: { "Content-Type": "application/json", "X-Device-Key": DEVICE_KEY },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { raw: text, status: res.status }; }
  }
  return {
    mode: "local",
    next: () => call("GET", `/api/device/next?station=${STATION}&key=${DEVICE_KEY}`),
    done: (id) => call("POST", `/api/device/commands/${id}/done`),
    event: (p) => call("POST", "/api/device/event", p),
    presence: (p) => call("POST", "/api/device/presence", { station: STATION, link: "wired", ...p }),
  };
}

async function firebaseBackend(cfg) {
  const { initializeApp } = require("firebase/app");
  const { getAuth, signInWithEmailAndPassword } = require("firebase/auth");
  const {
    getFirestore, collection, query, where, orderBy, limit,
    getDocs, updateDoc, setDoc, doc, addDoc,
  } = require("firebase/firestore");

  const app = initializeApp(cfg.firebase);
  const auth = getAuth(app);
  const db = getFirestore(app);
  const maxSlot = (cfg.cost && cfg.cost.maxHwSlot) || 2;

  await signInWithEmailAndPassword(
    auth,
    cfg.deviceEmail || "device@umbrella.local",
    cfg.devicePassword || "device-change-me"
  );
  console.log("[firebase] device login OK");

  return {
    mode: "firebase",
    async next() {
      const snap = await getDocs(query(
        collection(db, "commands"),
        where("station", "==", STATION),
        where("done", "==", 0),
        orderBy("created_at", "asc"),
        limit(10)
      ));
      const row = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
        .find((c) => c.slot >= 1 && c.slot <= maxSlot);
      return row ? { ok: true, has: true, ...row } : { ok: true, has: false };
    },
    async done(id) {
      await updateDoc(doc(db, "commands", id), { done: 1, done_at: Date.now() });
    },
    async event(p) {
      await addDoc(collection(db, "device_events"), { ...p, created_at: Date.now() });
      if (p.kind === "rfid" && p.payload && p.payload.uid) {
        await setDoc(doc(db, "umbrellas", `${p.station}-${p.slot}`), {
          tag_uid: String(p.payload.uid).toUpperCase(), updated_at: Date.now(),
        }, { merge: true });
      }
    },
    async presence({ mcu_ok }) {
      await setDoc(doc(db, "stations", STATION), {
        code: STATION,
        last_seen: Date.now(),
        link: "wired",
        mcu_ok: !!mcu_ok,
        wifi_rssi: null,
        wifi_ip: null,
      }, { merge: true });
    },
  };
}

// ---------- 메인 ----------
async function main() {
  const cfg = loadConfig();
  const mode = resolveBackend(cfg);
  const POLL_MS = Number(process.env.POLL_MS || (cfg.cost && cfg.cost.bridgePollMs) || 4000);
  const api = mode === "firebase" ? await firebaseBackend(cfg) : localBackend();
  const serialPath = await pickPort();

  console.log("========================================");
  console.log(" USB Serial Bridge");
  console.log(`  backend : ${api.mode}`);
  console.log(`  port    : ${serialPath}`);
  console.log(`  station : ${STATION}`);
  console.log(`  poll    : ${POLL_MS}ms`);
  console.log("========================================");

  const port = new SerialPort({ path: serialPath, baudRate: BAUD });
  const parser = port.pipe(new ReadlineParser({ delimiter: "\n" }));

  let pending = null; // { id, timer }
  let lastPong = 0;

  const send = (line) => {
    console.log("→ MCU", line);
    port.write(line + "\n");
  };

  async function finish(reason) {
    if (!pending) return;
    const { id, timer } = pending;
    clearTimeout(timer);
    pending = null;
    try {
      await api.done(id);
      console.log(`[cmd] done id=${id} (${reason})`);
    } catch (e) {
      console.error("[cmd] done 실패:", e.message);
    }
  }

  async function sendEvent(slot, kind, payload) {
    try {
      await api.event({ station: STATION, slot, kind, payload });
    } catch (e) {
      console.error("[event] 실패:", e.message);
    }
  }

  const handlers = [
    [/^PONG\b/i, () => { lastPong = Date.now(); }],
    [/^DONE\s+OPEN(?:_RETURN)?\s+\d+/i, () => finish("mcu")],
    [/^EVENT\s+RFID\s+(\d+)\s+(\S+)/i, (m) => sendEvent(Number(m[1]), "rfid", { uid: m[2] })],
    [/^EVENT\s+IR\s+(\d+)/i, (m) => sendEvent(Number(m[1]), "ir", { held_ms: 1000 })],
    [/^EVENT\s+RETURN_OK\s+(\d+)/i, (m) => sendEvent(Number(m[1]), "return_ok", { source: "rfid_ir" })],
    [/^EVENT\s+SERVO\s+(\d+)\s+(\S+)/i, (m) => sendEvent(Number(m[1]), "servo", { action: m[2], deg: 90 })],
  ];

  parser.on("data", (raw) => {
    const line = String(raw).trim();
    if (!line) return;
    console.log("← MCU", line);
    for (const [re, fn] of handlers) {
      const m = line.match(re);
      if (m) { fn(m); return; }
    }
  });

  port.on("open", () => console.log("[serial] open"));
  port.on("error", (err) => console.error("[serial] error", err.message));
  port.on("close", () => { console.error("[serial] closed — 보드 연결 확인"); process.exit(1); });

  setInterval(() => send("PING"), PING_MS);

  setInterval(async () => {
    if (pending) return;
    const mcuOk = !!(lastPong && Date.now() - lastPong <= PING_MS * 4);
    if (lastPong && !mcuOk) {
      console.warn("[warn] MCU 응답 없음 — USB/스케치 확인");
    }
    try {
      if (api.presence) {
        await api.presence({ mcu_ok: mcuOk });
      }
      const body = await api.next();
      if (!body || !body.has) return;
      pending = {
        id: body.id,
        timer: setTimeout(() => finish("timeout"), CMD_TIMEOUT_MS),
      };
      const action = String(body.action || "open");
      if (action === "open_return") send(`OPEN_RETURN ${body.slot}`);
      else send(`OPEN ${body.slot}`);
    } catch (e) {
      console.error("[poll]", e.message);
    }
  }, POLL_MS);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
