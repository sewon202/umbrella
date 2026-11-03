/**
 * Umbrella 백엔드 어댑터
 *  - firebase : Auth + Firestore (Hosting 배포용, Functions 없음)
 *  - local    : Express /api (npm start)
 * 두 어댑터는 동일한 인터페이스를 구현한다.
 */
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  addDoc,
  collection,
  query,
  where,
  orderBy,
  limit,
  getDocs,
  updateDoc,
  runTransaction,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";

// ---------- 공통 상수 / 유틸 ----------
const cfg = window.UMBRELLA || {};
const fb = cfg.firebase || {};
export const MAX_HW_SLOT = (cfg.cost && cfg.cost.maxHwSlot) || 2;
export const TOTAL_SLOTS = 6;
export const RENT_LIMIT_MS = 48 * 3600 * 1000;
const DEVICE_KEY = "umbrella-device";

export const STATIONS = [
  { code: "A1", name: "학생회관 정문" },
  { code: "B2", name: "중앙도서관 출입구" },
  { code: "C3", name: "형남공학관 2층 입구" },
];

const isConfigured =
  fb.projectId && fb.projectId !== "YOUR_PROJECT_ID" &&
  fb.apiKey && fb.apiKey !== "YOUR_API_KEY";

// 우선순위: URL ?backend=local|firebase (개발용) → firebase-config.js → 자동 감지
const urlBackend = new URLSearchParams(location.search).get("backend");
const pick = (v) => (v === "firebase" || v === "local" ? v : null);
export const mode = pick(urlBackend) || pick(cfg.backend) || (isConfigured ? "firebase" : "local");

export const getMode = () => mode;

const umbrellaId = (station, slot) => `${station}-${slot}`;
const studentEmail = (studentId) => `${studentId}@students.umbrella.app`;

function assertSlot(slot) {
  if (!Number.isInteger(slot) || slot < 1 || slot > MAX_HW_SLOT) {
    throw new Error(`지금은 슬롯 1~${MAX_HW_SLOT}만 사용할 수 있어요.`);
  }
}

/** 슬롯 상태 맵 기본값: HW 슬롯은 in, 나머지는 prep */
function emptySlots() {
  const slots = {};
  for (let i = 1; i <= TOTAL_SLOTS; i++) slots[i] = i <= MAX_HW_SLOT ? "in" : "prep";
  return slots;
}

function applyRows(slots, rows) {
  for (const u of rows || []) {
    if (u.slot >= 1 && u.slot <= MAX_HW_SLOT) slots[u.slot] = u.status === "out" ? "out" : "in";
  }
  return slots;
}

// ---------- 로컬(Express) 어댑터 ----------
function createLocalBackend() {
  async function api(method, path, body, headers = {}) {
    const res = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { data = {}; }
    if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
    return data;
  }
  const dev = { "X-Device-Key": DEVICE_KEY };

  return {
    mode: "local",
    async signup(p) { return api("POST", "/api/signup", p); },
    async login({ studentId, password }) {
      const r = await api("POST", "/api/login", { studentId, password });
      return { studentId, name: r.name, uid: studentId, activeRental: r.activeRental || null };
    },
    async loginDevice() { return { ok: true }; },
    async logout() {},
    async getStationInventory(station) {
      const r = await api("GET", `/api/station/${station}`);
      return { station, slots: applyRows(emptySlots(), r.slots), rows: r.slots || [] };
    },
    async getMyActiveRental(studentId) {
      const r = await api("GET", `/api/students/${studentId}/rental`);
      return r.activeRental || null;
    },
    async rent({ station, slot, studentId }) {
      assertSlot(slot);
      return api("POST", "/api/rent", { station, slot, studentId });
    },
    async return({ station, slot, studentId }) {
      assertSlot(slot);
      return api("POST", "/api/return", { station, slot, studentId });
    },
    async openDoor({ station, slot, studentId, action = "open" }) {
      assertSlot(slot);
      return api("POST", "/api/open", { station, slot, studentId, action });
    },
    async listStudents() { return (await api("GET", "/api/admin/students")).students; },
    async listAllUmbrellas() { return (await api("GET", "/api/admin/umbrellas")).umbrellas; },
    async listActiveRentals() { return (await api("GET", "/api/admin/rentals")).rentals; },
    async setUmbrellaStatus(p) { return api("POST", "/api/admin/umbrella-status", p); },
    async seedInventory() {},
    async fetchNextCommand(station = "A1") {
      return api("GET", `/api/device/next?station=${station}&key=${DEVICE_KEY}`);
    },
    async markCommandDone(id) { return api("POST", `/api/device/commands/${id}/done`, null, dev); },
    async postDeviceEvent(p) { return api("POST", "/api/device/event", p, dev); },
    async debugRecent() { return api("GET", "/api/debug/recent"); },
    async health() { return api("GET", "/api/health"); },
  };
}

// ---------- Firebase 어댑터 ----------
function createFirebaseBackend() {
  const app = initializeApp(fb);
  const auth = getAuth(app);
  const db = getFirestore(app);

  const requireUser = () => {
    if (!auth.currentUser) throw new Error("로그인이 필요해요.");
    return auth.currentUser;
  };
  const docData = (d) => ({ id: d.id, ...d.data() });

  async function pendingCommands(station) {
    const q = query(
      collection(db, "commands"),
      where("station", "==", station),
      where("done", "==", 0),
      orderBy("created_at", "asc"),
      limit(10)
    );
    return (await getDocs(q)).docs.map(docData);
  }

  function newCommand(tx, { station, slot, studentId, action, now }) {
    const ref = doc(collection(db, "commands"));
    tx.set(ref, {
      station, slot, action,
      student_id: studentId || null,
      done: 0, created_at: now, done_at: null,
    });
    return ref.id;
  }

  return {
    mode: "firebase",

    async signup({ studentId, name, password }) {
      const cred = await createUserWithEmailAndPassword(auth, studentEmail(studentId), password);
      await updateProfile(cred.user, { displayName: name });
      await setDoc(doc(db, "students", cred.user.uid), {
        studentId, name, created_at: Date.now(), activeRental: null,
      });
      await signOut(auth); // 가입 직후 자동 로그인 상태 해제 → 로그인 화면과 일치
      return { ok: true };
    },

    async login({ studentId, password }) {
      const cred = await signInWithEmailAndPassword(auth, studentEmail(studentId), password);
      const snap = await getDoc(doc(db, "students", cred.user.uid));
      const data = snap.exists() ? snap.data() : {};
      return {
        studentId: data.studentId || studentId,
        name: data.name || cred.user.displayName || studentId,
        uid: cred.user.uid,
        activeRental: data.activeRental || null,
      };
    },

    async loginDevice() {
      const email = cfg.deviceEmail || "device@umbrella.local";
      const password = cfg.devicePassword || "device-change-me";
      await signInWithEmailAndPassword(auth, email, password);
      await this.seedInventory();
      return { ok: true, email };
    },

    async logout() { await signOut(auth); },

    async getStationInventory(station) {
      const snap = await getDocs(query(collection(db, "umbrellas"), where("station", "==", station)));
      const rows = snap.docs.map(docData);
      return { station, slots: applyRows(emptySlots(), rows), rows };
    },

    async getMyActiveRental(uid) {
      const snap = await getDoc(doc(db, "students", uid || requireUser().uid));
      return snap.exists() ? snap.data().activeRental || null : null;
    },

    /** 대여: 트랜잭션으로 슬롯 상태·대여기록·사용자·명령을 원자적으로 기록 */
    async rent({ station, slot, studentId }) {
      assertSlot(slot);
      const user = requireUser();
      const now = Date.now();
      const due_at = now + RENT_LIMIT_MS;
      const uRef = doc(db, "umbrellas", umbrellaId(station, slot));
      const sRef = doc(db, "students", user.uid);
      const rRef = doc(collection(db, "rentals"));

      const cmdId = await runTransaction(db, async (tx) => {
        const [uSnap, sSnap] = await Promise.all([tx.get(uRef), tx.get(sRef)]);
        const u = uSnap.exists() ? uSnap.data() : { status: "in" };
        if (u.status === "out") throw new Error("그 칸은 이미 대여 중이에요.");
        if (sSnap.exists() && sSnap.data().activeRental) {
          throw new Error("이미 대여 중인 우산이 있어요. 먼저 반납해 주세요.");
        }
        tx.set(uRef, {
          station, slot, status: "out",
          rented_by: studentId, rented_at: now, updated_at: now,
        }, { merge: true });
        tx.set(rRef, {
          studentId, studentUid: user.uid, station, slot,
          rented_at: now, due_at, returned_at: null, status: "active",
        });
        tx.set(sRef, {
          activeRental: { rentalId: rRef.id, station, slot, rented_at: now, due_at },
          updated_at: now,
        }, { merge: true });
        return newCommand(tx, { station, slot, studentId, action: "open", now });
      });

      return { ok: true, id: cmdId, rentalId: rRef.id, station, slot, rented_at: now, due_at };
    },

    /** 반납: 내 활성 대여와 일치할 때만 처리 */
    async return({ station, slot, studentId }) {
      assertSlot(slot);
      const user = requireUser();
      const now = Date.now();
      const sRef = doc(db, "students", user.uid);
      const uRef = doc(db, "umbrellas", umbrellaId(station, slot));

      const cmdId = await runTransaction(db, async (tx) => {
        const sSnap = await tx.get(sRef);
        const active = sSnap.exists() ? sSnap.data().activeRental : null;
        if (!active || active.slot !== slot || active.station !== station) {
          throw new Error("반납할 대여 정보가 맞지 않아요.");
        }
        tx.set(uRef, {
          station, slot, status: "in",
          rented_by: null, rented_at: null, updated_at: now,
        }, { merge: true });
        if (active.rentalId) {
          tx.update(doc(db, "rentals", active.rentalId), { returned_at: now, status: "returned" });
        }
        tx.set(sRef, { activeRental: null, updated_at: now }, { merge: true });
        return newCommand(tx, { station, slot, studentId, action: "open", now });
      });

      return { ok: true, id: cmdId, station, slot };
    },

    async openDoor({ station, slot, studentId, action = "open" }) {
      assertSlot(slot);
      requireUser();
      const ref = await addDoc(collection(db, "commands"), {
        station, slot, action, student_id: studentId || null,
        done: 0, created_at: Date.now(), done_at: null,
      });
      return { ok: true, id: ref.id, station, slot, action };
    },

    async listStudents() {
      requireUser();
      return (await getDocs(collection(db, "students"))).docs.map((d) => ({ uid: d.id, ...d.data() }));
    },

    async listAllUmbrellas() {
      const rows = (await getDocs(collection(db, "umbrellas"))).docs.map(docData);
      return rows.sort((a, b) =>
        a.station === b.station ? a.slot - b.slot : a.station.localeCompare(b.station)
      );
    },

    async listActiveRentals() {
      const q = query(
        collection(db, "rentals"),
        where("status", "==", "active"),
        orderBy("rented_at", "desc"),
        limit(50)
      );
      return (await getDocs(q)).docs.map(docData);
    },

    async setUmbrellaStatus({ station, slot, status }) {
      if (!["in", "out"].includes(status)) throw new Error("status는 in/out 만 가능해요.");
      await setDoc(doc(db, "umbrellas", umbrellaId(station, slot)), {
        station, slot, status, updated_at: Date.now(),
        ...(status === "in" ? { rented_by: null, rented_at: null } : {}),
      }, { merge: true });
      return { ok: true };
    },

    /** 없는 문서만 생성 (device 로그인·관리 화면에서만 호출 → 비용 최소) */
    async seedInventory() {
      if (!auth.currentUser) return;
      for (const s of STATIONS) {
        await setDoc(doc(db, "stations", s.code), s, { merge: true });
        for (let slot = 1; slot <= MAX_HW_SLOT; slot++) {
          const ref = doc(db, "umbrellas", umbrellaId(s.code, slot));
          if (!(await getDoc(ref)).exists()) {
            await setDoc(ref, {
              tag_uid: `${s.code}-SLOT${slot}`, station: s.code, slot,
              status: "in", rented_by: null, rented_at: null, updated_at: Date.now(),
            });
          }
        }
      }
    },

    async fetchNextCommand(station = "A1") {
      const row = (await pendingCommands(station)).find((c) => c.slot >= 1 && c.slot <= MAX_HW_SLOT);
      return row ? { ok: true, has: true, ...row } : { ok: true, has: false, station };
    },

    async markCommandDone(id) {
      await updateDoc(doc(db, "commands", id), { done: 1, done_at: Date.now() });
      return { ok: true, id };
    },

    async postDeviceEvent({ station, slot, kind, payload }) {
      const ref = await addDoc(collection(db, "device_events"), {
        station, slot, kind, payload: payload || {}, created_at: Date.now(),
      });
      if (kind === "rfid" && payload && payload.uid) {
        await setDoc(doc(db, "umbrellas", umbrellaId(station, slot)), {
          tag_uid: String(payload.uid).toUpperCase(), updated_at: Date.now(),
        }, { merge: true });
      }
      return { ok: true, id: ref.id };
    },

    async debugRecent() {
      const [cmds, evs, umbs] = await Promise.all([
        getDocs(query(collection(db, "commands"), orderBy("created_at", "desc"), limit(10))),
        getDocs(query(collection(db, "device_events"), orderBy("created_at", "desc"), limit(10))),
        getDocs(collection(db, "umbrellas")),
      ]);
      return {
        maxHwSlot: MAX_HW_SLOT, backend: "firebase",
        umbrellas: umbs.docs.map(docData),
        commands: cmds.docs.map(docData),
        events: evs.docs.map(docData),
      };
    },

    async health() {
      return { ok: true, backend: "firebase", maxHwSlot: MAX_HW_SLOT, projectId: fb.projectId };
    },
  };
}

// ---------- 선택된 어댑터 공개 ----------
export const backend = mode === "firebase" ? createFirebaseBackend() : createLocalBackend();

export const signup = (p) => backend.signup(p);
export const login = (p) => backend.login(p);
export const loginDevice = () => backend.loginDevice();
export const logoutUser = () => backend.logout();
export const getStationInventory = (s) => backend.getStationInventory(s);
export const getMyActiveRental = (uid) => backend.getMyActiveRental(uid);
export const rentUmbrella = (p) => backend.rent(p);
export const returnUmbrella = (p) => backend.return(p);
export const openDoor = (p) => backend.openDoor(p);
export const listStudents = () => backend.listStudents();
export const listAllUmbrellas = () => backend.listAllUmbrellas();
export const listActiveRentals = () => backend.listActiveRentals();
export const setUmbrellaStatus = (p) => backend.setUmbrellaStatus(p);
export const seedInventory = () => backend.seedInventory();
export const fetchNextCommand = (s) => backend.fetchNextCommand(s);
export const markCommandDone = (id) => backend.markCommandDone(id);
export const postDeviceEvent = (p) => backend.postDeviceEvent(p);
export const debugRecent = () => backend.debugRecent();
export const health = () => backend.health();

/** Firebase/서버 에러를 사용자용 문구로 변환 */
export function friendlyError(e) {
  const msg = String((e && e.message) || e || "");
  if (/invalid-credential|user-not-found|wrong-password/i.test(msg)) return "학번 또는 비밀번호가 맞지 않아요.";
  if (/email-already-in-use/i.test(msg)) return "이미 가입된 학번이에요.";
  if (/weak-password/i.test(msg)) return "비밀번호는 6자 이상이어야 해요.";
  if (/invalid-email/i.test(msg)) return "학번 형식을 확인해 주세요.";
  if (/invalid-api-key|YOUR_API_KEY/i.test(msg)) return "firebase-config.js 설정을 확인해 주세요.";
  if (/permission-denied|Missing or insufficient permissions/i.test(msg)) return "권한이 없어요. 로그인 상태를 확인해 주세요.";
  if (/network|Failed to fetch/i.test(msg)) return "서버에 연결하지 못했어요.";
  return msg || "알 수 없는 오류가 발생했어요.";
}
