// Fixed list of physical bays/seats the tracker follows. Edit this array to
// add/rename/remove stations - the Blobs-backed state self-heals to match
// it on next read (see lib/state.mjs's mergeWithConfig).
export const STATIONS = [
  { id: "offload-bench-1", name: "Offload Bench 1", zone: "offload" },
  { id: "offload-bench-2", name: "Offload Bench 2", zone: "offload" },
  { id: "config-station-a", name: "Config Station A", zone: "config" },
  { id: "config-station-b", name: "Config Station B", zone: "config" },
  { id: "script-test-carrel-1", name: "Script Test Carrel 1", zone: "script-testing" },
  { id: "script-test-carrel-2", name: "Script Test Carrel 2", zone: "script-testing" },
  { id: "desk-zone-1", name: "Desk Zone 1", zone: "desk" },
  { id: "desk-zone-2", name: "Desk Zone 2", zone: "desk" },
];

export const ZONES = ["offload", "config", "script-testing", "desk"];

export const STALE_MS = 4 * 60 * 60 * 1000; // 4 hours, flags a card as stale
export const HISTORY_LIMIT = 500; // most recent completed tasks kept in the log
