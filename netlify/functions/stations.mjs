import { json, withErrorBoundary } from "./lib/http.mjs";
import { ConcurrentWriteError } from "./lib/occ.mjs";
import { ZONES } from "./lib/config.mjs";
import {
  loadStations,
  mutateStations,
  loadTasks,
  mutateTasks,
  newTask,
  withDerived,
  loadHistory,
  appendHistory,
  slugify,
} from "./lib/state.mjs";
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

// The zone filter bar shows every config-defined zone plus any custom zone
// name an admin has actually used on a station, so a newly invented zone
// shows up without a code change.
function allZones(stations) {
  const extra = stations.map((s) => s.zone).filter((z) => z && !ZONES.includes(z));
  return [...ZONES, ...new Set(extra)];
}

export default withErrorBoundary(async (req) => {
  const method = req.method;
  const url = new URL(req.url);

  if (method === "GET") {
    if (url.searchParams.get("history") === "1") {
      const history = await loadHistory();
      return json({ history });
    }
    const [stations, tasks] = await Promise.all([loadStations(), loadTasks()]);
    return json({ stations, tasks: tasks.map(withDerived), zones: allZones(stations) });
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

    // Starts a new task slot at a station. Not gated on the station being
    // "free" - any number of people can claim the same station at once on
    // separate devices, so this always succeeds as long as the station
    // exists.
    if (action === "claim") {
      const ownerName = (body.ownerName || "").trim();
      const taskLabel = (body.taskLabel || "").trim();
      const kit = (body.kit || "").trim();
      if (!ownerName) return json({ error: "name is required" }, 400);
      if (!taskLabel) return json({ error: "task description is required" }, 400);
      if (!kit) return json({ error: "kit is required" }, 400);

      const stations = await loadStations();
      if (!stations.some((s) => s.id === body.stationId)) throw new ApiError("station not found", 404);

      let created = null;
      const tasks = await mutateTasks((tasks) => {
        created = newTask({ id: crypto.randomUUID(), stationId: body.stationId, ownerName, taskLabel, kit });
        return [...tasks, created];
      });
      return json({ tasks: tasks.map(withDerived), created: withDerived(created) });
    }

    // Periodic status update: a note is always required, so the update log
    // is a real running record of the task, not just a final summary.
    // Status may move between in-progress and blocked here; moving into
    // review or completing are their own actions (see below).
    if (action === "addUpdate") {
      const note = (body.note || "").trim();
      if (!note) return json({ error: "an update note is required" }, 400);
      const nextStatus = body.status === "blocked" ? "blocked" : body.status === "in-progress" ? "in-progress" : null;

      const tasks = await mutateTasks((tasks) => {
        const idx = tasks.findIndex((t) => t.id === body.taskId);
        if (idx === -1) throw new ApiError("task not found", 404);
        const task = tasks[idx];
        if (task.status !== "in-progress" && task.status !== "blocked") {
          throw new ApiError("task is not active", 400);
        }
        const now = new Date().toISOString();
        const next = [...tasks];
        next[idx] = {
          ...task,
          status: nextStatus || task.status,
          updates: [...task.updates, { ts: now, note, status: nextStatus || task.status }],
          updatedAt: now,
        };
        return next;
      });
      return json({ tasks: tasks.map(withDerived) });
    }

    // Stops the task timer and starts the review timer - a note is
    // required so there's always a "here's what I did" summary going into
    // review.
    if (action === "sendToReview") {
      const note = (body.note || "").trim();
      if (!note) return json({ error: "a note is required to send this to review" }, 400);

      const tasks = await mutateTasks((tasks) => {
        const idx = tasks.findIndex((t) => t.id === body.taskId);
        if (idx === -1) throw new ApiError("task not found", 404);
        const task = tasks[idx];
        if (task.status !== "in-progress" && task.status !== "blocked") {
          throw new ApiError("task is not active", 400);
        }
        const now = new Date().toISOString();
        const taskDurationMs = task.taskStartedAt ? Date.now() - new Date(task.taskStartedAt).getTime() : 0;
        const next = [...tasks];
        next[idx] = {
          ...task,
          status: "review",
          taskDurationMs,
          reviewStartedAt: now,
          updates: [...task.updates, { ts: now, note, status: "review" }],
          updatedAt: now,
        };
        return next;
      });
      return json({ tasks: tasks.map(withDerived) });
    }

    // Sends a task in review back to in-progress with a note explaining
    // why - the lab admin's reject path. Resumes the task timer from where
    // it left off (rather than restarting at zero) by backdating
    // taskStartedAt by whatever task time had already accumulated.
    if (action === "rejectReview") {
      if (!isAdmin(body)) return json({ error: "lab admin passcode required" }, 401);
      const note = (body.note || "").trim();
      if (!note) return json({ error: "a note is required to send this back" }, 400);

      const tasks = await mutateTasks((tasks) => {
        const idx = tasks.findIndex((t) => t.id === body.taskId);
        if (idx === -1) throw new ApiError("task not found", 404);
        const task = tasks[idx];
        if (task.status !== "review") throw new ApiError("task is not in review", 400);
        const now = new Date();
        const alreadyElapsed = task.taskDurationMs || 0;
        const next = [...tasks];
        next[idx] = {
          ...task,
          status: "in-progress",
          taskStartedAt: new Date(now.getTime() - alreadyElapsed).toISOString(),
          taskDurationMs: null,
          reviewStartedAt: null,
          updates: [...task.updates, { ts: now.toISOString(), note, status: "sent back" }],
          updatedAt: now.toISOString(),
        };
        return next;
      });
      return json({ tasks: tasks.map(withDerived) });
    }

    // Stops the review timer, requires a closing note, logs the full
    // record (task time, review time, every update) to history, and
    // removes the task slot. Lab-admin-only - this is the approval step,
    // not something the person who did the work signs off on themselves.
    if (action === "completeTask") {
      if (!isAdmin(body)) return json({ error: "lab admin passcode required to approve and complete this task" }, 401);
      const note = (body.note || "").trim();
      if (!note) return json({ error: "a closing note is required to complete this task" }, 400);

      const stations = await loadStations();
      let historyEntry = null;
      const tasks = await mutateTasks((tasks) => {
        const idx = tasks.findIndex((t) => t.id === body.taskId);
        if (idx === -1) throw new ApiError("task not found", 404);
        const task = tasks[idx];
        if (task.status !== "review") throw new ApiError("task is not in review", 400);
        const now = new Date().toISOString();
        const reviewDurationMs = task.reviewStartedAt ? Date.now() - new Date(task.reviewStartedAt).getTime() : 0;
        const updates = [...task.updates, { ts: now, note, status: "complete" }];
        const station = stations.find((s) => s.id === task.stationId);
        historyEntry = {
          id: crypto.randomUUID(),
          stationId: task.stationId,
          stationName: station ? station.name : task.stationId,
          zone: station ? station.zone : null,
          ownerName: task.ownerName,
          taskLabel: task.taskLabel,
          kit: task.kit,
          taskDurationMs: task.taskDurationMs,
          reviewDurationMs,
          updates,
          startedAt: task.taskStartedAt,
          completedAt: now,
        };
        return tasks.filter((t) => t.id !== body.taskId);
      });
      await appendHistory(historyEntry);
      return json({ tasks: tasks.map(withDerived), completed: historyEntry });
    }

    // Abandons a task slot with no history entry - for "claimed the wrong
    // station" mistakes, not real task completion.
    if (action === "release") {
      const tasks = await mutateTasks((tasks) => {
        if (!tasks.some((t) => t.id === body.taskId)) throw new ApiError("task not found", 404);
        return tasks.filter((t) => t.id !== body.taskId);
      });
      return json({ tasks: tasks.map(withDerived) });
    }

    if (action === "toggleHelp") {
      const tasks = await mutateTasks((tasks) => {
        const idx = tasks.findIndex((t) => t.id === body.taskId);
        if (idx === -1) throw new ApiError("task not found", 404);
        const next = [...tasks];
        next[idx] = { ...tasks[idx], helpFlag: !tasks[idx].helpFlag, updatedAt: new Date().toISOString() };
        return next;
      });
      return json({ tasks: tasks.map(withDerived) });
    }

    // Attaches an already-uploaded file (see attachments.mjs, which returns
    // {key, filename, mimeType, size}) to a task's update log as its own
    // entry - separate from addUpdate so a screenshot/file can be dropped
    // in without also having to write a periodic status note.
    if (action === "addAttachment") {
      const { key, filename, mimeType, size } = body.attachment || {};
      if (!key || !filename) return json({ error: "attachment upload failed" }, 400);
      const note = (body.note || "").trim();

      const tasks = await mutateTasks((tasks) => {
        const idx = tasks.findIndex((t) => t.id === body.taskId);
        if (idx === -1) throw new ApiError("task not found", 404);
        const task = tasks[idx];
        const now = new Date().toISOString();
        const next = [...tasks];
        next[idx] = {
          ...task,
          updates: [
            ...task.updates,
            { ts: now, note: note || `Attached ${filename}`, status: task.status, attachment: { key, filename, mimeType, size } },
          ],
          updatedAt: now,
        };
        return next;
      });
      return json({ tasks: tasks.map(withDerived) });
    }

    if (action === "adminForceRelease") {
      if (!isAdmin(body)) return json({ error: "lab admin passcode required" }, 401);
      const tasks = await mutateTasks((tasks) => {
        if (!tasks.some((t) => t.id === body.taskId)) throw new ApiError("task not found", 404);
        return tasks.filter((t) => t.id !== body.taskId);
      });
      return json({ tasks: tasks.map(withDerived) });
    }

    if (action === "adminAddStation") {
      if (!isAdmin(body)) return json({ error: "lab admin passcode required" }, 401);
      const name = (body.name || "").trim();
      const zone = (body.zone || "").trim() || "unassigned";
      if (!name) return json({ error: "station name required" }, 400);

      const stations = await mutateStations((stations) => {
        let id = slugify(name);
        if (stations.some((s) => s.id === id)) {
          let n = 2;
          while (stations.some((s) => s.id === `${id}-${n}`)) n++;
          id = `${id}-${n}`;
        }
        return [...stations, { id, name, zone }];
      });
      return json({ stations, zones: allZones(stations) });
    }

    // Only removable while no task is currently claimed there - an admin
    // should force-release any active tasks first, so deleting a station
    // can never silently drop in-progress work with no history record.
    if (action === "adminDeleteStation") {
      if (!isAdmin(body)) return json({ error: "lab admin passcode required" }, 401);
      const tasks = await loadTasks();
      if (tasks.some((t) => t.stationId === body.stationId)) {
        return json({ error: "force-release every active task at this station before deleting it" }, 409);
      }
      const stations = await mutateStations((stations) => {
        if (!stations.some((s) => s.id === body.stationId)) throw new ApiError("station not found", 404);
        return stations.filter((s) => s.id !== body.stationId);
      });
      return json({ stations, zones: allZones(stations) });
    }

    if (action === "adminRenameStation") {
      if (!isAdmin(body)) return json({ error: "lab admin passcode required" }, 401);
      const name = (body.name || "").trim();
      if (!name) return json({ error: "station name required" }, 400);
      const stations = await mutateStations((stations) => {
        const idx = stations.findIndex((s) => s.id === body.stationId);
        if (idx === -1) throw new ApiError("station not found", 404);
        const next = [...stations];
        next[idx] = { ...stations[idx], name };
        return next;
      });
      return json({ stations, zones: allZones(stations) });
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
