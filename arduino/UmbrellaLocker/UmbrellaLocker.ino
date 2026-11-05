/*
  Umbrella Locker — Arduino UNO R4 WiFi (슬롯 1·2)

  문은 "명령"으로만 열린다 (웹앱 대여/반납 → Firestore `commands`).
    open         대여. IR로 우산이 사라지면 잠시 후 자동 닫힘
    open_return  반납. RFID+IR(또는 IR만 5초)로 우산을 확인하면 잠시 후 자동 닫힘
  보드는 진행 상황을 `device_events` 로 올리고(open / rfid / return_ok / auto_close…)
  웹앱은 그 이벤트를 보고 문 닫힘 애니메이션·화면 전환을 맞춘다.

  통신 (유선이 우선)
    1) USB 브리지 : PC `npm run bridge:firebase` → 시리얼 PING / OPEN / OPEN_RETURN
    2) WiFi       : Firebase Auth + Firestore REST 직접 폴링 (PC 불필요)

  시리얼 프로토콜 (9600, 줄 단위)
    PC → MCU : PING | OPEN <slot> | OPEN_RETURN <slot>
    MCU → PC : PONG | ACK/DONE OPEN[_RETURN] <slot> | ERR …
               EVENT RFID <slot> <uid> | EVENT RETURN_OK <slot> | EVENT SERVO <slot> <action>

  핀: RFID1 SS D10 / RST D9, RFID2 SS D8 / RST D7, Servo D5 / D6, IR D2 / D3
  업로드 전 WIFI_* 와 STATION_CODE 를 현장 값으로 바꾸세요.
  FB_API_KEY 는 보드 전용 API 키 (웹 Browser key 와 다름, 리퍼러 제한 없음).
  DEVICE_PASS 는 Firebase Auth(device@…) 비밀번호와 같게.
*/

#include <SPI.h>
#include <MFRC522.h>
#include <Servo.h>
#include <WiFiS3.h>
#include <WiFiSSLClient.h>

// ========== 사용자 설정 ==========
const char* WIFI_SSID    = "ASCEE";
const char* WIFI_PASS    = "a028287138";
const char* FB_API_KEY   = "AIzaSyAEBkaVsNmojtkwePnQMISElzPNK4nY1ZE";
const char* FB_PROJECT   = "umbrella-c8cf0";
const char* DEVICE_EMAIL = "device@umbrella.local";
const char* DEVICE_PASS  = "device-change-me";
const char* STATION_CODE = "C3";   // 웹앱 STATIONS 중 live 거점 (형남공학관 2층 입구)
const bool  ENABLE_SERVO = true;
const bool  ENABLE_WIFI  = true;   // false → USB 브리지만
// =================================

const uint8_t SS_PINS[2]    = { 10, 8 };
const uint8_t RST_PINS[2]   = { 9, 7 };
const uint8_t IR_PINS[2]    = { 2, 3 };
const uint8_t SERVO_PINS[2] = { 5, 6 };
const bool IR_ACTIVE_LOW = true;

const int DOOR_CLOSED_DEG = 0;
const int DOOR_OPEN_DEG   = 90;
const unsigned long STEP_OPEN_MS  = 8;    // 열 때
const unsigned long STEP_CLOSE_MS = 14;   // 닫을 때 더 부드럽게

const unsigned long RFID_COOLDOWN_MS     = 1500;
const unsigned long IR_HOLD_MS           = 1000;   // 반납: IR 연속 감지
const unsigned long IR_GONE_STABLE_MS    = 700;    // 대여: IR 연속 미감지
const unsigned long OPEN_PRESENT_WAIT_MS = 4000;   // 대여: 처음부터 비어 있으면 꺼냄 감지로 전환
const unsigned long RETURN_IR_ONLY_MS    = 5000;   // 반납: 태그 없이 IR만 이 시간이면 인정
const unsigned long AUTO_CLOSE_DELAY_MS  = 2000;   // 감지 후 닫기까지 대기
const unsigned long OPEN_MAX_MS          = 25000;  // 안전: 강제 닫힘
const unsigned long POLL_MS              = 4000;
const unsigned long WIFI_RETRY_MS        = 10000;
const unsigned long WIRED_TIMEOUT_MS     = 5000;
const unsigned long TOKEN_REFRESH_MS     = 50UL * 60UL * 1000UL;
const unsigned long CMD_MAX_AGE_S        = 120;    // 이보다 오래된 명령은 실행 없이 done
const int HTTP_BODY_MAX = 6000;

enum DoorState : uint8_t {
  DOOR_IDLE = 0,
  RENT_WAIT_PRESENT,  // 대여: 우산이 보이는지 확인
  RENT_WAIT_GONE,     // 대여: 우산이 사라질 때까지
  RENT_WAIT_DELAY,    // 대여: 사라진 뒤 닫기 전 대기
  RET_WAIT_DETECT,    // 반납: RFID + IR
  RET_WAIT_DELAY,     // 반납: 인식 후 닫기 전 대기
};

struct Slot {
  uint8_t id = 0;
  MFRC522 rfid;
  Servo servo;
  int angle = DOOR_CLOSED_DEG;
  unsigned long lastTagMs = 0;
  DoorState door = DOOR_IDLE;
  unsigned long stateAt = 0;   // 현재 상태 진입 시각
  unsigned long openedAt = 0;  // 문 연 시각 (OPEN_MAX)
  unsigned long irSince = 0;   // IR 연속 감지/미감지 시작
  bool rfidOk = false;
  String cmd;                  // 문을 연 명령 id (이벤트에 첨부)
};

Slot slots[2];
WiFiSSLClient ssl;

bool wiredMode = false;
unsigned long lastPingMs = 0;
unsigned long lastPollMs = 0;
unsigned long lastWifiTryMs = 0;
unsigned long tokenAtMs = 0;
String idToken;
String serialBuf;
String lastCmdId;            // 같은 명령 재실행 방지 (done PATCH 실패 시 재시도만)
bool netReadyOnce = false;

// HTTP Date / NTP 로 맞춘 UTC 시계 (이벤트 created_at)
unsigned long clockEpochSec = 0;
unsigned long clockAtMs = 0;

// ---------- 시계 ----------
void setClock(unsigned long epochSec) {
  clockEpochSec = epochSec;
  clockAtMs = millis();
}

unsigned long nowEpochSec() {
  if (clockEpochSec) return clockEpochSec + (millis() - clockAtMs) / 1000;
  unsigned long t = WiFi.getTime();
  if (t > 1700000000UL) { setClock(t); return t; }
  return 0;
}

String epochMsString() {
  unsigned long sec = nowEpochSec();
  if (!sec) {
    unsigned long t = WiFi.getTime();
    if (t > 1700000000UL) { setClock(t); sec = t; }
  }
  if (!sec) return "0";
  unsigned long d = millis() - clockAtMs;
  char tail[4];
  snprintf(tail, sizeof tail, "%03u", (unsigned)(d % 1000));
  return String(sec) + tail;
}

/** "Tue, 04 Nov 2026 03:12:45 GMT" → UTC epoch 초 (실패 0) */
unsigned long parseHttpDate(String v) {
  int comma = v.indexOf(',');
  if (comma >= 0) v = v.substring(comma + 1);
  v.trim();
  int d, y, hh, mm, ss;
  char mon[4] = { 0 };
  if (sscanf(v.c_str(), "%d %3s %d %d:%d:%d", &d, mon, &y, &hh, &mm, &ss) != 6) return 0;
  const char* names = "JanFebMarAprMayJunJulAugSepOctNovDec";
  const char* p = strstr(names, mon);
  if (!p) return 0;
  int m = (p - names) / 3 + 1;
  y -= m <= 2;                                    // days_from_civil (H. Hinnant)
  long era = (y >= 0 ? y : y - 399) / 400;
  unsigned yoe = (unsigned)(y - era * 400);
  unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  long days = era * 146097 + (long)doe - 719468;
  return (unsigned long)days * 86400UL + (unsigned long)hh * 3600UL + mm * 60UL + ss;
}

// ---------- 하드웨어 ----------
bool irPresent(const Slot& s) {
  int v = digitalRead(IR_PINS[s.id - 1]);
  return IR_ACTIVE_LOW ? (v == LOW) : (v == HIGH);
}

Slot* slotByNo(int n) {
  return (n == 1 || n == 2) ? &slots[n - 1] : nullptr;
}

void recoverRfid() {
  for (Slot& s : slots) s.rfid.PCD_Init();
}

String uidToString(const MFRC522::Uid& uid) {
  String s;
  for (byte i = 0; i < uid.size; i++) {
    if (uid.uidByte[i] < 0x10) s += "0";
    s += String(uid.uidByte[i], HEX);
    if (i + 1 < uid.size) s += ":";
  }
  s.toUpperCase();
  return s;
}

void moveDoor(Slot& s, int target, unsigned long stepMs) {
  Serial.print("[SERVO] slot "); Serial.print(s.id);
  Serial.print(" "); Serial.print(s.angle); Serial.print(" -> "); Serial.println(target);
  if (!ENABLE_SERVO) { s.angle = target; return; }
  int step = target > s.angle ? 1 : -1;
  while (s.angle != target) {
    s.angle += step;
    s.servo.write(s.angle);
    delay(stepMs);
  }
}

void openDoor(Slot& s) {
  moveDoor(s, DOOR_OPEN_DEG, STEP_OPEN_MS);
  recoverRfid();
}

void closeDoor(Slot& s) {
  moveDoor(s, DOOR_CLOSED_DEG, STEP_CLOSE_MS);
  delay(120);
  recoverRfid();
}

// ---------- 링크 ----------
bool isWired() {
  return wiredMode && (millis() - lastPingMs < WIRED_TIMEOUT_MS);
}

void updateLinkMode() {
  static bool prev = false;
  bool now = isWired();
  if (now == prev) return;
  prev = now;
  Serial.println(now ? "[LINK] WIRED (USB bridge)" : "[LINK] WIFI (Firestore)");
}

// ---------- 이벤트 ----------
void reportEventFirebase(const Slot& s, const char* kind, const String& extra);

void reportEvent(const Slot& s, const char* kind, const String& extra) {
  if (!isWired()) { reportEventFirebase(s, kind, extra); return; }
  if (strcmp(kind, "rfid") == 0) {
    Serial.print("EVENT RFID "); Serial.print(s.id); Serial.print(" "); Serial.println(extra);
  } else if (strcmp(kind, "return_ok") == 0) {
    Serial.print("EVENT RETURN_OK "); Serial.println(s.id);
  } else {
    Serial.print("EVENT SERVO "); Serial.print(s.id); Serial.print(" "); Serial.println(extra);
  }
}

// ---------- 문 감시 (자동 닫힘) ----------
void startWatch(Slot& s, bool isReturn) {
  s.door = isReturn ? RET_WAIT_DETECT : RENT_WAIT_PRESENT;
  s.stateAt = s.openedAt = millis();
  s.irSince = 0;
  s.rfidOk = false;
  Serial.print(isReturn ? "[DOOR] return-watch slot " : "[DOOR] rent-watch slot ");
  Serial.println(s.id);
}

void finishWatch(Slot& s, const char* action) {
  Serial.print("[DOOR] "); Serial.print(action); Serial.print(" slot "); Serial.println(s.id);
  closeDoor(s);
  reportEvent(s, "servo", action);
  s.door = DOOR_IDLE;
  s.cmd = "";
}

void updateWatch(Slot& s) {
  if (s.door == DOOR_IDLE) return;
  const unsigned long now = millis();
  const bool present = irPresent(s);
  const bool isReturn = s.door >= RET_WAIT_DETECT;

  if (now - s.openedAt >= OPEN_MAX_MS) {
    finishWatch(s, isReturn ? "auto_close_return_timeout" : "auto_close_timeout");
    return;
  }

  switch (s.door) {
    case RET_WAIT_DETECT: {
      if (!present) { s.irSince = 0; return; }
      if (!s.irSince) s.irSince = now;
      const unsigned long held = now - s.irSince;
      const bool byTag = s.rfidOk && held >= IR_HOLD_MS;
      const bool byIrOnly = held >= RETURN_IR_ONLY_MS;
      if (!byTag && !byIrOnly) return;
      Serial.print("[DOOR] return detected slot "); Serial.println(s.id);
      reportEvent(s, "return_ok", byTag ? "rfid_ir" : "ir");
      s.door = RET_WAIT_DELAY;
      s.stateAt = now;
      return;
    }
    case RET_WAIT_DELAY:
      if (now - s.stateAt >= AUTO_CLOSE_DELAY_MS) finishWatch(s, "auto_close_return");
      return;

    case RENT_WAIT_PRESENT:
      if (present) {
        Serial.print("[DOOR] umbrella present slot "); Serial.println(s.id);
        s.door = RENT_WAIT_GONE;
        s.irSince = 0;
      } else if (now - s.stateAt >= OPEN_PRESENT_WAIT_MS) {
        Serial.print("[DOOR] already empty slot "); Serial.println(s.id);
        s.door = RENT_WAIT_GONE;
        s.irSince = now;
      }
      return;
    case RENT_WAIT_GONE:
      if (present) { s.irSince = 0; return; }
      if (!s.irSince) s.irSince = now;
      if (now - s.irSince >= IR_GONE_STABLE_MS) {
        Serial.print("[DOOR] umbrella gone slot "); Serial.println(s.id);
        s.door = RENT_WAIT_DELAY;
        s.stateAt = now;
      }
      return;
    case RENT_WAIT_DELAY:
      if (present) {               // 다시 넣음 → 꺼냄 대기로 복귀
        s.door = RENT_WAIT_GONE;
        s.irSince = 0;
        return;
      }
      if (now - s.stateAt >= AUTO_CLOSE_DELAY_MS) finishWatch(s, "auto_close");
      return;
    default:
      return;
  }
}

/** RFID: 반납 감시 중일 때만 의미 있음 (평소엔 로그만, 문을 열지 않음) */
void handleReader(Slot& s) {
  if (!s.rfid.PICC_IsNewCardPresent() || !s.rfid.PICC_ReadCardSerial()) return;
  String uid = uidToString(s.rfid.uid);
  s.rfid.PICC_HaltA();
  s.rfid.PCD_StopCrypto1();
  if (millis() - s.lastTagMs < RFID_COOLDOWN_MS) return;
  s.lastTagMs = millis();
  Serial.print("[RFID] slot "); Serial.print(s.id); Serial.print(" UID="); Serial.println(uid);
  if (s.door == RET_WAIT_DETECT && !s.rfidOk) {
    s.rfidOk = true;
    reportEvent(s, "rfid", uid);   // 반납 우산 태그 → umbrellas.tag_uid
  }
}

void executeCommand(Slot& s, bool isReturn, const String& cmdId) {
  s.cmd = cmdId;
  openDoor(s);
  reportEvent(s, "servo", isReturn ? "open_return" : "open");
  startWatch(s, isReturn);
}

// ---------- 시리얼 (USB 브리지) ----------
void handleSerialLine(String line) {
  line.trim();
  if (!line.length()) return;
  if (line == "PING") {
    lastPingMs = millis();
    wiredMode = true;
    Serial.println("PONG");
    return;
  }
  const bool isReturn = line.startsWith("OPEN_RETURN ");
  if (!isReturn && !line.startsWith("OPEN ")) return;
  const char* verb = isReturn ? "OPEN_RETURN" : "OPEN";
  const int slotNo = line.substring(isReturn ? 12 : 5).toInt();
  Slot* s = slotByNo(slotNo);
  if (!s) { Serial.print("ERR "); Serial.print(verb); Serial.println(" bad slot"); return; }
  lastPingMs = millis();
  wiredMode = true;
  Serial.print("ACK "); Serial.print(verb); Serial.print(' '); Serial.println(slotNo);
  executeCommand(*s, isReturn, "");   // 유선: 명령 id는 브리지가 이벤트에 붙임
  Serial.print("DONE "); Serial.print(verb); Serial.print(' '); Serial.println(slotNo);
}

void pollSerial() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      if (serialBuf.length()) { handleSerialLine(serialBuf); serialBuf = ""; }
    } else {
      serialBuf += c;
      if (serialBuf.length() > 80) serialBuf = "";
    }
  }
}

// ---------- JSON 헬퍼 (Firestore REST) ----------
/** "key": "value" (탑레벨 문자열) */
String jsonString(const String& json, const char* key, int from = 0) {
  String k = String("\"") + key + "\"";
  int i = json.indexOf(k, from);
  if (i < 0) return "";
  i = json.indexOf(':', i + k.length());
  if (i < 0) return "";
  i = json.indexOf('"', i);
  if (i < 0) return "";
  int j = ++i;
  while (j < (int)json.length() && !(json[j] == '"' && json[j - 1] != '\\')) j++;
  if (j >= (int)json.length()) return "";   // 잘린 응답
  return json.substring(i, j);
}

/** "field": { "typeKey": "value" } — from~to 범위 안에서만 */
String fieldValue(const String& json, const char* field, const char* typeKey, int from, int to) {
  String needle = String("\"") + field + "\"";
  int i = json.indexOf(needle, from);
  if (i < 0 || (to > 0 && i > to)) return "";
  String tk = String("\"") + typeKey + "\":";
  int v = json.indexOf(tk, i);
  if (v < 0 || v - i > 80) return "";
  v += tk.length();
  while (v < (int)json.length() && (json[v] == ' ' || json[v] == '"')) v++;
  int e = v;
  while (e < (int)json.length() && json[e] != '"' && json[e] != ',' && json[e] != '}' && json[e] != '\n') e++;
  String out = json.substring(v, e);
  out.trim();
  return out;
}

/** ms 문자열("1762225965123") → 초 */
unsigned long msStringToSec(const String& ms) {
  if (ms.length() <= 3) return 0;
  return (unsigned long)ms.substring(0, ms.length() - 3).toInt();
}

// ---------- 네트워크 ----------
bool wifiConfigured() {
  return strlen(WIFI_SSID) > 0 && strcmp(WIFI_SSID, "YOUR_SSID") != 0;
}

/** DNS/NTP 준비 — 시각이 1970이면 TLS 검증이 실패하는 펌웨어가 있어 한 번 대기 */
bool waitForNetworkReady() {
  if (WiFi.status() != WL_CONNECTED) return false;
  if (WiFi.localIP() == IPAddress(0, 0, 0, 0)) {
    Serial.println("[NET] IP 0.0.0.0 — DHCP/2.4GHz 확인");
    return false;
  }
  if (netReadyOnce) return true;

  IPAddress dnsIp;
  unsigned long start = millis();
  while (WiFi.hostByName("identitytoolkit.googleapis.com", dnsIp) != 1) {
    if (millis() - start > 20000) {
      Serial.println("[NET] DNS fail — 인터넷/방화벽 확인");
      return false;
    }
    delay(500);
  }
  Serial.print("[NET] DNS OK "); Serial.println(dnsIp);

  start = millis();
  while (millis() - start < 8000) {
    if (nowEpochSec()) { Serial.println("[NET] NTP OK"); break; }
    delay(500);
  }
  if (!clockEpochSec) Serial.println("[NET] NTP 미동기(경고) — HTTP Date 로 시계 보정");
  netReadyOnce = true;
  return true;
}

void ensureWifi() {
  if (!ENABLE_WIFI || WiFi.status() == WL_CONNECTED) return;
  if (!wifiConfigured()) {
    static bool warned = false;
    if (!warned) { warned = true; Serial.println("[WIFI] SSID 미설정 — 유선(bridge)만 사용 가능"); }
    return;
  }
  if (millis() - lastWifiTryMs < WIFI_RETRY_MS) return;
  lastWifiTryMs = millis();

  Serial.print("[WIFI] connect "); Serial.println(WIFI_SSID);
  netReadyOnce = false;
  WiFi.disconnect();
  delay(100);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 12000) {
    delay(300);
    Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[WIFI] fail — 2.4GHz / SSID·비번 확인");
    return;
  }
  Serial.print("[WIFI] OK "); Serial.print(WiFi.localIP());
  Serial.print(" fw="); Serial.println(WiFi.firmwareVersion());
  waitForNetworkReady();
}

bool sslConnectWithRetry(const char* host) {
  for (int i = 1; i <= 3; i++) {
    if (ssl.connected()) ssl.stop();
    delay(50);
    if (ssl.connect(host, 443)) return true;
    Serial.print("[HTTPS] connect retry "); Serial.println(i);
    delay(400 * i);
  }
  Serial.print("[HTTPS] connect fail "); Serial.println(host);
  return false;
}

void readBodyBytes(String& out, long remain, unsigned long deadline) {
  while (remain > 0 && millis() < deadline) {
    if (!ssl.available()) { delay(2); continue; }
    int b = ssl.read();
    if (b < 0) break;
    if ((int)out.length() < HTTP_BODY_MAX) out += (char)b;
    remain--;
  }
}

/** HTTPS 요청 (gzip 금지, Content-Length / chunked / close 지원). Date 헤더로 시계 보정. */
bool httpsRequest(const char* host, const char* method, const String& path,
                  const String& body, const String& bearer, String& responseOut,
                  int timeoutMs = 20000) {
  responseOut = "";
  if (!waitForNetworkReady() || !sslConnectWithRetry(host)) return false;

  ssl.print(method); ssl.print(" "); ssl.print(path); ssl.println(" HTTP/1.1");
  ssl.print("Host: "); ssl.println(host);
  ssl.println("Connection: close");
  ssl.println("Accept: application/json");
  ssl.println("Accept-Encoding: identity");
  ssl.println("User-Agent: UmbrellaLocker/2.0");
  if (bearer.length()) { ssl.print("Authorization: Bearer "); ssl.println(bearer); }
  if (body.length()) {
    ssl.println("Content-Type: application/json");
    ssl.print("Content-Length: "); ssl.println(body.length());
    ssl.println();
    ssl.print(body);
  } else {
    ssl.println();
  }
  ssl.flush();

  const unsigned long deadline = millis() + (unsigned long)timeoutMs;
  while (!ssl.available() && millis() < deadline) delay(10);
  if (!ssl.available()) {
    Serial.println("[HTTPS] no response");
    ssl.stop();
    return false;
  }

  String statusLine = ssl.readStringUntil('\n');
  statusLine.trim();
  const bool ok = statusLine.indexOf(" 200") >= 0 || statusLine.indexOf(" 201") >= 0;

  bool chunked = false;
  long contentLength = -1;
  while (millis() < deadline) {
    if (!ssl.available()) {
      if (!ssl.connected()) break;
      delay(2);
      continue;
    }
    String line = ssl.readStringUntil('\n');
    line.trim();
    if (!line.length()) break;
    String low = line;
    low.toLowerCase();
    if (low.startsWith("transfer-encoding:") && low.indexOf("chunked") >= 0) chunked = true;
    else if (low.startsWith("content-length:")) contentLength = low.substring(15).toInt();
    else if (low.startsWith("date:")) {
      unsigned long t = parseHttpDate(line.substring(5));
      if (t > 1700000000UL) setClock(t);
    }
  }

  if (chunked) {
    while (millis() < deadline && (int)responseOut.length() < HTTP_BODY_MAX) {
      String sizeLine = ssl.readStringUntil('\n');
      sizeLine.trim();
      if (!sizeLine.length()) continue;
      long n = strtol(sizeLine.c_str(), nullptr, 16);
      if (n <= 0) break;
      readBodyBytes(responseOut, n, deadline);
      ssl.readStringUntil('\n');
    }
  } else if (contentLength > 0) {
    readBodyBytes(responseOut, contentLength, deadline);
  } else {
    while (millis() < deadline) {
      while (ssl.available()) {
        int b = ssl.read();
        if (b < 0) break;
        if ((int)responseOut.length() < HTTP_BODY_MAX) responseOut += (char)b;
      }
      if (!ssl.connected() && !ssl.available()) break;
      delay(5);
    }
  }
  ssl.stop();

  if (!ok) {
    Serial.print("[HTTPS] "); Serial.println(statusLine);
    Serial.print("[HTTPS] body="); Serial.println(responseOut.substring(0, 220));
  }
  return ok;
}

// ---------- Firebase ----------
String firestorePath(const String& tail) {
  return String("/v1/projects/") + FB_PROJECT + "/databases/(default)/documents" + tail;
}

bool firebaseLogin(bool force = false) {
  if (!force && idToken.length() && millis() - tokenAtMs < TOKEN_REFRESH_MS) return true;
  ensureWifi();
  if (WiFi.status() != WL_CONNECTED) return false;

  String body = String("{\"email\":\"") + DEVICE_EMAIL + "\",\"password\":\"" + DEVICE_PASS +
                "\",\"returnSecureToken\":true}";
  String resp;
  Serial.println("[AUTH] login…");
  if (!httpsRequest("identitytoolkit.googleapis.com", "POST",
                    String("/v1/accounts:signInWithPassword?key=") + FB_API_KEY, body, "", resp, 25000)) {
    Serial.println("[AUTH] fail");
    idToken = "";
    return false;
  }
  idToken = jsonString(resp, "idToken");
  if (!idToken.length()) {
    Serial.print("[AUTH] no idToken body="); Serial.println(resp.substring(0, 240));
    if (resp.indexOf("EMAIL_NOT_FOUND") >= 0 || resp.indexOf("INVALID_PASSWORD") >= 0 ||
        resp.indexOf("INVALID_LOGIN_CREDENTIALS") >= 0) {
      Serial.println("[AUTH] device 이메일/비밀번호 확인 (firebase-config.js 와 동일해야 함)");
    }
    return false;
  }
  tokenAtMs = millis();
  Serial.println("[AUTH] OK");
  return true;
}

bool firestoreWrite(const char* method, const String& path, const String& body) {
  if (!firebaseLogin()) return false;
  String resp;
  if (httpsRequest("firestore.googleapis.com", method, path, body, idToken, resp)) return true;
  // 토큰 만료 가능 → 재로그인 후 1회 재시도
  if (!firebaseLogin(true)) return false;
  return httpsRequest("firestore.googleapis.com", method, path, body, idToken, resp);
}

bool markCommandDone(const String& docId) {
  String body = String("{\"fields\":{\"done\":{\"integerValue\":\"1\"},") +
                "\"done_at\":{\"integerValue\":\"" + epochMsString() + "\"}}}";
  bool ok = firestoreWrite("PATCH",
      firestorePath("/commands/" + docId + "?updateMask.fieldPaths=done&updateMask.fieldPaths=done_at"), body);
  Serial.println(ok ? "[CMD] done" : "[CMD] done 실패 — 다음 폴링에서 재시도");
  return ok;
}

void reportEventFirebase(const Slot& s, const char* kind, const String& extra) {
  String payload;
  if (strcmp(kind, "rfid") == 0) payload = String("\"uid\":{\"stringValue\":\"") + extra + "\"}";
  else if (strcmp(kind, "return_ok") == 0) payload = String("\"source\":{\"stringValue\":\"") + extra + "\"}";
  else payload = String("\"action\":{\"stringValue\":\"") + extra + "\"},\"deg\":{\"integerValue\":\"" + DOOR_OPEN_DEG + "\"}";

  const String created = epochMsString();
  String body = String("{\"fields\":{") +
                "\"station\":{\"stringValue\":\"" + STATION_CODE + "\"}," +
                "\"slot\":{\"integerValue\":\"" + String(s.id) + "\"}," +
                "\"kind\":{\"stringValue\":\"" + kind + "\"}," +
                "\"payload\":{\"mapValue\":{\"fields\":{" + payload + "}}}," +
                (s.cmd.length() ? "\"cmd\":{\"stringValue\":\"" + s.cmd + "\"}," : String("")) +
                "\"created_at\":{\"integerValue\":\"" + created + "\"}}}";
  firestoreWrite("POST", firestorePath("/device_events"), body);

  if (strcmp(kind, "rfid") == 0 && extra.length()) {
    String uid = extra;
    uid.replace(":", "");
    String ubody = String("{\"fields\":{\"tag_uid\":{\"stringValue\":\"") + uid + "\"}," +
                   "\"updated_at\":{\"integerValue\":\"" + created + "\"}}}";
    firestoreWrite("PATCH", firestorePath(String("/umbrellas/") + STATION_CODE + "-" + String(s.id) +
                   "?updateMask.fieldPaths=tag_uid&updateMask.fieldPaths=updated_at"), ubody);
  }
}

/** stations/{code} 하트비트 — 장치 화면 / 앱의 "보드 온라인" 판단 */
void reportPresence() {
  IPAddress ip = WiFi.localIP();
  String body = String("{\"fields\":{") +
                "\"code\":{\"stringValue\":\"" + STATION_CODE + "\"}," +
                "\"last_seen\":{\"integerValue\":\"" + epochMsString() + "\"}," +
                "\"link\":{\"stringValue\":\"wifi\"}," +
                "\"wifi_rssi\":{\"integerValue\":\"" + String((long)WiFi.RSSI()) + "\"}," +
                "\"wifi_ip\":{\"stringValue\":\"" + String(ip[0]) + "." + ip[1] + "." + ip[2] + "." + ip[3] + "\"}," +
                "\"mcu_ok\":{\"booleanValue\":true}}}";
  firestoreWrite("PATCH", firestorePath(String("/stations/") + STATION_CODE +
                 "?updateMask.fieldPaths=code&updateMask.fieldPaths=last_seen&updateMask.fieldPaths=link" +
                 "&updateMask.fieldPaths=wifi_rssi&updateMask.fieldPaths=wifi_ip&updateMask.fieldPaths=mcu_ok"), body);
}

/** station==STATION_CODE && done==0 인 가장 오래된 명령 1건 실행 */
void pollCommands() {
  ensureWifi();
  if (WiFi.status() != WL_CONNECTED) { Serial.println("[POLL] WiFi 끊김"); return; }
  if (!firebaseLogin()) { Serial.println("[POLL] Auth 실패"); return; }

  String body = String("{\"structuredQuery\":{\"from\":[{\"collectionId\":\"commands\"}],") +
                "\"where\":{\"compositeFilter\":{\"op\":\"AND\",\"filters\":[" +
                "{\"fieldFilter\":{\"field\":{\"fieldPath\":\"station\"},\"op\":\"EQUAL\",\"value\":{\"stringValue\":\"" + STATION_CODE + "\"}}}," +
                "{\"fieldFilter\":{\"field\":{\"fieldPath\":\"done\"},\"op\":\"EQUAL\",\"value\":{\"integerValue\":\"0\"}}}]}}," +
                "\"orderBy\":[{\"field\":{\"fieldPath\":\"created_at\"},\"direction\":\"ASCENDING\"}],\"limit\":3}}";
  String resp;
  const String path = firestorePath(":runQuery");
  if (!httpsRequest("firestore.googleapis.com", "POST", path, body, idToken, resp, 15000)) {
    if (!firebaseLogin(true)) return;
    if (!httpsRequest("firestore.googleapis.com", "POST", path, body, idToken, resp, 15000)) return;
  }
  reportPresence();   // Firestore 왕복 성공 → 하트비트

  const int docPos = resp.indexOf("\"document\"");
  if (docPos < 0) return;   // 대기 명령 없음
  const int docEnd = resp.indexOf("\"document\"", docPos + 10);

  String fullName = jsonString(resp, "name", docPos);
  const String docId = fullName.substring(fullName.lastIndexOf('/') + 1);
  if (!docId.length()) return;
  const int slotNo = fieldValue(resp, "slot", "integerValue", docPos, docEnd).toInt();
  const bool isReturn = fieldValue(resp, "action", "stringValue", docPos, docEnd) == "open_return";
  const unsigned long createdSec = msStringToSec(fieldValue(resp, "created_at", "integerValue", docPos, docEnd));
  const unsigned long nowSec = nowEpochSec();

  Serial.print("[CMD] id="); Serial.print(docId);
  Serial.print(" slot="); Serial.print(slotNo);
  Serial.println(isReturn ? " open_return" : " open");

  Slot* s = slotByNo(slotNo);
  if (!s) {
    Serial.println("[CMD] invalid slot → done");
    markCommandDone(docId);
    return;
  }
  if (nowSec && createdSec && nowSec > createdSec + CMD_MAX_AGE_S) {
    Serial.println("[CMD] stale (>2min) → done without opening");
    markCommandDone(docId);
    return;
  }
  if (docId == lastCmdId) {       // 이전 done PATCH 실패 → 문 다시 열지 않고 done만 재시도
    markCommandDone(docId);
    return;
  }
  lastCmdId = docId;
  executeCommand(*s, isReturn, docId);
  markCommandDone(docId);
}

// ---------- 메인 ----------
void setup() {
  Serial.begin(9600);
  while (!Serial && millis() < 3000) {}
  delay(200);
  Serial.println("[BOOT] UmbrellaLocker v2 — command-driven doors");

  for (int i = 0; i < 2; i++) {
    pinMode(SS_PINS[i], OUTPUT);
    digitalWrite(SS_PINS[i], HIGH);
    pinMode(IR_PINS[i], INPUT);
  }
  SPI.begin();
  for (int i = 0; i < 2; i++) {
    Slot& s = slots[i];
    s.id = i + 1;
    s.rfid.PCD_Init(SS_PINS[i], RST_PINS[i]);
    Serial.print("[BOOT] RFID"); Serial.print(s.id); Serial.print(" ver=0x");
    Serial.println(s.rfid.PCD_ReadRegister(MFRC522::VersionReg), HEX);
    if (ENABLE_SERVO) {
      s.servo.attach(SERVO_PINS[i]);
      s.servo.write(DOOR_CLOSED_DEG);
      delay(500);
    }
  }

  if (ENABLE_WIFI && wifiConfigured()) {
    ensureWifi();
    if (WiFi.status() == WL_CONNECTED) firebaseLogin(true);
  } else {
    Serial.println("[BOOT] WiFi 미설정 — USB bridge 로만 동작");
  }
  Serial.print("[BOOT] ready station="); Serial.println(STATION_CODE);
}

void loop() {
  pollSerial();
  updateLinkMode();
  for (Slot& s : slots) {
    updateWatch(s);
    handleReader(s);
  }
  if (isWired()) return;   // 브리지가 PING 중이면 WiFi 폴링 안 함
  if (slots[0].door != DOOR_IDLE || slots[1].door != DOOR_IDLE) return;   // 문 감시 중엔 HTTPS 쉬기
  if (millis() - lastPollMs >= POLL_MS) {
    lastPollMs = millis();
    pollCommands();
  }
}
