const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const crypto = require("crypto");
const path = require("path");

// ---------- DB (umbrella.db 파일이 자동으로 만들어져요) ----------
const dbFile = path.join(__dirname, "umbrella.db");
const db = new sqlite3.Database(dbFile);

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS students (
      student_id TEXT PRIMARY KEY,   -- 학번
      name       TEXT NOT NULL,
      pw_hash    TEXT NOT NULL,      -- 비밀번호는 해시로만 저장
      created_at INTEGER NOT NULL
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS stations (
      code TEXT PRIMARY KEY,         -- A1, B2 ...
      name TEXT NOT NULL
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS umbrellas (
      tag_uid TEXT PRIMARY KEY,      -- 손잡이 RFID 번호
      station TEXT,
      slot    INTEGER,
      status  TEXT DEFAULT 'in'      -- in(보관 중) / out(대여 중)
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS rentals (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id  TEXT NOT NULL,
      tag_uid     TEXT,
      rented_at   INTEGER NOT NULL,
      due_at      INTEGER NOT NULL,  -- 대여 시각 + 48시간
      returned_at INTEGER            -- NULL이면 대여 중
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS commands (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      station TEXT,
      slot    INTEGER,
      action  TEXT,                  -- open / close
      done    INTEGER DEFAULT 0
    );
  `);

  const addStation = db.prepare("INSERT OR IGNORE INTO stations(code, name) VALUES (?, ?)");
  [["A1", "학생회관 1층 정문"], ["B2", "중앙도서관 출입구"], ["C3", "공학관 로비"]]
    .forEach((s) => addStation.run(s[0], s[1]));
  addStation.finalize();
});

// ---------- 비밀번호 해시 ----------
function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  return salt.toString("hex") + ":" + crypto.scryptSync(pw, salt, 64).toString("hex");
}
function checkPw(pw, stored) {
  const [s, h] = stored.split(":");
  const t = crypto.scryptSync(pw, Buffer.from(s, "hex"), 64);
  return crypto.timingSafeEqual(t, Buffer.from(h, "hex"));
}

// ---------- API ----------
const sessions = new Map(); // token -> { id, exp }
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.post("/api/signup", (req, res) => {
  const { studentId, name, password } = req.body || {};
  if (!/^\d{6,10}$/.test(studentId || ""))
    return res.status(400).json({ error: "학번은 숫자 6~10자리로 입력해 주세요." });
  if (!name || name.trim().length < 1 || name.length > 20)
    return res.status(400).json({ error: "이름을 입력해 주세요." });
  if (!password || password.length < 6)
    return res.status(400).json({ error: "비밀번호는 6자 이상이어야 해요." });
  
  db.get("SELECT 1 FROM students WHERE student_id = ?", [studentId], (err, row) => {
    if (row) return res.status(409).json({ error: "이미 가입된 학번이에요." });
    
    db.run("INSERT INTO students(student_id, name, pw_hash, created_at) VALUES (?,?,?,?)",
      [studentId, name.trim(), hashPw(password), Date.now()], (err2) => {
        if (err2) return res.status(500).json({ error: "회원가입 중 오류가 발생했어요." });
        res.status(201).json({ ok: true });
      });
  });
});

app.post("/api/login", (req, res) => {
  const { studentId, password } = req.body || {};
  db.get("SELECT * FROM students WHERE student_id = ?", [studentId || ""], (err, u) => {
    if (!u || !checkPw(password || "", u.pw_hash))
      return res.status(401).json({ error: "학번 또는 비밀번호가 맞지 않아요." });
    const token = crypto.randomBytes(24).toString("hex");
    sessions.set(token, { id: u.student_id, exp: Date.now() + 24 * 3600 * 1000 });
    res.json({ token, name: u.name });
  });
});

app.get("/api/me", (req, res) => {
  const t = (req.headers.authorization || "").replace("Bearer ", "");
  const s = sessions.get(t);
  if (!s || s.exp < Date.now()) return res.status(401).json({ error: "로그인이 필요해요." });
  db.get("SELECT student_id, name FROM students WHERE student_id = ?", [s.id], (err, u) => {
    if (!u) return res.status(404).json({ error: "사용자를 찾을 수 없어요." });
    res.json({ studentId: u.student_id, name: u.name });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("http://localhost:" + PORT + "/signup.html"));

// ---------- 우산 대여/반납 및 아두이노 제어 API ----------

// 1. 대여소 및 슬롯 상태 조회 API
app.get("/api/station/:code", (req, res) => {
  const code = req.params.code;
  db.all("SELECT * FROM umbrellas WHERE station = ?", [code], (err, rows) => {
    if (err) return res.status(500).json({ error: "데이터를 불러오지 못했어요." });
    res.json({ station: code, slots: rows });
  });
});

// 2. 문 열기 및 대여/반납 처리 API (아두이노 연동 지점)
app.post("/api/open", (req, res) => {
  const { station, slot, studentId, action } = req.body;
  
  // 여기에 아두이노로 보낼 명령어를 stations/commands 테이블에 저장하는 로직을 넣을 수 있습니다.
  db.run("INSERT INTO commands (station, slot, action, done) VALUES (?, ?, ?, 0)", 
    [station, slot, action || "open"], (err) => {
      if (err) return res.status(500).json({ error: "하드웨어 제어 명령을 등록하지 못했어요." });
      res.json({ ok: true, message: `${slot}번 문 열기 명령이 전송되었습니다.` });
    });
});