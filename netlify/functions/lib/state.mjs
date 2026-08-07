import { stationBoardStore } from "./stores.mjs";
import { updateJSON } from "./occ.mjs";
import { STATIONS, DEFAULT_TEAMS, STALE_MS } from "./config.mjs";

const STATIONS_KEY = "stations";
const TEAMS_KEY = "teams";

function emptyStationState(cfg) {
  return {
    id: cfg.id,
    name: cfg.name,
    zone: cfg.zone,
    assignedTeamId: null,
    ownerName: null,
    taskLabel: null,
    status: "idle",
    claimedAt: null,
    updatedAt: null,
    eta: null,
    helpFlag: false,
  };
}

// Reconciles persisted station state with STATIONS_CONFIG: new stations in
// the config appear as idle, stations removed from the config disappear -
// so editing the config array is the entire "add/rename/remove a bay"
// workflow, no migration step needed.
function mergeWithConfig(stored) {
  const byId = new Map((stored || []).map((s) => [s.id, s]));
  return STATIONS.map((cfg) => {
    const existing = byId.get(cfg.id);
    if (!existing) return emptyStationState(cfg);
    // Name/zone always follow the config (source of truth for layout);
    // everything else is live state.
    return { ...existing, name: cfg.name, zone: cfg.zone };
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

// Adds the derived `stale` flag (>4h since last update, still active) for
// client display - never persisted, so it's always computed against "now".
export function withStaleFlag(station) {
  const stale =
    station.status !== "idle" &&
    !!station.updatedAt &&
    Date.now() - new Date(station.updatedAt).getTime() > STALE_MS;
  return { ...station, stale };
}

export async function loadTeams() {
  const store = stationBoardStore();
  const stored = await store.get(TEAMS_KEY, { type: "json" });
  if (stored && stored.length) return stored;
  // First read ever: seed defaults with no passcode set (claiming is
  // blocked until an admin sets one via adminSetTeamPasscode).
  return DEFAULT_TEAMS.map((t) => ({ id: t.id, name: t.name, salt: null, hash: null }));
}

export async function mutateTeams(mutate) {
  const store = stationBoardStore();
  return updateJSON(store, TEAMS_KEY, async (current) => {
    const base = current && current.length ? current : DEFAULT_TEAMS.map((t) => ({ id: t.id, name: t.name, salt: null, hash: null }));
    return mutate(base);
  });
}

export function publicTeam(t) {
  return { id: t.id, name: t.name, hasPasscode: !!t.hash };
}
