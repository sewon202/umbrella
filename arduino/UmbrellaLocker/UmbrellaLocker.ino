/*
  Umbrella Locker - UNO R4 WiFi (슬롯 1·2)

  통신 우선순위
  1) 유선(USB 시리얼): PC에서 `npm run bridge` 또는 `npm run bridge:firebase`
     → Spark(Firebase Hosting+Firestore)도 유선 브리지로 연결 가능
  2) WiFi: 유선 끊기면 로컬 Express(/api/device/next) HTTP 폴링
     (Firebase HTTPS 직접 접속은 Spark에서 Functions 없이 복잡 → 유선 권장)

  핀: RFID1 D10/D9, RFID2 D8/D7, Servo D5/D6, IR D2/D3
*/

#include <SPI.h>
#include <MFRC522.h>
#include <Servo.h>
#include <WiFiS3.h>

// ========== WiFi는 유선이 없을 때만 사용 ==========
const char* WIFI_SSID   = "YOUR_SSID";      // 유선만 쓰면 안 바꿔도 됨
const char* WIFI_PASS   = "YOUR_PASSWORD";
// 로컬: PC LAN IP / 포트 3000
// Firebase 배포 후: PROJECT_ID.web.app 또는 Cloud Functions URL, 포트 443
const char* SERVER_HOST = "192.168.35.12";
const uint16_t SERVER_PORT = 3000;
// WiFi+Firebase(HTTPS) 쓸 때는 WiFiSSLClient 전환 필요 (유선 bridge면 불필요)
const char* STATION_CODE = "A1";
const char* DEVICE_KEY   = "umbrella-device";
const bool ENABLE_WIFI_FALLBACK = true;     // 유선 끊기면 WiFi 사용
const bool ENABLE_SERVO = true;
// ===============================================

#define SS_1_PIN 10
#define RST_1_PIN 9
#define SS_2_PIN 8
#define RST_2_PIN 7
#define IR_1_PIN 2
#define IR_2_PIN 3

const bool IR_ACTIVE_LOW = true;
const unsigned long IR_HOLD_MS = 1000;
const unsigned long STEP_DELAY_90_MS = 8;
const unsigned long STEP_DELAY_180_MS = 3;
const unsigned long COOLDOWN_MS = 1500;
const unsigned long POLL_MS = 2000;
const unsigned long WIFI_RETRY_MS = 10000;
const unsigned long WIRED_TIMEOUT_MS = 5000;  // 이 시간 동안 PING 없으면 유선 끊김

const int servo1Pin = 5;
const int servo2Pin = 6;

MFRC522 mfrc522_1(SS_1_PIN, RST_1_PIN);
MFRC522 mfrc522_2(SS_2_PIN, RST_2_PIN);
Servo myServo1;
Servo myServo2;
WiFiClient client;

int servoAngle1 = 0;
int servoAngle2 = 0;
unsigned long lastTagMs1 = 0, lastTagMs2 = 0;
unsigned long lastIrMs1 = 0, lastIrMs2 = 0;
unsigned long lastPollMs = 0;
unsigned long lastWifiTryMs = 0;
unsigned long lastPingMs = 0;   // PC 브리지 PING 시각
bool wiredMode = false;
String serialBuf = "";

bool irArmed1 = false, irArmed2 = false;
bool irClosing1 = false, irClosing2 = false;
unsigned long irCloseStart1 = 0, irCloseStart2 = 0;

bool irIsClose(int pin) {
  return IR_ACTIVE_LOW ? (digitalRead(pin) == LOW) : (digitalRead(pin) == HIGH);
}

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
    else Serial.println("[LINK] WIRELESS fallback (WiFi)");
  }
}

void sweepServo(Servo &servo, int &current, int target, unsigned long stepDelay) {
  int step = (target > current) ? 1 : -1;
  while (current != target) {
    current += step;
    servo.write(current);
    delay(stepDelay);
  }
}

void runServoTo(Servo &servo, int &current, int slot, int angle,
                unsigned long holdMs, unsigned long stepDelay) {
  if (!ENABLE_SERVO) {
    Serial.print("[SERVO] skip slot ");
    Serial.println(slot);
    return;
  }
  Serial.print("[SERVO] slot ");
  Serial.print(slot);
  Serial.print(" ");
  Serial.print(current);
  Serial.print(" -> ");
  Serial.println(angle);
  sweepServo(servo, current, angle, stepDelay);
  delay(holdMs);
  sweepServo(servo, current, 0, stepDelay);
  delay(200);
}

void postEventHttp(int slot, const char* kind, const String& extra); // forward

void reportEvent(int slot, const char* kind, const String& extra) {
  // 유선이면 시리얼 프로토콜, 아니면 WiFi HTTP
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
  postEventHttp(slot, kind, extra);
}

long findLongField(const String& json, const char* key) {
  String k = String("\"") + key + "\":";
  int i = json.indexOf(k);
  if (i < 0) return -1;
  i += k.length();
  while (i < (int)json.length() && json[i] == ' ') i++;
  return json.substring(i).toInt();
}

bool findBoolField(const String& json, const char* key) {
  String k = String("\"") + key + "\":";
  int i = json.indexOf(k);
  if (i < 0) return false;
  i += k.length();
  while (i < (int)json.length() && json[i] == ' ') i++;
  return json.substring(i).startsWith("true");
}

String findStringField(const String& json, const char* key) {
  String k = String("\"") + key + "\":\"";
  int i = json.indexOf(k);
  if (i < 0) return "";
  i += k.length();
  int j = json.indexOf('"', i);
  if (j < 0) return "";
  return json.substring(i, j);
}

bool httpRequest(const char* method, const String& path, const String& body, String& responseOut) {
  responseOut = "";
  if (WiFi.status() != WL_CONNECTED) return false;
  if (client.connected()) client.stop();
  if (!client.connect(SERVER_HOST, SERVER_PORT)) {
    Serial.println("[HTTP] connect fail");
    return false;
  }

  client.print(method);
  client.print(" ");
  client.print(path);
  client.println(" HTTP/1.1");
  client.print("Host: ");
  client.println(SERVER_HOST);
  client.print("X-Device-Key: ");
  client.println(DEVICE_KEY);
  client.println("Connection: close");
  if (body.length() > 0) {
    client.println("Content-Type: application/json");
    client.print("Content-Length: ");
    client.println(body.length());
    client.println();
    client.print(body);
  } else {
    client.println();
  }

  unsigned long start = millis();
  while (!client.available() && millis() - start < 4000) delay(10);

  bool headersDone = false;
  while (millis() - start < 5000) {
    while (client.available()) {
      String line = client.readStringUntil('\n');
      if (!headersDone) {
        if (line == "\r" || line.length() <= 1) headersDone = true;
      } else {
        responseOut += line;
      }
    }
    if (!client.connected() && !client.available()) break;
    delay(5);
  }
  client.stop();
  return responseOut.length() > 0;
}

void postEventHttp(int slot, const char* kind, const String& extra) {
  String payload;
  if (strcmp(kind, "rfid") == 0) {
    payload = String("{\"uid\":\"") + extra + "\"}";
  } else if (strcmp(kind, "ir") == 0) {
    payload = "{\"held_ms\":1000}";
  } else {
    payload = String("{\"action\":\"") + extra + "\",\"deg\":90}";
  }

  String body = String("{\"station\":\"") + STATION_CODE +
                "\",\"slot\":" + String(slot) +
                ",\"kind\":\"" + kind +
                "\",\"payload\":" + payload + "}";
  String resp;
  httpRequest("POST", "/api/device/event", body, resp);
}

void markDoneHttp(const String& id) {
  String path = String("/api/device/commands/") + id + "/done";
  String resp;
  httpRequest("POST", path, "", resp);
}

void ensureWifi() {
  if (!ENABLE_WIFI_FALLBACK) return;
  if (isWired()) return;  // 유선이면 WiFi 불필요
  if (WiFi.status() == WL_CONNECTED) return;
  if (millis() - lastWifiTryMs < WIFI_RETRY_MS) return;
  lastWifiTryMs = millis();

  // SSID가 플레이스홀더면 연결 시도 안 함 (경고는 1회만)
  if (String(WIFI_SSID) == "YOUR_SSID") {
    static bool warned = false;
    if (!warned) {
      warned = true;
      Serial.println("[WIFI] SSID 미설정 — 유선(bridge)만 사용 가능");
    }
    return;
  }

  Serial.print("[WIFI] connect ");
  Serial.println(WIFI_SSID);
  WiFi.disconnect();
  delay(100);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 8000) {
    delay(300);
    Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("[WIFI] OK ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("[WIFI] fail");
  }
}

void executeOpen(int slot) {
  if (slot == 1) {
    runServoTo(myServo1, servoAngle1, 1, 90, 1500, STEP_DELAY_90_MS);
  } else if (slot == 2) {
    runServoTo(myServo2, servoAngle2, 2, 90, 1500, STEP_DELAY_90_MS);
  } else {
    return;
  }
  recoverRfid();
  reportEvent(slot, "servo", "open");
}

void pollNextCommandWifi() {
  if (!ENABLE_WIFI_FALLBACK) return;
  if (isWired()) return;  // 유선 우선
  ensureWifi();
  if (WiFi.status() != WL_CONNECTED) return;

  String path = String("/api/device/next?station=") + STATION_CODE +
                "&key=" + DEVICE_KEY;
  String resp;
  if (!httpRequest("GET", path, "", resp)) return;

  Serial.print("[POLL] ");
  Serial.println(resp);
  if (!findBoolField(resp, "has")) return;

  // Firebase는 문자열 id, 로컬 SQLite는 숫자 id — 둘 다 허용
  String idStr = findStringField(resp, "id");
  if (idStr.length() == 0) {
    long idNum = findLongField(resp, "id");
    if (idNum >= 0) idStr = String(idNum);
  }
  long slot = findLongField(resp, "slot");
  if (idStr.length() == 0 || slot < 1 || slot > 2) return;

  Serial.print("[CMD/WIFI] id=");
  Serial.print(idStr);
  Serial.print(" slot=");
  Serial.println(slot);

  executeOpen((int)slot);
  markDoneHttp(idStr);
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

  // OPEN 1  / OPEN 2
  if (line.startsWith("OPEN ")) {
    int slot = line.substring(5).toInt();
    lastPingMs = millis();
    wiredMode = true;
    Serial.print("ACK OPEN ");
    Serial.println(slot);
    executeOpen(slot);
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

  runServoTo(servo, current, slot, 90, 1500, STEP_DELAY_90_MS);
  recoverRfid();
  reportEvent(slot, "rfid", uid);
  return true;
}

bool handleIr(int irPin, bool &armed, bool &closing, unsigned long &closeStart,
              unsigned long &lastIrMs, Servo &servo, int &current, int slot) {
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
  Serial.println(" >=1s");

  runServoTo(servo, current, slot, 180, 1500, STEP_DELAY_180_MS);
  recoverRfid();
  reportEvent(slot, "ir", "");
  return true;
}

void setup() {
  Serial.begin(9600);
  while (!Serial && millis() < 3000) {}
  delay(200);

  Serial.println("[BOOT] UmbrellaLocker USB-first / WiFi-fallback");

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

  Serial.println("[BOOT] ready");
  Serial.println("[BOOT] 유선: PC에서 npm run bridge");
  Serial.println("[BOOT] 무선: WIFI_SSID 설정 후 USB 없이 동작");
}

void loop() {
  pollSerial();
  updateLinkMode();

  if (handleIr(IR_1_PIN, irArmed1, irClosing1, irCloseStart1, lastIrMs1, myServo1, servoAngle1, 1)) return;
  if (handleIr(IR_2_PIN, irArmed2, irClosing2, irCloseStart2, lastIrMs2, myServo2, servoAngle2, 2)) return;
  if (handleReader(mfrc522_1, lastTagMs1, myServo1, servoAngle1, 1)) return;
  if (handleReader(mfrc522_2, lastTagMs2, myServo2, servoAngle2, 2)) return;

  // 유선이면 브리지가 명령을 시리얼로 보냄 → WiFi 폴링 안 함
  if (!isWired() && millis() - lastPollMs >= POLL_MS) {
    lastPollMs = millis();
    pollNextCommandWifi();
  }
}
