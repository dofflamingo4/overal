// Pure helpers (no DOM, no network) so they can be tested with `node --test`.
const DAY_MS = 864e5;

export const hhmm = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');

/** Monday 00:00 (local) of the week containing `date`, as YYYY-MM-DD. */
export function mondayIso(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate() - ((date.getDay() + 6) % 7));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Items of one day (0 = monday) from the pushed planner, sorted, with a status for the current day. */
export function dayItems(planner, date, now = date) {
  const week = planner?.weeks?.find((w) => w.weekStart === mondayIso(date));
  if (!week) return [];
  const day = (date.getDay() + 6) % 7;
  const sameDay = now.toDateString() === date.toDateString();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  return week.items
    .filter((i) => i.day === day && !i.cancelled)
    .sort((a, b) => a.start - b.start)
    .map((i) => ({ ...i, status: !sameDay ? '' : i.end <= nowMin ? 'past' : i.start <= nowMin ? 'now' : '' }));
}

/** The block running now and the next one still to start (from dayItems output of today). */
export function nowNext(items) {
  return { now: items.find((i) => i.status === 'now') ?? null, next: items.find((i) => !i.status) ?? null };
}

/** "over 25 min" / "over 1 u 10" until `startMin` (minutes since midnight) from `nowMin`. */
export function untilText(startMin, nowMin) {
  const left = startMin - nowMin;
  if (left < 60) return `over ${left} min`;
  const m = left % 60;
  return `over ${Math.floor(left / 60)} u${m ? ' ' + String(m).padStart(2, '0') : ''}`;
}

/** Human due label: 'te laat', 'vandaag 23:59', 'morgen 14:00', 'do 23/10', relative to `now`. */
export function dueLabel(iso, now = new Date()) {
  const due = new Date(iso);
  if (due < now) return 'te laat';
  const days = Math.round((new Date(due.getFullYear(), due.getMonth(), due.getDate()) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / DAY_MS);
  const time = hhmm(due.getHours() * 60 + due.getMinutes());
  if (days === 0) return `vandaag ${time}`;
  if (days === 1) return `morgen ${time}`;
  return `${['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'][due.getDay()]} ${due.getDate()}/${due.getMonth() + 1}`;
}

/** Open deadlines, soonest first, with an urgency level: 'late' | 'today' (< 24 h) | 'soon' (< 3 days) | ''. */
export function openDeadlines(deadlines = [], now = new Date()) {
  return deadlines
    .filter((d) => !d.done && !(d.optional && Date.parse(d.due) < now.getTime()))
    .sort((a, b) => Date.parse(a.due) - Date.parse(b.due))
    .map((d) => {
      const left = Date.parse(d.due) - now.getTime();
      return { ...d, urgency: left < 0 ? 'late' : left < DAY_MS ? 'today' : left < 3 * DAY_MS ? 'soon' : '' };
    });
}
