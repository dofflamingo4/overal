import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hhmm, mondayIso, dayItems, openDeadlines, nowNext, untilText, dueLabel, appleForDay } from './logic.js';

test('appleForDay splits timed and all-day events and merges into the day', () => {
  const tue = new Date(2026, 9, 20, 12, 0);
  const events = [
    { title: 'Tandarts', location: 'Aalst', start: new Date(2026, 9, 20, 16, 0).toISOString(), end: new Date(2026, 9, 20, 16, 30).toISOString(), allDay: false },
    { title: 'Morgen', start: new Date(2026, 9, 21, 9, 0).toISOString(), end: new Date(2026, 9, 21, 10, 0).toISOString(), allDay: false },
    { title: 'Verlof', start: '2026-10-19', end: '2026-10-21', allDay: true },
  ];
  const { timed, allDay } = appleForDay(events, tue);
  assert.deepEqual(timed.map((i) => [i.title, i.start, i.end, i.kind]), [['Tandarts', 960, 990, 'apple']]);
  assert.deepEqual(allDay.map((e) => e.title), ['Verlof']);
  assert.equal(appleForDay(events, new Date(2026, 9, 21)).allDay.length, 0); // end date is exclusive
  assert.deepEqual(dayItems(null, tue, tue, timed).map((i) => i.title), ['Tandarts']); // works without planner data
});

test('nowNext finds the running and the upcoming block', () => {
  const items = [{ id: 'a', status: 'past' }, { id: 'b', status: 'now' }, { id: 'c', status: '' }, { id: 'd', status: '' }];
  assert.deepEqual([nowNext(items).now.id, nowNext(items).next.id], ['b', 'c']);
  assert.deepEqual(nowNext([{ status: 'past' }]), { now: null, next: null });
});

test('untilText switches from minutes to hours', () => {
  assert.equal(untilText(600, 575), 'over 25 min');
  assert.equal(untilText(600, 530), 'over 1 u 10');
  assert.equal(untilText(600, 480), 'over 2 u');
});

test('dueLabel: late, today, tomorrow, later', () => {
  const now = new Date(2026, 9, 20, 12, 0);
  assert.equal(dueLabel(new Date(2026, 9, 20, 9, 0).toISOString(), now), 'te laat');
  assert.equal(dueLabel(new Date(2026, 9, 20, 23, 59).toISOString(), now), 'vandaag 23:59');
  assert.equal(dueLabel(new Date(2026, 9, 21, 14, 0).toISOString(), now), 'morgen 14:00');
  assert.equal(dueLabel(new Date(2026, 9, 23, 23, 59).toISOString(), now), 'vr 23/10');
});

test('hhmm pads hours and minutes', () => assert.equal(hhmm(9 * 60 + 5), '09:05'));

test('mondayIso maps every weekday (incl. sunday) to its monday', () => {
  assert.equal(mondayIso(new Date(2026, 9, 19)), '2026-10-19'); // monday
  assert.equal(mondayIso(new Date(2026, 9, 25)), '2026-10-19'); // sunday
});

test('dayItems picks today, drops cancelled, sorts and marks past/now', () => {
  const planner = { weeks: [{ weekStart: '2026-10-19', items: [
    { id: 'b', day: 1, start: 600, end: 700, title: 'later' },
    { id: 'a', day: 1, start: 500, end: 560, title: 'done' },
    { id: 'c', day: 1, start: 590, end: 620, title: 'x', cancelled: true },
    { id: 'd', day: 2, start: 500, end: 560, title: 'tomorrow' },
  ] }] };
  const tue = new Date(2026, 9, 20, 10, 30); // 630 min
  assert.deepEqual(dayItems(planner, tue).map((i) => [i.id, i.status]), [['a', 'past'], ['b', 'now']]);
  assert.deepEqual(dayItems(planner, tue, new Date(2026, 9, 19)).map((i) => i.status), ['', '']);
  assert.deepEqual(dayItems(planner, new Date(2026, 10, 2)), []); // week not pushed
});

test('openDeadlines hides done and expired optional ones and rates urgency', () => {
  const now = new Date('2026-10-20T12:00:00Z');
  const list = openDeadlines([
    { title: 'soon', due: '2026-10-22T12:00:00Z' },
    { title: 'done', due: '2026-10-21T00:00:00Z', done: true },
    { title: 'late', due: '2026-10-19T00:00:00Z' },
    { title: 'opt', due: '2026-10-19T00:00:00Z', optional: true },
    { title: 'today', due: '2026-10-21T06:00:00Z' },
    { title: 'far', due: '2026-11-20T00:00:00Z' },
  ], now);
  assert.deepEqual(list.map((d) => [d.title, d.urgency]), [['late', 'late'], ['today', 'today'], ['soon', 'soon'], ['far', '']]);
});
