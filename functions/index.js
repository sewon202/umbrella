const { onRequest } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");
const { verifySsuStudent } = require("./ssu-verify.cjs");

initializeApp();

const attempts = new Map();

function tooMany(studentId) {
  const now = Date.now();
  const recent = (attempts.get(studentId) || []).filter((t) => now - t < 10 * 60 * 1000);
  if (recent.length >= 5) {
    attempts.set(studentId, recent);
    return true;
  }
  recent.push(now);
  attempts.set(studentId, recent);
  return false;
}

exports.verifyStudent = onRequest(
  {
    region: "asia-northeast3",
    cors: true,
    invoker: "public",
    timeoutSeconds: 30,
    memory: "256MiB",
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "POST만 가능해요." });
      return;
    }
    const studentId = String((req.body && req.body.studentId) || "").trim();
    const password = String((req.body && req.body.password) || "");
    const header = String(req.get("Authorization") || "");
    const idToken = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!idToken) {
      res.status(401).json({ error: "로그인이 필요해요." });
      return;
    }
    if (tooMany(studentId || "unknown")) {
      res.status(429).json({ error: "시도가 너무 많아요. 10분 뒤에 다시 해 주세요." });
      return;
    }
    try {
      const decoded = await getAuth().verifyIdToken(idToken);
      const emailId = String(decoded.email || "").split("@")[0];
      if (!emailId || emailId !== studentId) {
        res.status(403).json({ error: "로그인한 학번으로만 인증할 수 있어요." });
        return;
      }
      const result = await verifySsuStudent({ studentId, password });
      if (!result.ok) {
        res.status(401).json({ error: result.error });
        return;
      }
      const verifiedAt = Date.now();
      await getFirestore().doc(`students/${decoded.uid}`).set({
        lmsVerified: true,
        lmsVerifiedAt: verifiedAt,
        updated_at: verifiedAt,
      }, { merge: true });
      res.json({ ok: true, studentId: result.studentId, verifiedAt });
    } catch (err) {
      console.error("verifyStudent", err && err.code ? err.code : "error");
      res.status(500).json({ error: "재학생 인증 중 오류가 발생했어요." });
    }
  }
);

const DEVICE_EMAIL = "device@umbrella.local";

async function deleteInBatches(db, docs) {
  for (let i = 0; i < docs.length; i += 400) {
    const batch = db.batch();
    docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
}

exports.deleteStudent = onRequest(
  {
    region: "asia-northeast3",
    cors: true,
    invoker: "public",
    timeoutSeconds: 60,
    memory: "256MiB",
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "POST만 가능해요." });
      return;
    }
    const header = String(req.get("Authorization") || "");
    const idToken = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!idToken) {
      res.status(401).json({ error: "로그인이 필요해요." });
      return;
    }
    try {
      const decoded = await getAuth().verifyIdToken(idToken);
      const email = String(decoded.email || "").toLowerCase();
      if (email !== DEVICE_EMAIL) {
        res.status(403).json({ error: "device 계정만 사용자를 삭제할 수 있어요." });
        return;
      }
      const uid = String((req.body && req.body.uid) || "").trim();
      if (!uid || uid.length > 128 || uid === decoded.uid) {
        res.status(400).json({ error: uid === decoded.uid ? "device 계정은 삭제할 수 없어요." : "삭제할 사용자를 지정해 주세요." });
        return;
      }

      const auth = getAuth();
      let target = null;
      try {
        target = await auth.getUser(uid);
      } catch (err) {
        if (!err || err.code !== "auth/user-not-found") throw err;
      }
      if (target && String(target.email || "").toLowerCase() === DEVICE_EMAIL) {
        res.status(400).json({ error: "device 계정은 삭제할 수 없어요." });
        return;
      }

      const db = getFirestore();
      const studentRef = db.doc(`students/${uid}`);
      const studentSnap = await studentRef.get();
      const student = studentSnap.exists ? studentSnap.data() || {} : null;
      const [byUid, byId] = await Promise.all([
        db.collection("rentals").where("studentUid", "==", uid).get(),
        student && student.studentId
          ? db.collection("rentals").where("studentId", "==", String(student.studentId)).get()
          : Promise.resolve({ docs: [] }),
      ]);
      const rentalDocs = [];
      const seen = new Set();
      for (const d of [...byUid.docs, ...byId.docs]) {
        if (seen.has(d.id)) continue;
        seen.add(d.id);
        rentalDocs.push(d);
      }
      if (!studentSnap.exists && !target && !rentalDocs.length) {
        res.status(404).json({ error: "사용자를 찾을 수 없어요." });
        return;
      }

      const active = student && student.activeRental;
      if (active && active.station && active.slot && student.studentId) {
        const umbrellaRef = db.doc(`umbrellas/${active.station}-${active.slot}`);
        const umbrellaSnap = await umbrellaRef.get();
        const rentedBy = umbrellaSnap.exists ? umbrellaSnap.data().rented_by : null;
        if (rentedBy === student.studentId) {
          await umbrellaRef.set({
            status: "in",
            rented_by: null,
            rented_at: null,
            updated_at: Date.now(),
          }, { merge: true });
        }
      }

      await deleteInBatches(db, rentalDocs);
      if (studentSnap.exists) await studentRef.delete();
      if (target) await auth.deleteUser(uid);
      res.json({ ok: true, uid });
    } catch (err) {
      console.error("deleteStudent", err && err.code ? err.code : "error");
      res.status(500).json({ error: "사용자를 삭제하지 못했어요." });
    }
  }
);
