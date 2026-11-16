const assert = require("node:assert/strict");
const { extractSsoToken, hiddenFields, interpretSmartidLogin } = require("../lib/ssu-verify.cjs");

assert.equal(extractSsoToken("location.href='cb?sToken=abc123&sIdno=1'"), "abc123");
assert.equal(extractSsoToken("no token"), "");
assert.equal(extractSsoToken("sToken=ax2Bbx2F"), "a+b/");

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

const ok = interpretSmartidLogin("ok", "token-value");
assert.equal(ok.ok, true);

console.log("ssu-verify helpers ok");
