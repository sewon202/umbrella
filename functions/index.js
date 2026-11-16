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
