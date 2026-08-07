import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

// Admin-only actions (force-release a station, rename a station) are gated
// by a single shared passcode - there's no per-person login in this tool by
// design (anyone can claim/update/complete a task by just typing their
// name), so this is the one piece of access control that still exists.
const TOKEN_SECRET = process.env.STATION_TOKEN_SECRET || "lab-status-board-dev-secret-change-me";
const BOARD_ADMIN_PASSCODE = process.env.STATION_ADMIN_PASSCODE || "boardadmin";
// Shared passcode gating basic task-view access (claim/update/etc) - not
// per-person, just a bar against anyone outside the team getting into the
// board's task pages at all. Deliberately separate from the admin
// passcode: a regular team member unlocking task view should never also
// unlock admin actions.
const USER_PASSCODE = process.env.STATION_USER_PASSCODE || "labuser";
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours, matches a shift + margin

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}
function fromB64url(str) {
  return Buffer.from(str, "base64url");
}

function signToken(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", TOKEN_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", TOKEN_SECRET).update(body).digest("base64url");
  const sigBuf = Buffer.from(sig, "utf8");
  const expBuf = Buffer.from(expected, "utf8");
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const payload = JSON.parse(fromB64url(body).toString("utf8"));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

export function newAdminToken() {
  return signToken({ admin: true, exp: Date.now() + TOKEN_TTL_MS, n: randomBytes(4).toString("hex") });
}

export function resolveAdminToken(token) {
  const payload = verifyToken(token);
  return !!(payload && payload.admin === true);
}

export function checkBoardAdminPasscode(passcode) {
  return !!passcode && passcode === BOARD_ADMIN_PASSCODE;
}

export function newUserToken() {
  return signToken({ user: true, exp: Date.now() + TOKEN_TTL_MS, n: randomBytes(4).toString("hex") });
}

export function resolveUserToken(token) {
  const payload = verifyToken(token);
  return !!(payload && payload.user === true);
}

export function checkUserPasscode(passcode) {
  return !!passcode && passcode === USER_PASSCODE;
}
