// Re-plans the week on the phone with the absences from Supabase, using the extension's own planning rules
// (plan.js is a copy of weekplanner-extension/src/plan.js: run `npm run sync-plan` after changing it there).
// Runs in the device's local time, which is why this happens in the app and not in the UTC Edge Function.
import './plan.js';

const { planWeek, addDays, mondayOf, iso } = globalThis.Plan;
const FIELDS = ['id', 'kind', 'day', 'start', 'end', 'title', 'note', 'optional', 'cancelled'];

/** This week and next as [{weekStart, items}]; falls back to the laptop's computed weeks if it sent no raw inputs. */
export function replan(planner, absences = {}, now = new Date()) {
  if (!planner?.raw) return planner?.weeks ?? [];
  const r = planner.raw;
  return [0, 7].map((offset) => {
    const weekStart = addDays(mondayOf(now), offset);
    const { items } = planWeek({
      weekStart, now: now.getTime(), absences,
      lessons: r.lessons, shifts: r.shifts, travel: r.travel, deadlines: r.deadlines,
      templates: r.templates, exercises: r.exercises, topics: r.topics, studied: r.studied,
    });
    return { weekStart: iso(weekStart), items: items.map((i) => Object.fromEntries(FIELDS.map((f) => [f, i[f]]))) };
  });
}
