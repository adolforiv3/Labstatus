import { json, withErrorBoundary } from "./lib/http.mjs";
import { ConcurrentWriteError } from "./lib/occ.mjs";
import { ZONES } from "./lib/config.mjs";
import { loadStations, mutateStations, withDerived, loadHistory, appendHistory } from "./lib/state.mjs";
import { newAdminToken, resolveAdminToken, checkBoardAdminPasscode } from "./lib/auth.mjs";

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function isAdmin(body) {
  return !!body.adminToken && resolveAdminToken(body.adminToken);
}

function resetToIdle(station) {
  return {
    ...station,
    status: "idle",
    ownerName: null,
    taskLabel: null,
    taskStartedAt: null,
    taskDurationMs: null,
    reviewStartedAt: null,
    updates: [],
    helpFlag: false,
    updatedAt: null,
  };
}

export default withErrorBoundary(async (req) => {
  const method = req.method;
  const url = new URL(req.url);

  if (method === "GET") {
    if (url.searchParams.get("history") === "1") {
      const history = await loadHistory();
      return json({ history });
    }
    const stations = await loadStations();
    return json({ stations: stations.map(withDerived), zones: ZONES });
  }

  if (method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  const body = await req.json().catch(() => ({}));
  const action = body.action;

  try {
    if (action === "adminVerify") {
      if (!checkBoardAdminPasscode(body.passcode)) {
        return json({ error: "incorrect admin passcode" }, 401);
      }
      return json({ token: newAdminToken() });
    }

    // Claim an idle station: starts the task timer.
    if (action === "claim") {
      const ownerName = (body.ownerName || "").trim();
      const taskLabel = (body.taskLabel || "").trim();
      if (!ownerName) return json({ error: "name is required" }, 400);
      if (!taskLabel) return json({ error: "task description is required" }, 400);

      const stations = await mutateStations((stations) => {
        const idx = stations.findIndex((s) => s.id === body.stationId);
        if (idx === -1) throw new ApiError("station not found", 404);
        const station = stations[idx];
        if (station.status !== "idle") throw new ApiError("this station is already claimed", 409);
        const now = new Date().toISOString();
        const next = [...stations];
        next[idx] = {
          ...station,
          status: "in-progress",
          ownerName,
          taskLabel,
          taskStartedAt: now,
          taskDurationMs: null,
          reviewStartedAt: null,
          updates: [],
          helpFlag: false,
          updatedAt: now,
        };
        return next;
      });
      return json({ stations: stations.map(withDerived) });
    }

    // Periodic status update: a note is always required, so the update log
    // is a real running record of the task, not just a final summary.
    // Status may move between in-progress and blocked here; moving into
    // review or completing are their own actions (see below).
    if (action === "addUpdate") {
      const note = (body.note || "").trim();
      if (!note) return json({ error: "an update note is required" }, 400);
      const nextStatus = body.status === "blocked" ? "blocked" : body.status === "in-progress" ? "in-progress" : null;

      const stations = await mutateStations((stations) => {
        const idx = stations.findIndex((s) => s.id === body.stationId);
        if (idx === -1) throw new ApiError("station not found", 404);
        const station = stations[idx];
        if (station.status !== "in-progress" && station.status !== "blocked") {
          throw new ApiError("station is not an active task", 400);
        }
        const now = new Date().toISOString();
        const next = [...stations];
        next[idx] = {
          ...station,
          status: nextStatus || station.status,
          updates: [...station.updates, { ts: now, note, status: nextStatus || station.status }],
          updatedAt: now,
        };
        return next;
      });
      return json({ stations: stations.map(withDerived) });
    }

    // Stops the task timer and starts the review timer - a note is
    // required so there's always a "here's what I did" summary going into
    // review.
    if (action === "sendToReview") {
      const note = (body.note || "").trim();
      if (!note) return json({ error: "a note is required to send this to review" }, 400);

      const stations = await mutateStations((stations) => {
        const idx = stations.findIndex((s) => s.id === body.stationId);
        if (idx === -1) throw new ApiError("station not found", 404);
        const station = stations[idx];
        if (station.status !== "in-progress" && station.status !== "blocked") {
          throw new ApiError("station is not an active task", 400);
        }
        const now = new Date().toISOString();
        const taskDurationMs = station.taskStartedAt ? Date.now() - new Date(station.taskStartedAt).getTime() : 0;
        const next = [...stations];
        next[idx] = {
          ...station,
          status: "review",
          taskDurationMs,
          reviewStartedAt: now,
          updates: [...station.updates, { ts: now, note, status: "review" }],
          updatedAt: now,
        };
        return next;
      });
      return json({ stations: stations.map(withDerived) });
    }

    // Stops the review timer, requires a closing note, logs the full
    // record (task time, review time, every update) to history, and
    // resets the station back to idle.
    if (action === "completeTask") {
      const note = (body.note || "").trim();
      if (!note) return json({ error: "a closing note is required to complete this task" }, 400);

      let historyEntry = null;
      const stations = await mutateStations((stations) => {
        const idx = stations.findIndex((s) => s.id === body.stationId);
        if (idx === -1) throw new ApiError("station not found", 404);
        const station = stations[idx];
        if (station.status !== "review") throw new ApiError("station is not in review", 400);
        const now = new Date().toISOString();
        const reviewDurationMs = station.reviewStartedAt ? Date.now() - new Date(station.reviewStartedAt).getTime() : 0;
        const updates = [...station.updates, { ts: now, note, status: "complete" }];
        historyEntry = {
          id: crypto.randomUUID(),
          stationId: station.id,
          stationName: station.name,
          zone: station.zone,
          ownerName: station.ownerName,
          taskLabel: station.taskLabel,
          taskDurationMs: station.taskDurationMs,
          reviewDurationMs,
          updates,
          startedAt: station.taskStartedAt,
          completedAt: now,
        };
        const next = [...stations];
        next[idx] = resetToIdle(station);
        return next;
      });
      await appendHistory(historyEntry);
      return json({ stations: stations.map(withDerived), completed: historyEntry });
    }

    // Abandons the current claim with no history entry - for "claimed the
    // wrong station" mistakes, not real task completion.
    if (action === "release") {
      const stations = await mutateStations((stations) => {
        const idx = stations.findIndex((s) => s.id === body.stationId);
        if (idx === -1) throw new ApiError("station not found", 404);
        const next = [...stations];
        next[idx] = resetToIdle(stations[idx]);
        return next;
      });
      return json({ stations: stations.map(withDerived) });
    }

    if (action === "toggleHelp") {
      const stations = await mutateStations((stations) => {
        const idx = stations.findIndex((s) => s.id === body.stationId);
        if (idx === -1) throw new ApiError("station not found", 404);
        const station = stations[idx];
        if (station.status === "idle") throw new ApiError("station is not an active task", 400);
        const next = [...stations];
        next[idx] = { ...station, helpFlag: !station.helpFlag, updatedAt: new Date().toISOString() };
        return next;
      });
      return json({ stations: stations.map(withDerived) });
    }

    if (action === "adminForceRelease") {
      if (!isAdmin(body)) return json({ error: "admin passcode required" }, 401);
      const stations = await mutateStations((stations) => {
        const idx = stations.findIndex((s) => s.id === body.stationId);
        if (idx === -1) throw new ApiError("station not found", 404);
        const next = [...stations];
        next[idx] = resetToIdle(stations[idx]);
        return next;
      });
      return json({ stations: stations.map(withDerived) });
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
      return json({ stations: stations.map(withDerived) });
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
