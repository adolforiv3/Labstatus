import { stationBoardStore } from "./stores.mjs";
import { updateJSON } from "./occ.mjs";
import { STATIONS, STALE_MS, HISTORY_LIMIT } from "./config.mjs";

const STATIONS_KEY = "stations";
const HISTORY_KEY = "history";

function emptyStationState(cfg) {
  return {
    id: cfg.id,
    name: cfg.name,
    zone: cfg.zone,
    status: "idle", // idle | in-progress | blocked | review
    ownerName: null,
    taskLabel: null,
    taskStartedAt: null, // set on claim, cleared on completion/release
    taskDurationMs: null, // frozen once the task timer stops (sent to review)
    reviewStartedAt: null, // set when sent to review, cleared on completion/release
    updates: [], // [{ts, note, status}] running log for the *current* task only
    helpFlag: false,
    updatedAt: null,
  };
}

// Reconciles persisted station state with STATIONS config: new stations
// appear as idle, removed ones disappear - editing the config array is the
// entire add/remove workflow. Name stays whatever an admin renamed it to
// (falls back to config name only when nothing's persisted yet); zone
// always follows the config, since that's the physical layout.
function mergeWithConfig(stored) {
  const byId = new Map((stored || []).map((s) => [s.id, s]));
  return STATIONS.map((cfg) => {
    const existing = byId.get(cfg.id);
    if (!existing) return emptyStationState(cfg);
    return { ...existing, name: existing.name || cfg.name, zone: cfg.zone };
  });
}

export async function loadStations() {
  const store = stationBoardStore();
  const stored = await store.get(STATIONS_KEY, { type: "json" });
  return mergeWithConfig(stored);
}

export async function mutateStations(mutate) {
  const store = stationBoardStore();
  return updateJSON(store, STATIONS_KEY, async (current) => mutate(mergeWithConfig(current)));
}

// Adds derived, never-persisted display fields: the stale flag (active
// >4h since last update) and live elapsed times for whichever timer is
// currently running, computed against "now" on every read.
export function withDerived(station) {
  const stale =
    station.status !== "idle" &&
    !!station.updatedAt &&
    Date.now() - new Date(station.updatedAt).getTime() > STALE_MS;
  const taskElapsedMs =
    station.taskDurationMs != null
      ? station.taskDurationMs
      : station.taskStartedAt
        ? Date.now() - new Date(station.taskStartedAt).getTime()
        : null;
  const reviewElapsedMs = station.reviewStartedAt ? Date.now() - new Date(station.reviewStartedAt).getTime() : null;
  return { ...station, stale, taskElapsedMs, reviewElapsedMs };
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
