/*
  Umbrella Locker - UNO R4 WiFi (슬롯 1·2)

  통신 우선순위
  1) 유선(USB): PC에서 `npm run bridge:firebase` → PING/OPEN 시리얼
  2) WiFi(기본): Firebase Auth + Firestore REST 직접 폴링
     PC 없이도 웹(device/대여) 명령으로 서보 동작

  핀: RFID1 D10/D9, RFID2 D8/D7, Servo D5/D6, IR D2/D3

  업로드 전 아래 WIFI_* 만 본인 공유기 값으로 바꾸세요.
  Firebase API Key / device 계정은 웹 firebase-config.js 와 동일합니다.
*/

#include <SPI.h>
#include <MFRC522.h>
#include <Servo.h>
#include <WiFiS3.h>
#include <WiFiSSLClient.h>

// ========== 사용자 설정 ==========
const char* WIFI_SSID = "ASCEE";
const char* WIFI_PASS = "a028287138";

const char* FB_API_KEY   = "AIzaSyDoS0nXsS8lGBULN-U-WcLs51aqWC4lZfk";
const char* FB_PROJECT   = "umbrella-c8cf0";
const char* DEVICE_EMAIL = "device@umbrella.local";
const char* DEVICE_PASS  = "device-change-me";
const char* STATION_CODE = "A1";

const bool ENABLE_SERVO = true;
const bool ENABLE_WIFI  = true;   // false면 유선(bridge)만
// =================================

#define SS_1_PIN 10
#define RST_1_PIN 9
#define SS_2_PIN 8
#define RST_2_PIN 7
#define IR_1_PIN 2
#define IR_2_PIN 3

const bool IR_ACTIVE_LOW = true;
const unsigned long IR_HOLD_MS = 1000;
const unsigned long COOLDOWN_MS = 1500;
const unsigned long POLL_MS = 4000;
const unsigned long WIFI_RETRY_MS = 10000;
const unsigned long WIRED_TIMEOUT_MS = 5000;
const unsigned long TOKEN_REFRESH_MS = 50UL * 60UL * 1000UL; // 50분마다 재로그인

// 180° 서보: 닫힘 0 / 열림 90 (필요하면 DOOR_OPEN_DEG 만 조절)
const int DOOR_CLOSED_DEG = 0;
const int DOOR_OPEN_DEG = 90;
const unsigned long STEP_OPEN_MS = 8;   // 열 때
const unsigned long STEP_CLOSE_MS = 14; // 닫을 때 더 부드럽게(느리게)
const unsigned long IR_GONE_STABLE_MS = 700;   // 미감지 유지 시간
const unsigned long AUTO_CLOSE_DELAY_MS = 2000; // 사라진 뒤 문 닫기까지 대기
const unsigned long OPEN_PRESENT_WAIT_MS = 4000; // 처음부터 없으면 이 시간 후 꺼냄 감지로 전환
const unsigned long OPEN_MAX_MS = 25000;         // 안전: 강제 닫힘

const int servo1Pin = 5;
const int servo2Pin = 6;

// 문 자동닫힘 상태 (우산 꺼냄: 감지→미감지→대기→닫힘)
enum DoorWatch : uint8_t {
  DW_IDLE = 0,
  DW_WAIT_PRESENT, // 우산이 센서에 보이는지 대기
  DW_WAIT_GONE,    // 우산이 사라질 때까지 대기
  DW_WAIT_DELAY,   // 사라진 뒤 닫기 전 딜레이
};

MFRC522 mfrc522_1(SS_1_PIN, RST_1_PIN);
MFRC522 mfrc522_2(SS_2_PIN, RST_2_PIN);
Servo myServo1;
Servo myServo2;
WiFiSSLClient ssl;

int servoAngle1 = 0;
int servoAngle2 = 0;
unsigned long lastTagMs1 = 0, lastTagMs2 = 0;
unsigned long lastIrMs1 = 0, lastIrMs2 = 0;
unsigned long lastPollMs = 0;
unsigned long lastWifiTryMs = 0;
unsigned long lastPingMs = 0;
unsigned long tokenAtMs = 0;
bool wiredMode = false;
bool cmdBusy = false;
String serialBuf = "";
String idToken = "";

bool irArmed1 = false, irArmed2 = false;
bool irClosing1 = false, irClosing2 = false;
unsigned long irCloseStart1 = 0, irCloseStart2 = 0;

DoorWatch doorWatch1 = DW_IDLE, doorWatch2 = DW_IDLE;
unsigned long doorWatchAt1 = 0, doorWatchAt2 = 0;
unsigned long doorOpenAt1 = 0, doorOpenAt2 = 0;
unsigned long irGoneSince1 = 0, irGoneSince2 = 0;

bool irIsClose(int pin) {
  return IR_ACTIVE_LOW ? (digitalRead(pin) == LOW) : (digitalRead(pin) == HIGH);
}

int irPinForSlot(int slot) { return slot == 2 ? IR_2_PIN : IR_1_PIN; }

byte readVersion(MFRC522 &rfid) {
  return rfid.PCD_ReadRegister(MFRC522::VersionReg);
}

void recoverRfid() {
  mfrc522_1.PCD_Init();
  mfrc522_2.PCD_Init();
}

String uidToString(MFRC522::Uid *uid) {
  String s = "";
  for (byte i = 0; i < uid->size; i++) {
    if (uid->uidByte[i] < 0x10) s += "0";
    s += String(uid->uidByte[i], HEX);
    if (i + 1 < uid->size) s += ":";
  }
  s.toUpperCase();
  return s;
}

bool isWired() {
  return wiredMode && (millis() - lastPingMs < WIRED_TIMEOUT_MS);
}

void updateLinkMode() {
  bool now = isWired();
  static bool prev = false;
  if (now != prev) {
    prev = now;
    if (now) Serial.println("[LINK] WIRED (USB bridge)");
    else Serial.println("[LINK] WIFI (Firestore)");
  }
}

void sweepServo(Servo &servo, int &current, int target, unsigned long stepDelay) {
  if (target < DOOR_CLOSED_DEG) target = DOOR_CLOSED_DEG;
  if (target > 180) target = 180;
  int step = (target > current) ? 1 : -1;
  while (current != target) {
    current += step;
    servo.write(current);
    delay(stepDelay);
  }
}

void moveDoor(Servo &servo, int &current, int slot, int angle, unsigned long stepDelay) {
  if (!ENABLE_SERVO) {
    Serial.print("[SERVO] skip slot ");
    Serial.println(slot);
    current = angle;
    return;
  }
  Serial.print("[SERVO] slot ");
  Serial.print(slot);
  Serial.print(" ");
  Serial.print(current);
  Serial.print(" -> ");
  Serial.println(angle);
  sweepServo(servo, current, angle, stepDelay);
}

void softOpenDoor(int slot) {
  if (slot == 1) moveDoor(myServo1, servoAngle1, 1, DOOR_OPEN_DEG, STEP_OPEN_MS);
  else if (slot == 2) moveDoor(myServo2, servoAngle2, 2, DOOR_OPEN_DEG, STEP_OPEN_MS);
}

void softCloseDoor(int slot) {
  if (slot == 1) moveDoor(myServo1, servoAngle1, 1, DOOR_CLOSED_DEG, STEP_CLOSE_MS);
  else if (slot == 2) moveDoor(myServo2, servoAngle2, 2, DOOR_CLOSED_DEG, STEP_CLOSE_MS);
  delay(120);
}

void armAutoCloseWatch(int slot) {
  DoorWatch &st = (slot == 2) ? doorWatch2 : doorWatch1;
  unsigned long &at = (slot == 2) ? doorWatchAt2 : doorWatchAt1;
  unsigned long &opened = (slot == 2) ? doorOpenAt2 : doorOpenAt1;
  unsigned long &goneSince = (slot == 2) ? irGoneSince2 : irGoneSince1;
  st = DW_WAIT_PRESENT;
  at = millis();
  opened = millis();
  goneSince = 0;
  Serial.print("[DOOR] watch start slot ");
  Serial.println(slot);
}

bool doorWatchActive(int slot) {
  DoorWatch st = (slot == 2) ? doorWatch2 : doorWatch1;
  return st != DW_IDLE;
}

/** 우산 꺼냄: 감지됨 → 미감지 유지 → 딜레이 → 부드럽게 닫힘 */
void updateAutoCloseWatch(int slot) {
  DoorWatch &st = (slot == 2) ? doorWatch2 : doorWatch1;
  unsigned long &at = (slot == 2) ? doorWatchAt2 : doorWatchAt1;
  unsigned long &opened = (slot == 2) ? doorOpenAt2 : doorOpenAt1;
  unsigned long &goneSince = (slot == 2) ? irGoneSince2 : irGoneSince1;
  if (st == DW_IDLE) return;

  const int irPin = irPinForSlot(slot);
  const bool present = irIsClose(irPin); // 근접 = 우산 있음
  const unsigned long now = millis();

  if (now - opened >= OPEN_MAX_MS) {
    Serial.print("[DOOR] timeout close slot ");
    Serial.println(slot);
    softCloseDoor(slot);
    recoverRfid();
    reportEvent(slot, "servo", "auto_close_timeout");
    st = DW_IDLE;
    return;
  }

  if (st == DW_WAIT_PRESENT) {
    if (present) {
      Serial.print("[DOOR] umbrella present slot ");
      Serial.println(slot);
      st = DW_WAIT_GONE;
      at = now;
      goneSince = 0;
    } else if (now - at >= OPEN_PRESENT_WAIT_MS) {
      // 열었을 때 이미 비어 있음 → 바로 사라짐 대기로
      Serial.print("[DOOR] already empty slot ");
      Serial.println(slot);
      st = DW_WAIT_GONE;
      at = now;
      goneSince = now;
    }
    return;
  }

  if (st == DW_WAIT_GONE) {
    if (present) {
      goneSince = 0;
      return;
    }
    if (goneSince == 0) goneSince = now;
    if (now - goneSince >= IR_GONE_STABLE_MS) {
      Serial.print("[DOOR] umbrella gone slot ");
      Serial.print(slot);
      Serial.println(" — close soon");
      st = DW_WAIT_DELAY;
      at = now;
    }
    return;
  }

  if (st == DW_WAIT_DELAY) {
    // 닫기 전에 다시 감지되면(손/우산) 대기 연장
    if (present) {
      st = DW_WAIT_GONE;
      goneSince = 0;
      at = now;
      Serial.print("[DOOR] present again, wait slot ");
      Serial.println(slot);
      return;
    }
    if (now - at >= AUTO_CLOSE_DELAY_MS) {
      Serial.print("[DOOR] soft close slot ");
      Serial.println(slot);
      softCloseDoor(slot);
      recoverRfid();
      reportEvent(slot, "servo", "auto_close");
      st = DW_IDLE;
    }
  }
}

// ---------- JSON 헬퍼 ----------
String findJsonString(const String& json, const char* key) {
  // "key" 다음 : 주변 공백 허용 → "value"
  String k = String("\"") + key + "\"";
  int i = json.indexOf(k);
  if (i < 0) return "";
  i += k.length();
  while (i < (int)json.length() && (json[i] == ' ' || json[i] == '\t')) i++;
  if (i >= (int)json.length() || json[i] != ':') return "";
  i++;
  while (i < (int)json.length() && (json[i] == ' ' || json[i] == '\t')) i++;
  if (i >= (int)json.length() || json[i] != '"') return "";
  i++;
  int j = i;
  while (j < (int)json.length()) {
    if (json[j] == '"' && json[j - 1] != '\\') break;
    j++;
  }
  if (j >= (int)json.length()) return ""; // 잘린 응답
  return json.substring(i, j);
}

long findIntegerValueNear(const String& json, const char* fieldPath, int from = 0) {
  // "fieldPath":{"integerValue":"N"} 또는 "integerValue":"N" near field
  String needle = String("\"") + fieldPath + "\"";
  int i = json.indexOf(needle, from);
  if (i < 0) return -1;
  int iv = json.indexOf("\"integerValue\":\"", i);
  if (iv < 0 || iv - i > 80) return -1;
  iv += 16;
  int j = json.indexOf('"', iv);
  if (j < 0) return -1;
  return json.substring(iv, j).toInt();
}

String extractDocIdFromName(const String& nameField) {
  // .../documents/commands/DOCID
  int p = nameField.lastIndexOf('/');
  if (p < 0) return "";
  return nameField.substring(p + 1);
}

bool netReadyOnce = false;

// NTP/DNS 준비 — R4는 시각이 1970이면 TLS 인증서 검증이 실패하는 경우가 많음
bool waitForNetworkReady(unsigned long maxWaitMs = 20000) {
  if (WiFi.status() != WL_CONNECTED) return false;
  if (WiFi.localIP() == IPAddress(0, 0, 0, 0)) {
    Serial.println("[NET] IP 0.0.0.0 — DHCP/2.4GHz 확인");
    return false;
  }
  if (netReadyOnce) return true;

  IPAddress dnsIp;
  unsigned long start = millis();
  bool dnsOk = false;
  while (millis() - start < maxWaitMs) {
    if (WiFi.hostByName("identitytoolkit.googleapis.com", dnsIp) == 1) {
      dnsOk = true;
      break;
    }
    delay(500);
  }
  if (!dnsOk) {
    Serial.println("[NET] DNS fail — 인터넷/방화벽 확인");
    return false;
  }
  Serial.print("[NET] DNS OK ");
  Serial.println(dnsIp);

  // 펌웨어가 NTP를 줄 때까지 대기 (안 되면 경고만 — 일부 FW는 getTime=0이어도 SSL 됨)
  start = millis();
  while (millis() - start < 8000) {
    unsigned long t = WiFi.getTime();
    if (t > 1700000000UL) { // ~2023년 이후
      Serial.print("[NET] NTP OK ");
      Serial.println(t);
      netReadyOnce = true;
      return true;
    }
    delay(500);
  }
  Serial.println("[NET] NTP 미동기(경고) — SSL 재시도는 계속");
  netReadyOnce = true; // DNS까지는 됐으니 이후 매 요청마다 재대기하지 않음
  return true;
}

bool sslConnectWithRetry(const char* host, int tries = 3) {
  for (int i = 1; i <= tries; i++) {
    if (ssl.connected()) ssl.stop();
    delay(50);
    Serial.print("[HTTPS] connect ");
    Serial.print(host);
    Serial.print(" try ");
    Serial.println(i);
    if (ssl.connect(host, 443)) return true;
    delay(400 * i);
  }
  Serial.print("[HTTPS] connect fail ");
  Serial.println(host);
  return false;
}

// ---------- HTTPS (gzip 금지, Content-Length / chunked / close) ----------
bool httpsRequest(const char* host, const char* method, const String& path,
                  const String& body, const String& bearer, String& responseOut,
                  int timeoutMs = 20000) {
  responseOut = "";
  if (!waitForNetworkReady()) return false;
  if (!sslConnectWithRetry(host, 3)) return false;

  ssl.print(method);
  ssl.print(" ");
  ssl.print(path);
  ssl.println(" HTTP/1.1");
  ssl.print("Host: ");
  ssl.println(host);
  ssl.println("Connection: close");
  ssl.println("Accept: application/json");
  ssl.println("Accept-Encoding: identity"); // gzip 받으면 JSON 파싱 실패
  ssl.println("User-Agent: UmbrellaLocker/1.0");
  if (bearer.length() > 0) {
    ssl.print("Authorization: Bearer ");
    ssl.println(bearer);
  }
  if (body.length() > 0) {
    ssl.println("Content-Type: application/json");
    ssl.print("Content-Length: ");
    ssl.println(body.length());
    ssl.println();
    ssl.print(body);
  } else {
    ssl.println();
  }
  ssl.flush();

  unsigned long deadline = millis() + (unsigned long)timeoutMs;
  while (!ssl.available() && millis() < deadline) delay(10);
  if (!ssl.available()) {
    Serial.println("[HTTPS] no response");
    ssl.stop();
    return false;
  }

  String statusLine = ssl.readStringUntil('\n');
  statusLine.trim();
  bool ok = statusLine.indexOf(" 200") >= 0 || statusLine.indexOf(" 201") >= 0;

  bool chunked = false;
  long contentLength = -1;
  while (millis() < deadline) {
    if (!ssl.available() && !ssl.connected()) break;
    if (!ssl.available()) { delay(2); continue; }
    String line = ssl.readStringUntil('\n');
    if (line == "\r" || line.length() <= 1) break;
    String low = line;
    low.toLowerCase();
    if (low.startsWith("transfer-encoding:") && low.indexOf("chunked") >= 0) chunked = true;
    if (low.startsWith("content-length:")) {
      contentLength = low.substring(15).toInt();
    }
  }

  if (chunked) {
    while (millis() < deadline) {
      String sizeLine = ssl.readStringUntil('\n');
      sizeLine.trim();
      if (sizeLine.length() == 0) continue;
      long n = strtol(sizeLine.c_str(), nullptr, 16);
      if (n <= 0) break;
      long remain = n;
      while (remain > 0 && millis() < deadline) {
        if (!ssl.available()) { delay(2); continue; }
        int b = ssl.read();
        if (b < 0) break;
        if (responseOut.length() < 6000) responseOut += (char)b;
        remain--;
      }
      ssl.readStringUntil('\n'); // CRLF after chunk
      if (responseOut.length() >= 6000) break;
    }
  } else if (contentLength > 0) {
    long remain = contentLength;
    while (remain > 0 && millis() < deadline) {
      if (!ssl.available()) { delay(2); continue; }
      int b = ssl.read();
      if (b < 0) break;
      if (responseOut.length() < 6000) responseOut += (char)b;
      remain--;
    }
  } else {
    // Content-Length 없음 → 연결 종료까지
    while (millis() < deadline) {
      while (ssl.available()) {
        int b = ssl.read();
        if (b < 0) break;
        if (responseOut.length() < 6000) responseOut += (char)b;
      }
      if (!ssl.connected() && !ssl.available()) break;
      delay(5);
    }
  }
  ssl.stop();

  if (!ok) {
    Serial.print("[HTTPS] ");
    Serial.println(statusLine);
    Serial.print("[HTTPS] body=");
    Serial.println(responseOut.substring(0, min(220, (int)responseOut.length())));
  }
  return ok;
}

bool wifiConfigured() {
  return String(WIFI_SSID) != "YOUR_SSID" && String(WIFI_SSID).length() > 0;
}

void ensureWifi() {
  if (!ENABLE_WIFI) return;
  if (WiFi.status() == WL_CONNECTED) return;
  if (!wifiConfigured()) {
    static bool warned = false;
    if (!warned) {
      warned = true;
      Serial.println("[WIFI] SSID 미설정 — 유선(bridge)만 사용 가능");
    }
    return;
  }
  if (millis() - lastWifiTryMs < WIFI_RETRY_MS) return;
  lastWifiTryMs = millis();

  Serial.print("[WIFI] connect ");
  Serial.println(WIFI_SSID);
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
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("[WIFI] OK ");
    Serial.println(WiFi.localIP());
    Serial.print("[WIFI] fw=");
    Serial.println(WiFi.firmwareVersion());
    waitForNetworkReady();
  } else {
    Serial.println("[WIFI] fail — 2.4GHz / SSID·비번 확인");
  }
}

bool firebaseLogin(bool force = false) {
  if (!force && idToken.length() > 0 && (millis() - tokenAtMs) < TOKEN_REFRESH_MS) {
    return true;
  }
  ensureWifi();
  if (WiFi.status() != WL_CONNECTED) return false;

  String body = String("{\"email\":\"") + DEVICE_EMAIL +
                "\",\"password\":\"" + DEVICE_PASS +
                "\",\"returnSecureToken\":true}";
  // v1 signInWithPassword (구 verifyPassword 와 동일 필드)
  String path = String("/v1/accounts:signInWithPassword?key=") + FB_API_KEY;
  String resp;
  Serial.println("[AUTH] login…");
  if (!httpsRequest("identitytoolkit.googleapis.com", "POST", path, body, "", resp, 25000)) {
    Serial.println("[AUTH] fail");
    idToken = "";
    return false;
  }
  idToken = findJsonString(resp, "idToken");
  if (idToken.length() == 0) {
    Serial.print("[AUTH] no idToken len=");
    Serial.println(resp.length());
    Serial.print("[AUTH] body=");
    Serial.println(resp.substring(0, min(240, (int)resp.length())));
    // 흔한 원인: Email/Password 미활성, 비밀번호 불일치, 응답 잘림
    if (resp.indexOf("EMAIL_NOT_FOUND") >= 0 || resp.indexOf("INVALID_PASSWORD") >= 0 ||
        resp.indexOf("INVALID_LOGIN_CREDENTIALS") >= 0) {
      Serial.println("[AUTH] device 이메일/비밀번호 확인 (firebase-config.js 와 동일해야 함)");
    }
    return false;
  }
  tokenAtMs = millis();
  Serial.print("[AUTH] OK tokenLen=");
  Serial.println(idToken.length());
  return true;
}

void reportEventFirebase(int slot, const char* kind, const String& extra);
void reportEvent(int slot, const char* kind, const String& extra) {
  if (isWired()) {
    if (strcmp(kind, "rfid") == 0) {
      Serial.print("EVENT RFID ");
      Serial.print(slot);
      Serial.print(" ");
      Serial.println(extra);
    } else if (strcmp(kind, "ir") == 0) {
      Serial.print("EVENT IR ");
      Serial.println(slot);
    } else if (strcmp(kind, "servo") == 0) {
      Serial.print("EVENT SERVO ");
      Serial.print(slot);
      Serial.print(" ");
      Serial.println(extra);
    }
    return;
  }
  reportEventFirebase(slot, kind, extra);
}

void executeOpen(int slot) {
  if (slot != 1 && slot != 2) return;
  // 문은 열린 채로 유지 → IR로 우산 꺼냄 확인 후 자동 부드럽게 닫힘
  softOpenDoor(slot);
  recoverRfid();
  reportEvent(slot, "servo", "open");
  armAutoCloseWatch(slot);
}

String epochMsString() {
  // WiFiS3 NTP(초) → ms. 아직 동기화 전이면 millis 폴백
  unsigned long epochSec = WiFi.getTime();
  if (epochSec > 100000UL) {
    // 초*1000 은 unsigned long 오버플로 가능 → 문자열로 조립
    return String(epochSec) + "000";
  }
  return String(millis());
}

bool markCommandDone(const String& docId) {
  if (!firebaseLogin()) return false;
  String path = String("/v1/projects/") + FB_PROJECT +
                "/databases/(default)/documents/commands/" + docId +
                "?updateMask.fieldPaths=done&updateMask.fieldPaths=done_at";
  String body = String("{\"fields\":{") +
                "\"done\":{\"integerValue\":\"1\"}," +
                "\"done_at\":{\"integerValue\":\"" + epochMsString() + "\"}}}";

  String resp;
  bool ok = httpsRequest("firestore.googleapis.com", "PATCH", path, body, idToken, resp);
  if (ok) Serial.println("[CMD] done marked");
  return ok;
}

void reportEventFirebase(int slot, const char* kind, const String& extra) {
  if (!firebaseLogin()) return;

  String payloadFields;
  if (strcmp(kind, "rfid") == 0) {
    payloadFields = String("\"uid\":{\"stringValue\":\"") + extra + "\"}";
  } else if (strcmp(kind, "ir") == 0) {
    payloadFields = "\"held_ms\":{\"integerValue\":\"1000\"}";
  } else {
    payloadFields = String("\"action\":{\"stringValue\":\"") + extra +
                    "\"},\"deg\":{\"integerValue\":\"90\"}";
  }

  String created = epochMsString();

  String body = String("{\"fields\":{") +
                "\"station\":{\"stringValue\":\"" + STATION_CODE + "\"}," +
                "\"slot\":{\"integerValue\":\"" + String(slot) + "\"}," +
                "\"kind\":{\"stringValue\":\"" + kind + "\"}," +
                "\"payload\":{\"mapValue\":{\"fields\":{" + payloadFields + "}}}," +
                "\"created_at\":{\"integerValue\":\"" + created + "\"}" +
                "}}";

  String path = String("/v1/projects/") + FB_PROJECT +
                "/databases/(default)/documents/device_events";
  String resp;
  httpsRequest("firestore.googleapis.com", "POST", path, body, idToken, resp);

  if (strcmp(kind, "rfid") == 0 && extra.length() > 0) {
    String uid = extra;
    uid.replace(":", "");
    uid.replace(" ", "");
    String upath = String("/v1/projects/") + FB_PROJECT +
                   "/databases/(default)/documents/umbrellas/" +
                   STATION_CODE + "-" + String(slot) +
                   "?updateMask.fieldPaths=tag_uid&updateMask.fieldPaths=updated_at";
    String ubody = String("{\"fields\":{") +
                   "\"tag_uid\":{\"stringValue\":\"" + uid + "\"}," +
                   "\"updated_at\":{\"integerValue\":\"" + created + "\"}}}";
    httpsRequest("firestore.googleapis.com", "PATCH", upath, ubody, idToken, resp);
  }
}

/** Firestore stations/{code} 하트비트 — 장치관리 화면 통신 확인용 */
void reportPresenceFirebase() {
  if (!firebaseLogin()) return;

  String created = epochMsString();
  long rssi = (WiFi.status() == WL_CONNECTED) ? (long)WiFi.RSSI() : 0;
  String ipStr = "-";
  if (WiFi.status() == WL_CONNECTED) {
    IPAddress ip = WiFi.localIP();
    ipStr = String(ip[0]) + "." + String(ip[1]) + "." + String(ip[2]) + "." + String(ip[3]);
  }

  String body = String("{\"fields\":{") +
                "\"code\":{\"stringValue\":\"" + STATION_CODE + "\"}," +
                "\"last_seen\":{\"integerValue\":\"" + created + "\"}," +
                "\"link\":{\"stringValue\":\"wifi\"}," +
                "\"wifi_rssi\":{\"integerValue\":\"" + String(rssi) + "\"}," +
                "\"wifi_ip\":{\"stringValue\":\"" + ipStr + "\"}," +
                "\"mcu_ok\":{\"booleanValue\":true}" +
                "}}";

  String path = String("/v1/projects/") + FB_PROJECT +
                "/databases/(default)/documents/stations/" + STATION_CODE +
                "?updateMask.fieldPaths=code"
                "&updateMask.fieldPaths=last_seen"
                "&updateMask.fieldPaths=link"
                "&updateMask.fieldPaths=wifi_rssi"
                "&updateMask.fieldPaths=wifi_ip"
                "&updateMask.fieldPaths=mcu_ok";
  String resp;
  if (httpsRequest("firestore.googleapis.com", "PATCH", path, body, idToken, resp)) {
    Serial.println("[HB] wifi presence OK");
  } else {
    Serial.println("[HB] presence 실패");
  }
}

void pollNextCommandFirebase() {
  if (!ENABLE_WIFI) return;
  if (isWired()) return;       // 유선 브리지가 살아 있으면 WiFi 폴링 생략
  if (cmdBusy) return;
  if (!wifiConfigured()) {
    Serial.println("[POLL] WIFI_SSID 미설정");
    return;
  }

  Serial.println("[POLL] …");
  ensureWifi();
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[POLL] WiFi 끊김");
    return;
  }
  if (!firebaseLogin()) {
    Serial.println("[POLL] Auth 실패");
    return;
  }

  // station==STATION && done==0, created_at asc, limit 5
  String body = String("{\"structuredQuery\":{") +
                "\"from\":[{\"collectionId\":\"commands\"}]," +
                "\"where\":{\"compositeFilter\":{\"op\":\"AND\",\"filters\":[" +
                "{\"fieldFilter\":{\"field\":{\"fieldPath\":\"station\"},\"op\":\"EQUAL\"," +
                "\"value\":{\"stringValue\":\"" + STATION_CODE + "\"}}}," +
                "{\"fieldFilter\":{\"field\":{\"fieldPath\":\"done\"},\"op\":\"EQUAL\"," +
                "\"value\":{\"integerValue\":\"0\"}}}" +
                "]}}," +
                "\"orderBy\":[{\"field\":{\"fieldPath\":\"created_at\"},\"direction\":\"ASCENDING\"}]," +
                "\"limit\":5" +
                "}}";

  String path = String("/v1/projects/") + FB_PROJECT +
                "/databases/(default)/documents:runQuery";
  String resp;
  if (!httpsRequest("firestore.googleapis.com", "POST", path, body, idToken, resp, 15000)) {
    // 토큰 만료 가능 → 강제 재로그인 후 1회 재시도
    if (firebaseLogin(true)) {
      if (!httpsRequest("firestore.googleapis.com", "POST", path, body, idToken, resp, 15000)) return;
    } else {
      return;
    }
  }

  // Firestore 왕복 성공 → 하트비트 (명령 유무와 무관)
  reportPresenceFirebase();

  // 첫 번째 document 찾기
  int docPos = resp.indexOf("\"document\"");
  if (docPos < 0) {
    Serial.println("[POLL] no pending cmd");
    return;
  }

  int nameKey = resp.indexOf("\"name\": \"", docPos);
  if (nameKey < 0) nameKey = resp.indexOf("\"name\":\"", docPos);
  if (nameKey < 0) return;
  nameKey = resp.indexOf(':', nameKey) + 1;
  while (nameKey < (int)resp.length() && (resp[nameKey] == ' ' || resp[nameKey] == '"')) nameKey++;
  int nameEnd = resp.indexOf('"', nameKey);
  if (nameEnd < 0) return;
  String fullName = resp.substring(nameKey, nameEnd);
  String docId = extractDocIdFromName(fullName);

  long slot = findIntegerValueNear(resp, "slot", docPos);
  if (docId.length() == 0 || slot < 1 || slot > 2) {
    Serial.println("[POLL] skip invalid cmd");
    return;
  }

  Serial.print("[CMD/WIFI] id=");
  Serial.print(docId);
  Serial.print(" slot=");
  Serial.println(slot);

  cmdBusy = true;
  executeOpen((int)slot);
  markCommandDone(docId);
  cmdBusy = false;
}

void handleSerialLine(String line) {
  line.trim();
  if (line.length() == 0) return;

  if (line == "PING") {
    lastPingMs = millis();
    wiredMode = true;
    Serial.println("PONG");
    return;
  }

  if (line.startsWith("OPEN ")) {
    if (cmdBusy) {
      Serial.println("[CMD] busy, ignore serial OPEN");
      return;
    }
    int slot = line.substring(5).toInt();
    lastPingMs = millis();
    wiredMode = true;
    Serial.print("ACK OPEN ");
    Serial.println(slot);
    cmdBusy = true;
    executeOpen(slot);
    cmdBusy = false;
    Serial.print("DONE OPEN ");
    Serial.println(slot);
    return;
  }
}

void pollSerial() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      if (serialBuf.length() > 0) {
        handleSerialLine(serialBuf);
        serialBuf = "";
      }
    } else {
      serialBuf += c;
      if (serialBuf.length() > 80) serialBuf = "";
    }
  }
}

bool handleReader(MFRC522 &rfid, unsigned long &lastTagMs,
                  Servo &servo, int &current, int slot) {
  if (!rfid.PICC_IsNewCardPresent()) return false;
  if (!rfid.PICC_ReadCardSerial()) return false;
  if (millis() - lastTagMs < COOLDOWN_MS) {
    rfid.PICC_HaltA();
    rfid.PCD_StopCrypto1();
    return false;
  }
  lastTagMs = millis();

  String uid = uidToString(&rfid.uid);
  Serial.print("[RFID] slot ");
  Serial.print(slot);
  Serial.print(" UID=");
  Serial.println(uid);

  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();

  softOpenDoor(slot);
  recoverRfid();
  reportEvent(slot, "rfid", uid);
  armAutoCloseWatch(slot);
  return true;
}

bool handleIr(int irPin, bool &armed, bool &closing, unsigned long &closeStart,
              unsigned long &lastIrMs, Servo &servo, int &current, int slot) {
  // 문 자동닫힘 감시 중이면 IR은 updateAutoCloseWatch 가 담당
  if (doorWatchActive(slot)) return false;

  bool closeNow = irIsClose(irPin);
  if (!closeNow) {
    armed = true;
    closing = false;
    return false;
  }
  if (!armed) return false;
  if (!closing) {
    closing = true;
    closeStart = millis();
    return false;
  }
  if (millis() - closeStart < IR_HOLD_MS) return false;
  if (millis() - lastIrMs < COOLDOWN_MS) return false;

  armed = false;
  closing = false;
  lastIrMs = millis();

  Serial.print("[IR] slot ");
  Serial.print(slot);
  Serial.println(" hold — open for return");

  // 반납 등: 문이 닫힌 상태에서 우산이 1초 이상 감지되면 열고, 이후 자동닫힘 로직과 동일
  softOpenDoor(slot);
  recoverRfid();
  reportEvent(slot, "ir", "");
  armAutoCloseWatch(slot);
  (void)servo;
  (void)current;
  return true;
}

void setup() {
  Serial.begin(9600);
  while (!Serial && millis() < 3000) {}
  delay(200);

  Serial.println("[BOOT] UmbrellaLocker WiFi-Firestore / USB-bridge backup");

  pinMode(SS_1_PIN, OUTPUT);
  digitalWrite(SS_1_PIN, HIGH);
  pinMode(SS_2_PIN, OUTPUT);
  digitalWrite(SS_2_PIN, HIGH);
  pinMode(IR_1_PIN, INPUT);
  pinMode(IR_2_PIN, INPUT);

  SPI.begin();
  mfrc522_1.PCD_Init();
  mfrc522_2.PCD_Init();
  Serial.print("RFID1=0x");
  Serial.println(readVersion(mfrc522_1), HEX);
  Serial.print("RFID2=0x");
  Serial.println(readVersion(mfrc522_2), HEX);

  if (ENABLE_SERVO) {
    myServo1.attach(servo1Pin);
    myServo1.write(0);
    servoAngle1 = 0;
    delay(500);
    myServo2.attach(servo2Pin);
    myServo2.write(0);
    servoAngle2 = 0;
    delay(500);
  }

  irArmed1 = !irIsClose(IR_1_PIN);
  irArmed2 = !irIsClose(IR_2_PIN);

  if (ENABLE_WIFI && wifiConfigured()) {
    ensureWifi();
    if (WiFi.status() == WL_CONNECTED) firebaseLogin(true);
  } else {
    Serial.println("[BOOT] WiFi 미설정 — USB bridge 로 동작 가능");
  }

  Serial.println("[BOOT] ready");
  Serial.println("[BOOT] 유선 백업: npm run bridge:firebase");
  Serial.println("[BOOT] 무선: WIFI_SSID 설정 후 Firestore 직접 폴링");
  if (isWired()) Serial.println("[LINK] WIRED (브리지 켜짐)");
  else Serial.println("[LINK] WIFI (브리지 꺼짐 / 폴링 시작)");
}

void loop() {
  pollSerial();
  updateLinkMode();

  // 열린 문: 우산 사라짐 감지 → 지연 후 부드럽게 닫기 (매 루프)
  updateAutoCloseWatch(1);
  updateAutoCloseWatch(2);

  if (handleIr(IR_1_PIN, irArmed1, irClosing1, irCloseStart1, lastIrMs1, myServo1, servoAngle1, 1)) return;
  if (handleIr(IR_2_PIN, irArmed2, irClosing2, irCloseStart2, lastIrMs2, myServo2, servoAngle2, 2)) return;
  if (handleReader(mfrc522_1, lastTagMs1, myServo1, servoAngle1, 1)) return;
  if (handleReader(mfrc522_2, lastTagMs2, myServo2, servoAngle2, 2)) return;

  if (isWired()) {
    // 브리지가 PING 중이면 WiFi 폴링 안 함
    static unsigned long lastWiredNote = 0;
    if (millis() - lastWiredNote > 10000) {
      lastWiredNote = millis();
      Serial.println("[LINK] 브리지 감지됨 — WiFi 폴링 중지 (브리지 끄면 무선 동작)");
    }
    return;
  }

  // 문 감시 중에는 폴링 잠깐 쉬어도 됨(cmdBusy와 별개로 watch 중이면 스킵 가능)
  if (doorWatchActive(1) || doorWatchActive(2)) return;

  if (millis() - lastPollMs >= POLL_MS) {
    lastPollMs = millis();
    pollNextCommandFirebase();
  }
}
