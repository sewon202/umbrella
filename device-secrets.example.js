/**
 * 복사: cp device-secrets.example.js device-secrets.local.js
 * device-secrets.local.js 는 gitignore(*.local) — 커밋하지 마세요.
 *
 * 브리지: npm run bridge:firebase
 * 또는: DEVICE_PASSWORD='...' npm run bridge:firebase
 *
 * 브라우저 admin/device.html 은 비밀번호를 물어봅니다 (공개 firebase-config에 두지 않음).
 * Firebase Auth 의 device@umbrella.local 비밀번호와 같아야 합니다.
 */
module.exports = {
  deviceEmail: "device@umbrella.local",
  devicePassword: "CHANGE-ME-TO-A-STRONG-PASSWORD",
};
