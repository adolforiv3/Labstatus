// Scheduled function (see `config.schedule` below) - runs on a timer, not
// in response to a request. Gently nudges whoever's subscribed to a task
// to post an update if the task has gone quiet for a while: optional,
// never blocks anything, just a "still working on this?" push.
import { loadTasks, mutateTasks, loadStations } from "./lib/state.mjs";
import { loadSubscriptions, notifyScope } from "./lib/push.mjs";
import { REMINDER_MS } from "./lib/config.mjs";

export default async () => {
  const [tasks, stations, subscriptions] = await Promise.all([loadTasks(), loadStations(), loadSubscriptions()]);

  // Only bother with tasks that actually have someone subscribed to hear
  // about them - no point computing staleness for a task nobody asked to
  // be reminded on.
  const subscribedTaskIds = new Set(subscriptions.map((s) => s.scope));
  const now = Date.now();

  const due = tasks.filter((t) => {
    if (t.status === "review") return false; // review has its own admin-facing flow, not a "keep logging notes" nudge
    if (!subscribedTaskIds.has(t.id)) return false;
    // Clock starts at claim (taskStartedAt) and only resets on a manual
    // addUpdate note (lastNoteAt) - not on help-flag toggles or a
    // note-less attachment, which also touch updatedAt but shouldn't
    // count as "they told us what's going on."
    const sinceNote = now - new Date(t.lastNoteAt || t.taskStartedAt).getTime();
    const sinceReminder = t.lastReminderAt ? now - new Date(t.lastReminderAt).getTime() : Infinity;
    return sinceNote >= REMINDER_MS && sinceReminder >= REMINDER_MS;
  });

  if (!due.length) return new Response("no reminders due", { status: 200 });

  const dueIds = new Set(due.map((t) => t.id));
  await mutateTasks((current) => {
    const nowIso = new Date().toISOString();
    return current.map((t) => (dueIds.has(t.id) ? { ...t, lastReminderAt: nowIso } : t));
  });

  await Promise.all(
    due.map((t) => {
      const station = stations.find((s) => s.id === t.stationId);
      return notifyScope(t.id, {
        title: "Still on this?",
        body: `${station ? station.name : t.stationId}: "${t.taskLabel}" hasn't had an update in a while - a quick note keeps things visible.`,
        url: `/task.html?id=${encodeURIComponent(t.id)}`,
        tag: "reminder-" + t.id, // replaces any earlier un-clicked reminder for the same task instead of stacking
      }).catch(() => {});
    })
  );

  return new Response(`sent ${due.length} reminder(s)`, { status: 200 });
};

// Runs every 5 min so a 15-minute reminder interval actually resolves to
// roughly 15 minutes, not gets rounded up to whatever the schedule tick
// happens to be. Each task still only gets reminded once per REMINDER_MS
// regardless of how often this runs.
export const config = { schedule: "*/5 * * * *" };
