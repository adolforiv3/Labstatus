import { getStore } from "@netlify/blobs";

// "strong" consistency trades a little read latency for "every read sees
// every prior write" - important here since two people can claim/update
// stations within seconds of each other on a shared wall display, and the
// board is low-QPS enough that the latency cost is irrelevant.
export function stationBoardStore() {
  return getStore({ name: "lab-status-board", consistency: "strong" });
}
