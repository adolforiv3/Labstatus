import { json, withErrorBoundary } from "./lib/http.mjs";
import { ConcurrentWriteError } from "./lib/occ.mjs";
import { ZONES } from "./lib/config.mjs";
import {
  loadStations,
  mutateStations,
  withStaleFlag,
  loadTeams,
  mutateTeams,
  publicTeam,
} from "./lib/state.mjs";
import {
  hashPasscode,
  verifyPasscode,
  newTeamToken,
  resolveTeamToken,
  newAdminToken,
  resolveAdminToken,
  checkBoardAdminPasscode,
} from "./lib/auth.mjs";

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const STATUSES = ["idle", "in-progress", "qa", "blocked"];

function isAdmin(body) {
  return !!body.adminToken && resolveAdminToken(body.adminToken);
}

// Resolves which team a request is authorized as, verifying the token
// actually maps to the station's assigned team (unless the caller is an
// admin, who can act on any station).
function authorizeStation(station, body) {
  if (isAdmin(body)) return { ok: true, admin: true };
  const teamId = resolveTeamToken(body.teamToken);
  if (!teamId) return { ok: false, error: "unauthorized - enter this team's passcode", status: 401 };
  if (station.assignedTeamId !== teamId) {
    return { ok: false, error: "this station belongs to a different team", status: 403 };
  }
  return { ok: true, admin: false, teamId };
}

export default withErrorBoundary(async (req) => {
  const method = req.method;

  if (method === "GET") {
    const [stations, teams] = await Promise.all([loadStations(), loadTeams()]);
    return json({
      stations: stations.map(withStaleFlag),
      teams: teams.map(publicTeam),
      zones: ZONES,
    });
  }

  if (method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  const body = await req.json().catch(() => ({}));
  const action = body.action;

  try {
    if (action === "verifyTeamPasscode") {
      const teams = await loadTeams();
      const team = teams.find((t) => t.id === body.teamId);
      if (!team || !team.hash || !verifyPasscode(body.passcode || "", team.salt, team.hash)) {
        return json({ error: "incorrect passcode" }, 401);
      }
      return json({ token: newTeamToken(team.id) });
    }

    if (action === "adminVerify") {
      if (!checkBoardAdminPasscode(body.passcode)) {
        return json({ error: "incorrect admin passcode" }, 401);
      }
      return json({ token: newAdminToken() });
    }

    if (action === "claim") {
      const stationId = body.stationId;
      const ownerName = (body.ownerName || "").trim();
      const taskLabel = (body.taskLabel || "").trim();
      const status = STATUSES.includes(body.status) ? body.status : "in-progress";
      if (!ownerName) return json({ error: "name is required" }, 400);

      const stations = await mutateStations((stations) => {
        const idx = stations.findIndex((s) => s.id === stationId);
        if (idx === -1) throw new ApiError("station not found", 404);
        const station = stations[idx];
        const auth = authorizeStation(station, body);
        if (!auth.ok) throw new ApiError(auth.error, auth.status);
        if (station.assignedTeamId && station.status !== "idle" && !auth.admin) {
          throw new ApiError("this station is already claimed", 409);
        }
        const now = new Date().toISOString();
        const next = [...stations];
        next[idx] = {
          ...station,
          ownerName,
          taskLabel,
          status,
          eta: body.eta ? String(body.eta).trim() : null,
          claimedAt: now,
          updatedAt: now,
          helpFlag: false,
        };
        return next;
      });
      return json({ stations: stations.map(withStaleFlag) });
    }

    if (action === "update") {
      const stationId = body.stationId;
      const stations = await mutateStations((stations) => {
        const idx = stations.findIndex((s) => s.id === stationId);
        if (idx === -1) throw new ApiError("station not found", 404);
        const station = stations[idx];
        const auth = authorizeStation(station, body);
        if (!auth.ok) throw new ApiError(auth.error, auth.status);
        if (station.status === "idle") throw new ApiError("station is not claimed", 400);
        const next = [...stations];
        const updated = { ...station, updatedAt: new Date().toISOString() };
        if (typeof body.taskLabel === "string") updated.taskLabel = body.taskLabel.trim();
        if (typeof body.ownerName === "string" && body.ownerName.trim()) updated.ownerName = body.ownerName.trim();
        if (STATUSES.includes(body.status)) updated.status = body.status;
        if (typeof body.eta === "string") updated.eta = body.eta.trim() || null;
        next[idx] = updated;
        return next;
      });
      return json({ stations: stations.map(withStaleFlag) });
    }

    if (action === "release") {
      const stationId = body.stationId;
      const stations = await mutateStations((stations) => {
        const idx = stations.findIndex((s) => s.id === stationId);
        if (idx === -1) throw new ApiError("station not found", 404);
        const station = stations[idx];
        const auth = authorizeStation(station, body);
        if (!auth.ok) throw new ApiError(auth.error, auth.status);
        const next = [...stations];
        next[idx] = {
          ...station,
          ownerName: null,
          taskLabel: null,
          status: "idle",
          claimedAt: null,
          updatedAt: null,
          eta: null,
          helpFlag: false,
        };
        return next;
      });
      return json({ stations: stations.map(withStaleFlag) });
    }

    if (action === "toggleHelp") {
      const stationId = body.stationId;
      const stations = await mutateStations((stations) => {
        const idx = stations.findIndex((s) => s.id === stationId);
        if (idx === -1) throw new ApiError("station not found", 404);
        const station = stations[idx];
        const auth = authorizeStation(station, body);
        if (!auth.ok) throw new ApiError(auth.error, auth.status);
        if (station.status === "idle") throw new ApiError("station is not claimed", 400);
        const next = [...stations];
        next[idx] = { ...station, helpFlag: !station.helpFlag, updatedAt: new Date().toISOString() };
        return next;
      });
      return json({ stations: stations.map(withStaleFlag) });
    }

    if (action === "adminReassign") {
      if (!isAdmin(body)) return json({ error: "admin passcode required" }, 401);
      const stations = await mutateStations((stations) => {
        const idx = stations.findIndex((s) => s.id === body.stationId);
        if (idx === -1) throw new ApiError("station not found", 404);
        const next = [...stations];
        next[idx] = { ...stations[idx], assignedTeamId: body.teamId || null };
        return next;
      });
      return json({ stations: stations.map(withStaleFlag) });
    }

    if (action === "adminForceRelease") {
      if (!isAdmin(body)) return json({ error: "admin passcode required" }, 401);
      const stations = await mutateStations((stations) => {
        const idx = stations.findIndex((s) => s.id === body.stationId);
        if (idx === -1) throw new ApiError("station not found", 404);
        const next = [...stations];
        next[idx] = {
          ...stations[idx],
          ownerName: null,
          taskLabel: null,
          status: "idle",
          claimedAt: null,
          updatedAt: null,
          eta: null,
          helpFlag: false,
        };
        return next;
      });
      return json({ stations: stations.map(withStaleFlag) });
    }

    if (action === "adminRenameStation") {
      if (!isAdmin(body)) return json({ error: "admin passcode required" }, 401);
      const name = (body.name || "").trim();
      if (!name) return json({ error: "station name required" }, 400);
      const stations = await mutateStations((stations) => {
        const idx = stations.findIndex((s) => s.id === body.stationId);
        if (idx === -1) throw new ApiError("station not found", 404);
        const next = [...stations];
        next[idx] = { ...stations[idx], name };
        return next;
      });
      return json({ stations: stations.map(withStaleFlag) });
    }

    if (action === "adminRenameTeam") {
      if (!isAdmin(body)) return json({ error: "admin passcode required" }, 401);
      const name = (body.name || "").trim();
      if (!name) return json({ error: "team name required" }, 400);
      const teams = await mutateTeams((teams) => {
        const idx = teams.findIndex((t) => t.id === body.teamId);
        if (idx === -1) throw new ApiError("team not found", 404);
        const next = [...teams];
        next[idx] = { ...teams[idx], name };
        return next;
      });
      return json({ teams: teams.map(publicTeam) });
    }

    if (action === "adminSetTeamPasscode") {
      if (!isAdmin(body)) return json({ error: "admin passcode required" }, 401);
      const teamId = (body.teamId || "").trim();
      const name = (body.name || "").trim();
      if (!teamId || !name) return json({ error: "team id and name required" }, 400);
      if (!body.passcode || String(body.passcode).length < 4) {
        return json({ error: "passcode must be 4+ characters" }, 400);
      }
      const { salt, hash } = hashPasscode(String(body.passcode));
      const teams = await mutateTeams((teams) => {
        const idx = teams.findIndex((t) => t.id === teamId);
        const updated = { id: teamId, name, salt, hash };
        if (idx === -1) return [...teams, updated];
        const next = [...teams];
        next[idx] = updated;
        return next;
      });
      return json({ teams: teams.map(publicTeam) });
    }

    return json({ error: "unknown action" }, 400);
  } catch (err) {
    if (err instanceof ApiError) return json({ error: err.message }, err.status);
    if (err instanceof ConcurrentWriteError) {
      return json({ error: "too much contention updating the board - please retry" }, 409);
    }
    throw err;
  }
});
