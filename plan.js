// Pure planning logic: reads iCal (TimeEdit, Strobbo) and Leho items, and lays out one week with study blocks moved around work, absences and deadlines.
(function (root) {
  const DAY_START = 9 * 60;      // earliest moved block
  const DAY_END = 22 * 60;       // latest end of a moved block
  const STEP = 30;
  const SHIFT_BUFFER = 30;       // travel time before a shift
  const VRIJ_CAP = 4 * 60;       // max study pulled onto a day off school
  const DEADLINE_WORK = 90;
  const UNDATED_CAP = 120;       // max work block for one course's tasks without deadline
  const cleanTitle = (t) => String(t).replace(/^[^\p{L}\p{N}]+/u, '').trim(); // drop leading emoji like "✍️ "
  const PF_PER_BLOCK = 3;        // exercises per Programming Fundamentals block
  const KIND_ORDER = { studie: 0, extra: 1 };
  const EXAM_PREP_MS = 22 * 864e5; // study turns towards an exam in the three weeks (+ the Monday) before it
  const EXAM_BLOCK = 120;          // extra exam block on a weekday without school (holiday, exam period): two per day
  const SCHOOL_EXAM_BLOCK = 60;    // extra exam block on a school day: one per day
  // weight 2 = a course you find hard: it gets twice as many exam blocks. `video` sharpens the YouTube search per topic.
  const EXAM_COURSES = [
    { match: 'Programming Fundamentals', short: 'PF', weight: 2, video: 'javascript', links: [{ label: 'JS Oefenlab', url: 'https://claude.ai/artifact/8HDWHiZNYtYjnhNy9Tzp87' }, { label: 'javascript.info: uitleg per onderwerp', url: 'https://javascript.info/' }] },
    { match: 'Computer Architectures', short: 'CaOS', weight: 2, video: 'linux', links: [{ label: 'OverTheWire Bandit (Linux oefenen)', url: 'https://overthewire.org/wargames/bandit/' }] },
    { match: 'Problem Solving', short: 'Problem Solving', video: 'wiskunde', links: [{ label: 'Khan Academy: algebra', url: 'https://www.khanacademy.org/math/algebra2' }] },
    { match: 'Web Development', short: 'Web Dev', video: 'html css', links: [{ label: 'MDN: web development leren', url: 'https://developer.mozilla.org/en-US/docs/Learn_web_development' }] },
    { match: 'Databases', short: 'Databases', video: 'sql', links: [{ label: 'SQLBolt', url: 'https://sqlbolt.com/' }] },
    { match: 'Business Solutions', short: 'Business Solutions', video: '' },
  ];
  const FLEX_BLOCK = /inhalen|leho-opdrachten vooruitwerken/i; // general study blocks that become exam study
  const EXAM_HOWTO = "1. Open hieronder de leerstof van deze sessie (slides of pdf op Leho) en lees ze van begin tot einde.\n2. Snap je iets niet? Kijk de video's erbij.\n3. Maak de oefeningen zonder naar het antwoord te kijken. Vink het blok pas af als je het onderwerp zelf kan uitleggen.";
  const mentions = (text, short) => new RegExp('\\b' + short + '\\b').test(text);
  const DAY_SHORT = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];

  // ---- parsing ----
  const unescape = (s) => s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
  function icsTime(v) {
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v || '');
    if (!m) return null; // all-day events are not used
    const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
    return m[7] ? Date.UTC(y, mo - 1, d, h, mi, s) : new Date(y, mo - 1, d, h, mi, s).getTime();
  }
  function parseIcs(text) {
    const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
    const events = [];
    let ev = null;
    for (const line of lines) {
      if (line === 'BEGIN:VEVENT') ev = {};
      else if (line === 'END:VEVENT') {
        if (ev && ev.start && ev.end) events.push(ev);
        ev = null;
      } else if (ev) {
        const i = line.indexOf(':');
        const key = line.slice(0, i).split(';')[0];
        const val = line.slice(i + 1);
        if (key === 'DTSTART') ev.start = icsTime(val);
        else if (key === 'DTEND') ev.end = icsTime(val);
        else if (key === 'SUMMARY') ev.title = unescape(val).trim();
        else if (key === 'LOCATION') ev.location = unescape(val).trim();
      }
    }
    return events;
  }
  const toLessons = (events) => events.map((e) => {
    const exam = /evaluatie|examen/i.test(e.title || ''); // TimeEdit: "<vak>, Niet-periode gebonden evaluatie"
    const title = (e.title || '').replace(/,\s*(werkcollege|activerend hoorcollege|hoorcollege|niet-periode gebonden evaluatie)\s*$/i, '');
    return {
      start: e.start,
      end: e.end,
      title: exam ? 'Examen: ' + title : title,
      optional: /werkcollege/i.test(e.title || ''),
      exam,
      location: (e.location || '').split('. ')[0],
    };
  });
  /** Leho has no "optional" flag: lectors put it in the title, e.g. "Hangman (OPTIONEEL)". */
  const isOptional = (title) => /optione|facultatie|niet verplicht/i.test(String(title));
  const toShifts = (events) => events.map((e) => ({
    start: e.start,
    end: e.end,
    title: 'Werk: ' + (e.title || '').replace(/\s*\([^)]*\)\s*$/, ''),
  }));
  function openDeadlines(items) {
    return items
      .filter((i) => i.plannable_type !== 'announcement' && i.plannable_type !== 'calendar_event')
      .map((i) => ({
        id: i.plannable_id,
        courseId: i.course_id,
        title: (i.plannable?.title ?? '').trim(),
        course: (i.context_name ?? '').split(' - ').at(-1),
        due: i.plannable?.due_at ?? i.plannable?.todo_date ?? null,
        url: i.html_url,
        done: !!(i.submissions?.submitted || i.planner_override?.marked_complete),
        optional: isOptional(i.plannable?.title ?? ''),
        overrideId: i.planner_override?.id ?? null,
      }))
      .filter((d) => d.due)
      .sort((a, b) => Date.parse(a.due) - Date.parse(b.due));
  }

  // ---- GitLab matching ----
  const STARTER_WINDOW_MS = 60 * 60 * 1000; // setup commits made right after the repo was created are starter code
  const slug = (s) => String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const repoFor = (course, repos) => repos.find((r) => r.path.includes('/' + slug(course) + '/students/'));
  const folderFor = (title, folders) => folders.find((f) => f.split('/').at(-1).replace(/^\d+[a-z]?-/, '') === slug(title));
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  /** exercises/topic03_iteration/assignment15_euclid.js -> "3.15 Euclid" */
  function exerciseLabel(path) {
    const topic = Number((/topic(\d+)/.exec(path) || [])[1]);
    const file = path.split('/').at(-1).replace(/\.js$/, '');
    const nr = /^assignment(\d+)_/.exec(file);
    const name = cap(file.replace(/^assignment\d+_/, '').replace(/[_-]+/g, ' '));
    return (nr ? topic + '.' + Number(nr[1]) : String(topic)) + ' ' + name;
  }
  const isStudentWork = (commit, project, starterAuthor) =>
    commit.author_email !== starterAuthor && Date.parse(commit.created_at) > Date.parse(project.created_at) + STARTER_WINDOW_MS;

  // ---- dates ----
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const iso = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const mins = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + (m || 0); };
  const mondayOf = (d) => addDays(d, -((d.getDay() + 6) % 7));
  /** Sunday 23:59 of the week that contains ms. */
  const endOfWeek = (ms) => new Date(addDays(mondayOf(new Date(ms)), 7).getTime() - 60000);
  function dayAndMin(ms, weekStart) {
    const d = new Date(ms);
    const day = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - weekStart) / 864e5);
    return { day, min: d.getHours() * 60 + d.getMinutes() };
  }

  /** Days in [now, now + days) with a mandatory lesson: when the first starts and the last ends (werkcolleges are optional, so no trip for those alone). */
  function schoolDays(lessons, now, days) {
    const from = new Date(now); from.setHours(0, 0, 0, 0);
    const until = addDays(from, days).getTime();
    const byDate = {};
    for (const l of lessons) {
      if (l.optional || l.start < from.getTime() || l.start >= until) continue;
      const key = iso(new Date(l.start));
      const d = byDate[key] || { date: key, first: l.start, last: l.end };
      byDate[key] = { date: key, first: Math.min(d.first, l.start), last: Math.max(d.last, l.end) };
    }
    return Object.values(byDate).sort((a, b) => a.first - b.first);
  }

  // ---- planning ----
  /**
   * topics: { [exam course]: [{ id, title, items: [{ name, url, lessonId? }] }] } = Leho modules in course order.
   * studied: { [topic id]: Monday ISO of the week its block was ticked }.
   */
  function planWeek({ weekStart, now, lessons, shifts, deadlines, templates, absences, exercises = [], travel = [], topics = {}, studied = {} }) {
    const items = [];
    const dropped = [];
    const busy = [[], [], [], [], [], [], []];
    const placed = [[], [], [], [], [], [], []];
    const absence = [0, 1, 2, 3, 4, 5, 6].map((i) => absences[iso(addDays(weekStart, i))] || null);
    const at = dayAndMin(now, weekStart);
    const nowAt = at.day > 6 ? { day: -1, min: 0 } : at; // a week fully in the past is laid out as if it hadn't started

    const inWeek = (ev) => { const s = dayAndMin(ev.start, weekStart); return s.day >= 0 && s.day < 7 ? s : null; };
    const endMin = (ev, s) => Math.min(24 * 60, s.min + Math.round((ev.end - ev.start) / 60000));

    for (const l of lessons) {
      const s = inWeek(l);
      if (!s) continue;
      const cancelled = !!absence[s.day];
      items.push({ id: 'les-' + l.start, kind: 'les', day: s.day, start: s.min, end: endMin(l, s), title: l.title, note: l.location, optional: l.optional, cancelled });
      if (!cancelled && !l.optional) busy[s.day].push([s.min, endMin(l, s)]);
    }
    for (const w of shifts) {
      const s = inWeek(w);
      if (!s) continue;
      items.push({ id: 'werk-' + w.start, kind: 'werk', day: s.day, start: s.min, end: endMin(w, s), title: w.title });
      busy[s.day].push([s.min - SHIFT_BUFFER, 24 * 60]); // no study after work that day
    }
    for (const t of travel) {
      const s = inWeek(t);
      if (!s || absence[s.day]) continue;
      items.push({ id: 'reis-' + t.start, kind: 'reis', day: s.day, start: s.min, end: endMin(t, s), title: t.title, note: t.note || '' });
      busy[s.day].push([s.min, endMin(t, s)]);
    }
    absence.forEach((a, d) => { if (a === 'ziek') busy[d].push([0, 24 * 60]); });

    const overlaps = (d, s, e) => busy[d].concat(placed[d]).some(([a, b]) => s < b && e > a);
    const inFuture = (d, s) => d > nowAt.day || (d === nowAt.day && s >= nowAt.min);
    function findSlot(d, dur, latestEnd = DAY_END) {
      if (d < 0 || d > 6) return null;
      for (let s = DAY_START; s + dur <= latestEnd; s += STEP) if (inFuture(d, s) && !overlaps(d, s, s + dur)) return s;
      return null;
    }
    const place = (item) => { placed[item.day].push([item.start, item.end]); items.push(item); };

    const vrijDays = absence.map((a, d) => (a === 'vrij' && d >= nowAt.day ? d : -1)).filter((d) => d >= 0);
    const vrijUsed = {};
    const lastDay = iso(addDays(weekStart, 6));
    const sorted = templates.filter((t) => !t.startsOn || t.startsOn <= lastDay).sort((a, b) => (KIND_ORDER[a.kind] ?? 2) - (KIND_ORDER[b.kind] ?? 2) || a.day - b.day || mins(a.start) - mins(b.start));
    for (const t of sorted) {
      const s0 = mins(t.start);
      const dur = mins(t.end) - s0;
      const item = { id: t.id, kind: t.kind, title: t.title, note: t.note || '', howto: t.howto || '', links: t.links || [], pf: !!t.pf, from: { day: t.day, start: s0 } };
      // 1) pull forward onto a day off school, 2) the usual slot, 3) the rest of the week, later days first.
      const pull = vrijDays.find((v) => v < t.day && (vrijUsed[v] || 0) + dur <= VRIJ_CAP && findSlot(v, dur) !== null);
      if (pull !== undefined) {
        const s = findSlot(pull, dur);
        vrijUsed[pull] = (vrijUsed[pull] || 0) + dur;
        place({ ...item, day: pull, start: s, end: s + dur, moved: 'naar voren' });
        continue;
      }
      if (!overlaps(t.day, s0, s0 + dur)) { place({ ...item, day: t.day, start: s0, end: s0 + dur, moved: null }); continue; }
      const order = [t.day, t.day + 1, t.day + 2, t.day + 3, t.day + 4, t.day + 5, t.day + 6, t.day - 1, t.day - 2, t.day - 3, t.day - 4, t.day - 5, t.day - 6];
      const day = order.find((d) => findSlot(d, dur) !== null);
      if (day === undefined) { dropped.push(t); continue; }
      const s = findSlot(day, dur);
      place({ ...item, day, start: s, end: s + dur, moved: 'verplaatst' });
    }

    // Exams found in TimeEdit; hard courses (weight 2) get more turns, the soonest exam wins a tie.
    const exams = lessons.filter((l) => l.exam).map((l) => {
      const course = l.title.replace(/^Examen: /, '');
      const c = EXAM_COURSES.find((x) => course.includes(x.match)) || { short: course, video: '' };
      const d = new Date(l.start);
      return { start: l.start, course, short: c.short, weight: c.weight || 1, video: c.video, links: c.links || [], when: DAY_SHORT[d.getDay()] + ' ' + d.getDate() + '/' + (d.getMonth() + 1) };
    });
    const upcoming = (ms) => exams.filter((x) => x.start > ms && x.start - ms <= EXAM_PREP_MS).sort((a, b) => a.start - b.start);
    const given = {};
    const score = (x) => x.weight / (1 + (given[x.short] || 0));
    const pick = (up) => {
      const best = up.reduce((b, x) => (score(x) > score(b) ? x : b));
      given[best.short] = (given[best.short] || 0) + 1;
      return best;
    };
    const examItem = (x) => ({ title: `Examen ${x.short} voorbereiden`, note: `Examen ${x.when}`, howto: EXAM_HOWTO, links: x.links, exam: x });

    // Tasks without a Leho deadline: one block per course for all of them, instead of a pile of small blocks.
    // Optional tasks get no work block: school and exams come first.
    const undated = deadlines.filter((dl) => dl.noDueDate && !dl.done && !dl.optional);
    const byCourse = undated.reduce((g, dl) => ({ ...g, [dl.course]: [...(g[dl.course] || []), dl] }), {});
    const grouped = Object.values(byCourse).map((list) => ({
      id: 'open-' + list[0].courseId,
      title: `${list[0].course}: ${list.length} ${list.length === 1 ? 'taak' : 'taken'} zonder deadline`,
      course: list[0].course,
      due: list[0].due,
      url: list[0].url && list[0].url.replace(/\/assignments\/.*$/, '/assignments'),
      minutes: Math.min(UNDATED_CAP, list.reduce((sum, dl) => sum + (dl.minutes || DEADLINE_WORK), 0)),
      tasks: list.map((dl) => ({ name: cleanTitle(dl.title), url: dl.url })),
      grouped: true,
    }));
    for (const dl of [...deadlines.filter((d) => !d.noDueDate), ...grouped]) {
      const dueMs = Date.parse(dl.due);
      const due = dayAndMin(dueMs, weekStart);
      if (dl.done || dl.optional || due.day < 0 || due.day > 6 || dueMs <= now) continue;
      for (let d = Math.max(0, nowAt.day); d <= due.day; d++) {
        const work = dl.minutes || DEADLINE_WORK;
        const s = findSlot(d, work, d === due.day ? Math.min(DAY_END, due.min) : DAY_END);
        if (s === null) continue;
        place({ id: 'dl-' + dl.id, kind: 'deadline', day: d, start: s, end: s + work, title: dl.grouped ? dl.title : cleanTitle(dl.title), note: dl.course, url: dl.url, tasks: dl.tasks, moved: null });
        break;
      }
    }

    // After homework: extra exam blocks, two on a weekday without school, one on a school day.
    for (let d = Math.max(0, nowAt.day); d < 5; d++) {
      const up = upcoming(addDays(weekStart, d).getTime());
      if (!up.length || absence[d] === 'ziek') continue;
      const school = items.some((i) => i.kind === 'les' && i.day === d && !i.optional && !i.cancelled);
      const [count, dur] = school ? [1, SCHOOL_EXAM_BLOCK] : [2, EXAM_BLOCK];
      for (let n = 0; n < count; n++) {
        const s = findSlot(d, dur);
        const left = s === null ? [] : upcoming(addDays(weekStart, d).getTime() + s * 60000); // not for an exam that is already over
        if (!left.length) break;
        place({ id: `examen-${iso(addDays(weekStart, d))}-${n}`, kind: 'studie', day: d, start: s, end: s + dur, ...examItem(pick(left)), examPrep: true, moved: null });
      }
    }

    items.sort((a, b) => a.day - b.day || a.start - b.start);
    // Hand out unfinished Programming Fundamentals exercises over this week's PF blocks, in course order.
    // Before an exam: a block of that course says so, a general block becomes exam study,
    // and a course without any exam keeps only half its time.
    const focus = (i) => {
      const up = i.kind === 'studie' && !i.exam ? upcoming(addDays(weekStart, i.day).getTime() + i.start * 60000) : [];
      if (!up.length) return [i];
      const text = i.title + ' ' + i.note;
      const own = up.find((x) => mentions(text, x.short));
      if (own) return [{ ...i, note: `Examen ${own.when}: focus op de examenleerstof` }];
      const examToday = iso(new Date(up[0].start)) === iso(addDays(weekStart, i.day)); // block before an exam that same day
      if (examToday) return [{ ...i, ...examItem(up[0]), note: `Laatste herhaling, examen ${up[0].when}` }];
      if (FLEX_BLOCK.test(i.title)) return [{ ...i, ...examItem(pick(up)) }];
      const noExam = EXAM_COURSES.some((c) => mentions(text, c.short)) && !exams.some((x) => mentions(text, x.short));
      if (!noExam || i.end - i.start < 2 * STEP) return [i];
      const half = Math.round((i.end - i.start) / 2 / STEP) * STEP;
      return [{ ...i, end: i.start + half }, { ...i, ...examItem(pick(up)), id: i.id + '-examen', start: i.start + half, moved: null }];
    };
    // Exam blocks walk through the course from the first Leho module on: one topic per hour, ticked topics drop out next week.
    const weekIso = iso(weekStart);
    const taken = {};
    const withTopics = (i) => {
      if (!i.exam) return i;
      const { course, short, video } = i.exam;
      const all = topics[course] || [];
      const open = all.filter((t) => !studied[t.id] || studied[t.id] >= weekIso);
      const n = Math.max(1, Math.round((i.end - i.start) / 60));
      const from = taken[course] || 0;
      const mine = open.slice(from, from + n);
      taken[course] = from + n;
      if (!mine.length) return all.length ? { ...i, title: `${short}: alles herhalen + oefenexamen` } : i;
      const videos = mine.map((t) => ({ label: "Video's: " + t.title, url: 'https://www.youtube.com/results?search_query=' + encodeURIComponent((t.title + ' ' + video).trim()) }));
      return { ...i, title: `${short}: ${mine.map((t) => t.title).join(' + ')}`, tasks: mine.flatMap((t) => t.items), topicIds: mine.map((t) => t.id), links: [...videos, ...i.links] };
    };
    let next = 0;
    const withTasks = items.flatMap(focus).map(withTopics).map((i) => {
      if (!i.pf) return i;
      const tasks = exercises.slice(next, next + PF_PER_BLOCK);
      next += PF_PER_BLOCK;
      return { ...i, tasks };
    });
    return { items: withTasks, dropped };
  }

  const api = { parseIcs, toLessons, toShifts, openDeadlines, isOptional, planWeek, repoFor, folderFor, isStudentWork, exerciseLabel, mondayOf, addDays, iso, mins, endOfWeek, schoolDays };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Plan = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
