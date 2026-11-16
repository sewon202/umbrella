const fs = require("node:fs");
const assert = require("node:assert/strict");
const { extractSsoToken, hiddenFields, interpretSmartidLogin, passwordMax, schoolPassword } = require("../lib/ssu-verify.cjs");

assert.equal(
  fs.readFileSync(require("node:path").join(__dirname, "../lib/ssu-verify.cjs"), "utf8"),
  fs.readFileSync(require("node:path").join(__dirname, "../functions/ssu-verify.cjs"), "utf8")
);

assert.equal(extractSsoToken("location.href='cb?sToken=abc123&sIdno=1'"), "abc123");
assert.equal(extractSsoToken('sToken="abc123"'), "abc123");
assert.equal(extractSsoToken("no token"), "");
assert.equal(extractSsoToken("sToken=ax2Bbx2F"), "a+b/");
assert.equal(passwordMax('<input type="password" name="pwd" maxlength="20">'), 20);
assert.equal(schoolPassword("  abc\u200B  ", 20), "  abc  ");
assert.equal(schoolPassword("12345678901234567890123", 20).length, 20);

const fields = hiddenFields(
  '<form><input type="hidden" name="in_tp_bit" value="7"><input type="password" name="pwd"></form>'
);
assert.equal(fields.in_tp_bit, "7");
assert.equal(fields.pwd, undefined);

const fail = interpretSmartidLogin(
  '<script>alert("아이디와 비밀번호가 일치하지 않거나 잘못되었습니다.\\n다시 확인하시기 바랍니다.");</script>',
  ""
);
assert.equal(fail.ok, false);
assert.match(fail.error, /유세인트 비밀번호/);

const quotedOk = interpretSmartidLogin(
  'alert("아이디와 비밀번호가 일치하지 않거나 잘못되었습니다."); sToken="real-token"',
  ""
);
assert.equal(quotedOk.ok, true);

console.log("ssu-verify helpers ok");
