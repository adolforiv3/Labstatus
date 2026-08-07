import { stationBoardStore } from "./stores.mjs";
import { updateJSON } from "./occ.mjs";
import { STATIONS, STALE_MS, HISTORY_LIMIT } from "./config.mjs";

const STATIONS_KEY = "stations";
const TASKS_KEY = "tasks";
const HISTORY_KEY = "history";

export function slugify(name) {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "station"
  );
}

// --- Stations: physical locations only (name/zone). No task state lives
// here anymore - a station can host any number of concurrent task slots
// (see tasks below), since more than one person can work the same bay on
// separate devices at once. STATIONS in config.mjs is only the *initial*
// seed, used the first time the board is read; once persisted, the stored
// list is authoritative and admin add/rename/delete actions mutate it
// directly, so the roster can diverge from the config without a redeploy.
function seedStations() {
  return STATIONS.map((cfg) => ({ id: cfg.id, name: cfg.name, zone: cfg.zone }));
}

export async function loadStations() {
  const store = stationBoardStore();
  const stored = await store.get(STATIONS_KEY, { type: "json" });
  return stored && stored.length ? stored : seedStations();
}

export async function mutateStations(mutate) {
  const store = stationBoardStore();
  return updateJSON(store, STATIONS_KEY, async (current) => mutate(current && current.length ? current : seedStations()));
}

// --- Tasks: one entry per active claim. Multiple tasks can reference the
// same stationId at once (concurrent work on separate devices at one
// bay) - only completed/released tasks are removed, everything else is
// the live board.
export async function loadTasks() {
  const store = stationBoardStore();
  return (await store.get(TASKS_KEY, { type: "json" })) || [];
}

export async function mutateTasks(mutate) {
  const store = stationBoardStore();
  return updateJSON(store, TASKS_KEY, async (current) => mutate(current || []));
}

export function newTask({ id, stationId, ownerName, taskLabel, kit }) {
  const now = new Date().toISOString();
  return {
    id,
    stationId,
    status: "in-progress", // in-progress | blocked | review
    ownerName,
    taskLabel,
    kit,
    taskStartedAt: now,
    taskDurationMs: null, // frozen once the task timer stops (sent to review)
    reviewStartedAt: null,
    updates: [], // [{ts, note, status, attachment?}]
    helpFlag: false,
    updatedAt: now,
    lastNoteAt: now, // reminder-nudge clock: starts at claim, only reset by a manual addUpdate note
    lastReminderAt: null,
  };
}

// Adds derived, never-persisted display fields: the stale flag (active
// >4h since last update) and live elapsed times for whichever timer is
// currently running, computed against "now" on every read.
export function withDerived(task) {
  const stale = !!task.updatedAt && Date.now() - new Date(task.updatedAt).getTime() > STALE_MS;
  const taskElapsedMs =
    task.taskDurationMs != null
      ? task.taskDurationMs
      : task.taskStartedAt
        ? Date.now() - new Date(task.taskStartedAt).getTime()
        : null;
  const reviewElapsedMs = task.reviewStartedAt ? Date.now() - new Date(task.reviewStartedAt).getTime() : null;
  return { ...task, stale, taskElapsedMs, reviewElapsedMs };
}

export async function loadHistory() {
  const store = stationBoardStore();
  return (await store.get(HISTORY_KEY, { type: "json" })) || [];
}

// Appends one completed-task record, capping the log at HISTORY_LIMIT most
// recent entries so it never grows unbounded.
export async function appendHistory(entry) {
  const store = stationBoardStore();
  return updateJSON(store, HISTORY_KEY, async (current) => {
    const next = [entry, ...(current || [])];
    return next.slice(0, HISTORY_LIMIT);
  });
}
