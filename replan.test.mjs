import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replan } from './replan.js';

// Tuesday 20/10/2026: a lesson 13:30-15:00 with its train, and a study template on Thursday 19:00-20:00.
const at = (d, h, m = 0) => new Date(2026, 9, d, h, m).getTime();
const planner = {
  weeks: [{ weekStart: 'laptop', items: [] }],
  raw: {
    lessons: [{ start: at(20, 13, 30), end: at(20, 15), title: 'CaOS', location: 'BST' }],
    shifts: [], deadlines: [], exercises: [], topics: {}, studied: {},
    travel: [{ start: at(20, 11, 25), end: at(20, 13, 30), title: 'Naar school' }],
    templates: [{ id: 's1', kind: 'studie', day: 3, start: '19:00', end: '20:00', title: 'PF oefenen' }],
  },
};
const morning = new Date(2026, 9, 20, 9, 0);
const day = (weeks, d) => weeks[0].items.filter((i) => i.day === d);

test('without raw inputs the laptop weeks are used as they are', () => {
  assert.deepEqual(replan({ weeks: [{ weekStart: 'x', items: [] }] }), [{ weekStart: 'x', items: [] }]);
});

test('a normal day keeps lesson and train; study stays on Thursday', () => {
  const weeks = replan(planner, {}, morning);
  assert.equal(weeks[0].weekStart, '2026-10-19');
  assert.deepEqual(day(weeks, 1).map((i) => [i.kind, !!i.cancelled]).sort(), [['les', false], ['reis', false]]); // order: the app sorts by time
  assert.deepEqual(day(weeks, 3).map((i) => i.title), ['PF oefenen']);
});

test('"Geen school" today: lesson cancelled, train gone, study pulled forward to today from now on', () => {
  const weeks = replan(planner, { '2026-10-20': 'vrij' }, morning);
  const today = day(weeks, 1);
  assert.ok(today.find((i) => i.kind === 'les').cancelled);
  assert.ok(!today.some((i) => i.kind === 'reis'));
  const study = today.find((i) => i.title === 'PF oefenen');
  assert.ok(study && study.start >= 9 * 60, 'study moved onto the free day');
  assert.deepEqual(day(weeks, 3), []);
});
