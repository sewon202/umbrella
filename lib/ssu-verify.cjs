/**
 * 숭실대 통합로그인(smartid)으로 학번·유세인트 비밀번호를 확인한다.
 * rusaint obtain_ssu_sso_token / LMS-API LmsAuthService 와 같은 단계만 사용한다.
 * 비밀번호와 sToken 은 반환하거나 저장하지 않는다.
 *
 * LMS 일반 로그인(gw-cb.php, login_type=general)은 유세인트 비밀번호를
 * "auth failed" 로 거절하므로 쓰지 않는다. smartid 는 성공 시 sToken 쿠키를 준다.
 */

const SMARTID_PAGE = "https://smartid.ssu.ac.kr/Symtra_sso/smln.asp";
const SMARTID_POST = "https://smartid.ssu.ac.kr/Symtra_sso/smln_pcs.asp";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PASSWORD_ERROR = "학번 또는 유세인트 비밀번호가 맞지 않아요.";

function extractSsoToken(body) {
  const text = String(body || "");
  if (!text.includes("sToken=")) return "";
  const raw = text.split("sToken=")[1].split("&")[0].split("'")[0].split('"')[0].split(";")[0];
  return raw.replace(/x(2B|2F|3D|5F|78|79|7A)/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  ).trim();
}

function hiddenFields(html) {
  const fields = {};
  const re = /<input\b[^>]*>/gi;
  let match;
  while ((match = re.exec(html))) {
    const tag = match[0];
    const type = (/type=["']?([^"'\s>]+)/i.exec(tag) || [])[1] || "text";
    if (type.toLowerCase() !== "hidden") continue;
    const name = (/name=["']?([^"'\s>]+)/i.exec(tag) || [])[1];
    const value = (/value=["']?([^"']*)/i.exec(tag) || [])[1] || "";
    if (name && (fields[name] == null || fields[name] === "")) fields[name] = value;
  }
  return fields;
}

function alertMessage(body) {
  const match = String(body || "").match(/alert\("([\s\S]*?)"\)/);
  if (!match) return "";
  return match[1].replace(/\\n/g, " ").replace(/\s+/g, " ").trim();
}

function interpretSmartidLogin(body, token) {
  const clean = String(token || extractSsoToken(body) || "").trim();
  if (clean) return { ok: true };
  const alert = alertMessage(body);
  const blob = `${alert}\n${body || ""}`;
  if (/일치하지|잘못되었|인증에 실패|auth failed|invalid sso token/i.test(blob)) {
    return { ok: false, error: PASSWORD_ERROR };
  }
  if (alert) return { ok: false, error: alert.slice(0, 120) };
  return { ok: false, error: "재학생 인증 응답을 확인하지 못했어요. 다시 시도해 주세요." };
}

function cookieHeader(jar) {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function storeCookies(jar, headers) {
  const list = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : String(headers.get("set-cookie") || "").split(/,(?=[^;]+=)/);
  for (const line of list) {
    const pair = String(line).split(";")[0];
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

async function request(jar, url, { method = "GET", form, referer } = {}) {
  const headers = {
    "User-Agent": USER_AGENT,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    Referer: referer || SMARTID_PAGE,
    Origin: "https://smartid.ssu.ac.kr",
  };
  const cookie = cookieHeader(jar);
  if (cookie) headers.Cookie = cookie;
  let body;
  if (form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(form).toString();
  }
  const res = await fetch(url, {
    method,
    headers,
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(20000),
  });
  storeCookies(jar, res.headers);
  const text = await res.text();
  return { status: res.status, text, location: res.headers.get("location") || "" };
}

/**
 * @returns {Promise<{ ok: true, studentId: string } | { ok: false, error: string }>}
 */
async function verifySsuStudent({ studentId, password }) {
  const id = String(studentId || "").trim();
  const pw = String(password || "");
  if (!/^\d{6,10}$/.test(id)) {
    return { ok: false, error: "학번은 숫자 6~10자리로 입력해 주세요." };
  }
  if (!pw) return { ok: false, error: "유세인트 비밀번호를 입력해 주세요." };

  const jar = new Map();
  let page;
  try {
    page = await request(jar, SMARTID_PAGE);
  } catch (_) {
    return { ok: false, error: "숭실 통합 로그인 서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요." };
  }
  const fields = hiddenFields(page.text);
  const form = {
    in_tp_bit: fields.in_tp_bit || "0",
    rqst_caus_cd: fields.rqst_caus_cd || "03",
    userid: id,
    pwd: pw,
  };
  let posted;
  try {
    posted = await request(jar, SMARTID_POST, { method: "POST", form });
  } catch (_) {
    return { ok: false, error: "숭실 통합 로그인 서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요." };
  }
  const token = (jar.get("sToken") || "").trim() || extractSsoToken(`${posted.text}\n${posted.location}`);
  const verdict = interpretSmartidLogin(`${posted.text}\n${posted.location}`, token);
  if (!verdict.ok) return verdict;
  return { ok: true, studentId: id };
}

module.exports = {
  verifySsuStudent,
  extractSsoToken,
  hiddenFields,
  interpretSmartidLogin,
  alertMessage,
};
