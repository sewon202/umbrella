# Umbrella

숭실대 캠퍼스용 **우산 대여 보관함** 웹앱 + Arduino 연동 프로젝트입니다.  
학생은 학번으로 가입·로그인한 뒤 거점 슬롯에서 우산을 빌리고 반납하고, 보관함 보드는 Firebase(또는 USB 브리지)로 문 열기 명령을 받아 서보를 동작합니다.

**라이브**

| 용도 | URL |
|------|-----|
| 학생 앱 | https://umbrella-c8cf0.web.app/ |
| 장치 / 문열기 테스트 | https://umbrella-c8cf0.web.app/device.html |
| DB 관리 | https://umbrella-c8cf0.web.app/admin.html |

---

## 주요 기능

- 학번·이름 회원가입 / 로그인 (비밀번호 6~16자)
- 거점별 슬롯 재고 확인, 대여·반납, 문 열기
- 대여 타이머(약 48시간 기준) 및 홈 / QR / 설정 화면
- 짧은 로그인 유지(약 20분, 새로고침 시 세션 복구)
- 장치 관리: 슬롯 open 명령, **보드 WiFi·USB 통신 하트비트** 표시
- DB 관리: 우산 상태·사용자·활성 대여 조회

---

## 구성

```
public/          학생·관리 웹 (Hosting)
arduino/         UNO R4 WiFi 스케치 (서보 / RFID / IR)
bridge/          USB 시리얼 ↔ Firebase|로컬 브리지
server.js        로컬 Express + SQLite (개발용)
firestore.rules  Firestore 보안 규칙
```

| 계층 | 기술 |
|------|------|
| 프론트 | 정적 HTML/CSS/JS, Firebase Auth + Firestore |
| 호스팅 | Firebase Hosting (`umbrella-c8cf0`) |
| 하드웨어 | Arduino UNO R4 WiFi, 슬롯 1·2 |
| 로컬 백엔드 | Node.js Express + SQLite (`umbrella.db`) |

배포 기본 모드는 Firebase입니다. Cloud Functions 없이 Hosting + Auth + Firestore만 사용합니다.

---

## 동작 흐름 (요약)

1. 학생이 앱에서 대여/반납/문열기 → Firestore `commands`에 open 명령 생성  
2. 보드가 **WiFi로 Firestore를 폴링**해 명령을 수행하고 `done` 처리  
3. USB가 연결되어 있고 PC에서 브리지를 켜면 **유선이 우선** (WiFi 폴링 일시 중지)  
4. 보드는 `stations/{거점}`에 하트비트를 남겨 장치 관리 화면에서 통신 여부를 확인할 수 있음  

하드웨어 설정·업로드는 [`arduino/README.md`](arduino/README.md)를 보세요.

---

## 로컬 실행

```bash
npm install
npm start
```

- 앱: http://localhost:3000/  
- 관리: http://localhost:3000/admin.html  
- 장치: http://localhost:3000/device.html  

로컬 모드로 쓰려면 `public/firebase-config.js`의 `backend`를 `"local"`로 두거나, 설정에 맞게 전환하세요.

USB 브리지 (시리얼 모니터는 닫을 것):

```bash
npm run bridge:firebase   # Firebase
npm run bridge            # 설정에 따라 자동
```

---

## Firebase 배포

```bash
npm run firebase:hosting          # Hosting만
npm run firebase:deploy           # Hosting + Firestore
npm run firebase:rules            # 규칙만
```

설정은 `public/firebase-config.js`, 프로젝트는 `.firebaserc`를 참고하세요.  
device 계정·API 키는 보드 스케치와 동일해야 합니다.
