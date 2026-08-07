import { scryptSync, randomBytes, createHmac, timingSafeEqual } from "node:crypto";

// Separate secret from the main admin-token secret (lib/auth.mjs) so a
// leaked board token can never be replayed against the inventory admin API
// or vice versa - each token kind is scoped to exactly the API surface that
// issued it.
const TOKEN_SECRET = process.env.STATION_TOKEN_SECRET || "lab-status-board-dev-secret-change-me";
// Bootstrap/recovery admin passcode for the board specifically (reassigning
// stations, force-releasing, setting team passcodes) - same always-on
// shared-passcode pattern as ADMIN_PASSCODE in lib/auth.mjs, kept separate
// so board admin access doesn't require an inventory admin account.
const BOARD_ADMIN_PASSCODE = process.env.STATION_ADMIN_PASSCODE || "boardadmin";
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours, matches a shift + margin

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}
function fromB64url(str) {
  return Buffer.from(str, "base64url");
}

export function hashPasscode(passcode, salt = randomBytes(16).toString("hex")) {
  const hash = scryptSync(passcode, salt, 64).toString("hex");
  return { salt, hash };
}

export function verifyPasscode(passcode, salt, hash) {
  if (!salt || !hash) return false;
  const attempt = scryptSync(passcode, salt, 64).toString("hex");
  const a = Buffer.from(attempt, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
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

export function newTeamToken(teamId) {
  return signToken({ teamId, exp: Date.now() + TOKEN_TTL_MS });
}

// Returns the teamId a token authorizes, or null if missing/expired/invalid.
export function resolveTeamToken(token) {
  const payload = verifyToken(token);
  if (!payload || !payload.teamId) return null;
  return payload.teamId;
}

export function newAdminToken() {
  return signToken({ admin: true, exp: Date.now() + TOKEN_TTL_MS });
}

export function resolveAdminToken(token) {
  const payload = verifyToken(token);
  return !!(payload && payload.admin === true);
}

export function checkBoardAdminPasscode(passcode) {
  return !!passcode && passcode === BOARD_ADMIN_PASSCODE;
}
