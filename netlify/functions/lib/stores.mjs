import { getStore } from "@netlify/blobs";

// "strong" consistency trades a little read latency for "every read sees
// every prior write" - important here since two people can claim/update
// stations within seconds of each other on a shared wall display, and the
// board is low-QPS enough that the latency cost is irrelevant.
export function stationBoardStore() {
  return getStore({ name: "lab-status-board", consistency: "strong" });
}
// Binary attachments (screenshots, .txt files, etc.) uploaded to a task's
// update log - kept in its own store rather than inline in the JSON station
// state, since Blobs' JSON get/set path isn't meant for large binary
// payloads. Station/history entries only ever reference an attachment by
// its key here, never embed the bytes.
export function attachmentsStore() {
  return getStore({ name: "lab-status-board-attachments", consistency: "strong" });
}
// Web Push subscriptions - one entry per device that's granted notification
// permission, either scoped to "admin" (gets pinged whenever a task enters
// review) or to a specific taskId (gets pinged whenever that task gets a
// new update/reject/approve). Kept separate from the main board store since
// it's a different shape of data with its own churn pattern (devices
// subscribing/unsubscribing) unrelated to station/task state.
export function pushSubscriptionsStore() {
  return getStore({ name: "lab-status-board-push", consistency: "strong" });
}
