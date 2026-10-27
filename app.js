import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm';
import { hhmm, dayItems, openDeadlines, nowNext, untilText, dueLabel, appleForDay, RESULTS, BLOCKERS, interviewBlocks, checkinSummary } from './logic.js';
import { replan } from './replan.js';

// The publishable key is meant to be public: Row Level Security limits every row to its owner.
const db = createClient('https://uizhyrexbiagykzxqmct.supabase.co', 'sb_publishable_a0EhD2sC_LkoRgoR2F4i6A_XDtg455V');

const DAYS = ['Maandag', 'Dinsdag', 'Woensdag', 'Donderdag', 'Vrijdag', 'Zaterdag', 'Zondag'];
const TITLES = { vandaag: 'Vandaag', week: 'Deze week', deadlines: 'Deadlines', notities: 'Notities', avond: 'Avondcheck', films: 'Films voor de TV' };
const KINDS = { les: 'Les', opt: 'Werkcollege', reis: 'Reis', studie: 'Studie', extra: 'Extra', deadline: 'Deadline-werk', werk: 'Werk', apple: 'Agenda' };
// Same rule as the database check: only Apple's published-calendar links.
const ICLOUD_FEED = /^(webcal|https):\/\/p\d+-caldav\.icloud\.com\/published\/\d+\/[A-Za-z0-9_=-]+$/;
const STALE_MS = 2 * 3600e3; // laptop data older than this gets an orange dot
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const kindOf = (i) => (i.optional ? 'opt' : i.kind);
const color = (node, i) => { node.style.setProperty('--c', `var(--${kindOf(i)})`); return node; };
const nowMin = (d) => d.getHours() * 60 + d.getMinutes();

let planner = null;
let apple = null; // { events, error } refreshed every 5 min by the Edge Function
let mail = null;  // { generatedAt, total, items: [{from, subject, summary, action, urgent}] } from the morning cloud routine
let tip = null;   // { generatedAt, forDate: 'YYYY-MM-DD', text, focus: [] } from the evening coach routine
let brief = null; // { generatedAt, forDate: 'YYYY-MM-DD', headline, lines: [], focus: [] } from the morning boss routine
let notes = [];
let feeds = [];
let absences = {}; // {'YYYY-MM-DD': 'vrij' | 'ziek'}, shared with the laptop planner through Supabase
let lastError = '';

// ---- login (sign-ups are closed in Supabase: only the owner's account exists) ----
$('login').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('loginMsg').textContent = 'Even geduld…';
  const { error } = await db.auth.signInWithPassword({ email: $('email').value.trim(), password: $('password').value });
  $('loginMsg').textContent = error ? 'Inloggen mislukt: controleer je e-mail en wachtwoord.' : '';
});
$('logout').addEventListener('click', () => db.auth.signOut());

db.auth.onAuthStateChange((_event, session) => {
  $('login').hidden = !!session;
  $('app').hidden = !session;
  if (session) setTimeout(start); // never await Supabase calls inside this callback
});

// ---- data ----
let started = false;
async function start() {
  if (started) return;
  started = true;
  await Promise.all([loadPlanner(), loadNotes(), loadFeeds(), loadAbsences(), loadFilms()]);
  // Changes made on another device arrive here within a second or two.
  db.channel('sync')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'snapshots' }, loadPlanner)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'notes' }, loadNotes)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'absences' }, loadAbsences)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'films' }, loadFilms)
    .subscribe();
  setInterval(render, 30_000); // keeps the "now" marker and countdown moving
  document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
}

async function loadPlanner() {
  const { data, error } = await db.from('snapshots').select('source, data').in('source', ['weekplanner', 'apple', 'mail', 'tip', 'brief']);
  if (error) return showError(error);
  const pick = (source) => data.find((r) => r.source === source)?.data ?? null;
  planner = pick('weekplanner');
  apple = pick('apple');
  mail = pick('mail');
  tip = pick('tip');
  brief = pick('brief');
  render();
}

async function loadAbsences() {
  const { data, error } = await db.from('absences').select('date, kind');
  if (error) return showError(error);
  absences = Object.fromEntries(data.map((a) => [a.date, a.kind]));
  render();
}

// "Geen school" / "Ziek" for one day; the plan is recomputed right here on the phone, the laptop follows at its next sync.
async function setAbsence(date, kind) {
  const query = kind ? db.from('absences').upsert({ date, kind }, { onConflict: 'user_id,date' }) : db.from('absences').delete().eq('date', date);
  const { error } = await query;
  if (error) return showError(error);
  absences = { ...Object.fromEntries(Object.entries(absences).filter(([d]) => d !== date)), ...(kind ? { [date]: kind } : {}) };
  render();
}

const ABSENCE = [['', 'Ja'], ['vrij', 'Geen school'], ['ziek', 'Ziek']];
// `where` keeps the radio groups apart: today's picker and the same day in Week must not share a name.
function absencePicker(date, label, where) {
  const fs = el('fieldset', 'q attend');
  fs.append(el('legend', null, label));
  const row = el('div', 'seg');
  for (const [value, text] of ABSENCE) {
    const opt = el('label');
    const input = el('input');
    input.type = 'radio'; input.name = `att-${where}-${date}`; input.value = value;
    input.checked = (absences[date] || '') === value;
    input.addEventListener('change', () => setAbsence(date, value));
    opt.append(input, el('span', null, text));
    row.append(opt);
  }
  fs.append(row);
  return fs;
}

async function loadFeeds() {
  const { data, error } = await db.from('calendar_feeds').select('id, url').order('created_at');
  if (error) return showError(error);
  feeds = data;
  render();
}

// Ask the Edge Function to read the feeds now instead of at its next 5-minute run.
async function refreshCalendarNow() {
  const { data } = await db.auth.getSession();
  await fetch(NOTIFY_URL + '?action=calendar', { method: 'POST', headers: { Authorization: 'Bearer ' + data.session?.access_token } }).catch(() => {});
  await loadPlanner();
}

$('feedForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = $('feedInput').value.trim();
  if (!ICLOUD_FEED.test(url)) {
    $('calState').className = 'hint error';
    $('calState').textContent = 'Dat is geen link van een publieke iCloud-agenda. Hij begint met webcal://p…-caldav.icloud.com/published/';
    return;
  }
  $('calState').className = 'hint';
  $('calState').textContent = 'Agenda ophalen…';
  const { error } = await db.from('calendar_feeds').insert({ url });
  if (error && error.code !== '23505') return showError(error); // 23505: this calendar was already linked
  $('feedInput').value = '';
  await loadFeeds();
  await refreshCalendarNow();
});

async function loadNotes() {
  const { data, error } = await db.from('notes').select('*').order('created_at', { ascending: false });
  if (error) return showError(error);
  notes = data;
  renderNotes(); // not on the 30 s timer: re-rendering would restart a playing voice memo
}

function showError(error) {
  lastError = 'Verbinding mislukt: ' + error.message;
  render();
}

async function mutate(query) {
  const { error } = await query;
  if (error) return showError(error);
  lastError = '';
  loadNotes();
}

const say = (node, text, ok = true) => { node.textContent = text; node.className = 'saved' + (ok ? '' : ' error'); };
const MAX_FILE_BYTES = 25 * 1024 * 1024; // same limit as the storage bucket

// ---- notes with an optional file (photo, PDF, voice memo) in the private 'notes' bucket ----
$('noteFile').addEventListener('change', () => {
  const f = $('noteFile').files[0];
  say($('noteSaved'), f ? `Bijlage: ${f.name} · tik + om op te slaan` : '');
});
$('noteAttach').addEventListener('click', () => $('noteFile').click());

// Text and file are only cleared once the database confirmed them, so nothing is lost on a bad connection.
$('noteForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('noteInput').value.trim();
  const file = $('noteFile').files[0];
  if (!text && !file) return;
  if (file && file.size > MAX_FILE_BYTES) return say($('noteSaved'), 'Dat bestand is groter dan 25 MB.', false);
  const row = { kind: 'note', body: text || file.name };
  if (file) {
    say($('noteSaved'), 'Uploaden…');
    const { data: { session } } = await db.auth.getSession();
    const path = `${session.user.id}/${crypto.randomUUID()}-${file.name.replace(/[^\w.-]+/g, '_').slice(-80)}`;
    const { error } = await db.storage.from('notes').upload(path, file, { contentType: file.type || undefined });
    if (error) return say($('noteSaved'), 'Uploaden mislukt: ' + error.message, false);
    Object.assign(row, { file_path: path, file_name: file.name, file_type: file.type });
  }
  const { error } = await db.from('notes').insert(row);
  if (error) return say($('noteSaved'), 'Niet opgeslagen: ' + error.message, false);
  $('noteInput').value = '';
  $('noteFile').value = '';
  say($('noteSaved'), 'Opgeslagen ✓');
  loadNotes();
});

// Signed links to private files, reused for 50 minutes (they are valid for 60).
const fileUrls = new Map();
async function fileUrl(path) {
  const hit = fileUrls.get(path);
  if (hit && Date.now() - hit.at < 50 * 60e3) return hit.url;
  const { data } = await db.storage.from('notes').createSignedUrl(path, 3600);
  if (data?.signedUrl) fileUrls.set(path, { url: data.signedUrl, at: Date.now() });
  return data?.signedUrl;
}

function filePreview(n) {
  const box = el('div', 'file');
  fileUrl(n.file_path).then((url) => {
    if (!url) return box.append(el('span', 'hint', 'Bestand niet gevonden'));
    if (n.file_type?.startsWith('image/')) {
      const a = el('a');
      a.href = url; a.target = '_blank'; a.rel = 'noopener';
      const img = el('img');
      img.src = url; img.alt = n.file_name; img.loading = 'lazy';
      a.append(img);
      box.append(a);
    } else if (n.file_type?.startsWith('audio/')) {
      const audio = el('audio');
      audio.controls = true; audio.preload = 'none'; audio.src = url;
      audio.setAttribute('aria-label', 'Spraakmemo ' + n.file_name);
      box.append(audio);
    } else {
      const a = el('a', 'doc', 'PDF openen · ' + n.file_name);
      a.href = url; a.target = '_blank'; a.rel = 'noopener';
      box.append(a);
    }
  });
  return box;
}

// ---- evening interview: one tap per question, built from today's blocks ----
const ENERGY = ['Leeg', 'Laag', 'Oké', 'Goed', 'Top'];
const MOOD = ['Slecht', 'Matig', 'Oké', 'Goed', 'Top'];
let interviewKey = '';

function segment(name, legend, options) { // options: [[value, label]]
  const fs = el('fieldset', 'q');
  fs.append(el('legend', null, legend));
  const row = el('div', 'seg');
  for (const [value, label] of options) {
    const opt = el('label');
    const input = el('input');
    input.type = 'radio'; input.name = name; input.value = value;
    opt.append(input, el('span', null, label));
    row.append(opt);
  }
  fs.append(row);
  return fs;
}

// Rebuilt only when today's blocks change, so the 30 s refresh never wipes answers you are giving.
function renderInterview(todayItems) {
  const blocks = interviewBlocks(todayItems);
  const key = blocks.map((b) => b.id).join('|');
  if (key === interviewKey) return;
  interviewKey = key;
  $('qBlocks').replaceChildren(...(blocks.length ? blocks.map((b, i) => {
    const fs = segment('b' + i, `${hhmm(b.start)} ${b.title}`, Object.entries(RESULTS));
    fs.dataset.title = b.title;
    fs.dataset.kind = b.kind;
    return fs;
  }) : [el('p', 'hint', 'Geen blokken gepland vandaag, dus enkel de vragen hieronder.')]));
}

function buildBlockers() {
  $('qBlockers').replaceChildren(...BLOCKERS.map((b) => {
    const opt = el('label');
    const input = el('input');
    input.type = 'checkbox'; input.value = b;
    opt.append(input, el('span', null, b));
    return opt;
  }));
}
buildBlockers();
$('qEnergy').replaceWith(segment('energy', 'Hoeveel energie had je?', ENERGY.map((l, i) => [i + 1, l])));
$('qMood').replaceWith(segment('mood', 'Hoe voel je je?', MOOD.map((l, i) => [i + 1, l])));

$('checkinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = $('checkinForm');
  const picked = (name) => form.querySelector(`input[name="${name}"]:checked`)?.value;
  const answers = {
    blocks: [...$('qBlocks').querySelectorAll('fieldset')].map((fs, i) => ({ title: fs.dataset.title, kind: fs.dataset.kind, result: picked('b' + i) ?? '' })),
    energy: Number(picked('energy')) || null,
    mood: Number(picked('mood')) || null,
    blockers: [...$('qBlockers').querySelectorAll('input:checked')].map((c) => c.value),
    note: $('checkinInput').value,
  };
  const body = checkinSummary(answers);
  if (!body) return say($('checkinSaved'), 'Beantwoord minstens één vraag.', false);
  say($('checkinSaved'), 'Opslaan…');
  const { error } = await db.from('notes').insert({ kind: 'checkin', body, data: answers });
  if (error) return say($('checkinSaved'), 'Niet opgeslagen: ' + error.message + '. Je antwoorden staan er nog; probeer opnieuw.', false);
  form.reset();
  say($('checkinSaved'), 'Opgeslagen ✓ Je tip voor morgen volgt binnen het uur.');
  loadNotes();
});

// ---- render ----
function focusCard(i, label, when, cls) {
  const card = color(el('div', 'card ' + cls), i);
  card.append(el('div', 'tag', label), el('p', 'what', i.title), el('p', 'when', when));
  return card;
}

function blockEl(i) {
  const li = color(el('li', i.status), i);
  const time = el('time', null, hhmm(i.start));
  time.append(el('small', null, hhmm(i.end)));
  const body = el('div', 'body');
  const meta = el('div', 'meta');
  meta.append(el('b', null, KINDS[kindOf(i)] || i.kind));
  if (i.note) meta.append(' · ' + i.note);
  body.append(el('div', 'title', i.title), meta);
  li.append(time, body);
  return li;
}

function deadlineEl(d) {
  const li = el('li', d.urgency);
  const row = el(d.url?.startsWith('https://') ? 'a' : 'div', 'row');
  if (row.tagName === 'A') { row.href = d.url; row.target = '_blank'; row.rel = 'noopener'; }
  row.append(el('span', 'title', d.title), el('span', 'due', dueLabel(d.due)), el('span', 'course', d.course || ''));
  li.append(row);
  return li;
}

const list = (target, items, make, emptyText) => target.replaceChildren(...(items.length ? items.map(make) : [el('li', 'empty', emptyText)]));

function noteEl(n) {
  const li = el('li', n.done ? 'done' : '');
  const check = el('label', 'check');
  const box = el('input');
  box.type = 'checkbox';
  box.checked = n.done;
  box.setAttribute('aria-label', n.done ? 'Markeer als niet af' : 'Markeer als af');
  box.addEventListener('change', () => mutate(db.from('notes').update({ done: box.checked }).eq('id', n.id)));
  check.append(box);
  const del = el('button', 'del');
  del.setAttribute('aria-label', 'Notitie verwijderen');
  del.innerHTML = '<svg aria-hidden="true"><use href="#i-x"/></svg>';
  del.addEventListener('click', async () => {
    if (n.file_path) await db.storage.from('notes').remove([n.file_path]);
    mutate(db.from('notes').delete().eq('id', n.id));
  });
  const content = el('div', 'text');
  content.append(el('span', null, n.body));
  if (n.file_path) content.append(filePreview(n));
  li.append(check, content, del);
  return li;
}

function checkinEl(n) {
  const li = el('li', 'entry');
  li.append(el('span', 'text', n.body), el('span', 'date', new Date(n.created_at).toLocaleDateString('nl-BE', { weekday: 'short', day: 'numeric', month: 'numeric' })));
  return li;
}

function feedEl(f, i) {
  const li = el('li');
  const del = el('button', 'del');
  del.setAttribute('aria-label', `Agenda ${i + 1} ontkoppelen`);
  del.innerHTML = '<svg aria-hidden="true"><use href="#i-x"/></svg>';
  del.addEventListener('click', async () => {
    const { error } = await db.from('calendar_feeds').delete().eq('id', f.id);
    if (error) return showError(error);
    await loadFeeds();
    await refreshCalendarNow();
  });
  li.append(el('span', null, `Agenda ${i + 1} · …${f.url.slice(-10)}`), del);
  return li;
}

function renderCalendar() {
  $('feeds').replaceChildren(...feeds.map(feedEl));
  if (!feeds.length) return;
  const s = $('calState');
  s.className = 'hint' + (apple?.error ? ' error' : '');
  s.textContent = apple?.error ? 'Ophalen mislukt: ' + apple.error
    : apple ? `Gekoppeld · ${apple.events.length} afspraken in de komende 2 weken.` : 'Gekoppeld. De afspraken verschijnen binnen enkele minuten.';
}

function tipEl(label) {
  const box = el('div', 'tip');
  const ol = el('ol');
  ol.append(...(tip.focus ?? []).map((f) => el('li', null, f)));
  box.append(el('div', 'tag', label), el('p', null, tip.text), ol);
  return box;
}

// Written in the evening for the next day: shown as "Tip voor morgen" until midnight, then as today's focus.
// Morning boss: one honest briefing for today, shown until midnight.
function renderBrief(now) {
  const show = brief?.headline && brief.forDate === isoToday(now);
  $('briefCard').replaceChildren(...(show ? [briefEl()] : []));
}
function briefEl() {
  const box = el('div', 'brief');
  box.append(el('div', 'tag', 'Ochtendbriefing'));
  if (brief.headline) box.append(el('p', 'brief-head', brief.headline));
  if (brief.lines?.length) {
    const ul = el('ul', 'brief-lines');
    ul.append(...brief.lines.map((l) => el('li', null, l)));
    box.append(ul);
  }
  if (brief.focus?.length) {
    const ol = el('ol');
    ol.append(...brief.focus.map((f) => el('li', null, f)));
    box.append(el('div', 'tag', 'Vandaag'), ol);
  }
  return box;
}

function renderTip(now) {
  const today = isoToday(now);
  $('tomorrowTip').replaceChildren(...(tip?.text && tip.forDate > today ? [tipEl('Tip voor morgen')] : []));
  $('todayTip').replaceChildren(...(tip?.text && tip.forDate === today ? [tipEl('Focus van vandaag')] : []));
}
const isoToday = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function mailEl(m) {
  const li = el('li');
  const from = el('div', 'from', m.from || '');
  if (m.urgent) from.append(el('span', 'badge', 'dringend'));
  li.append(from, el('div', 'subject', m.subject || '(geen onderwerp)'));
  if (m.summary) li.append(el('div', 'summary', m.summary));
  if (m.action) li.append(el('div', 'action', '→ ' + m.action));
  return li;
}

function renderMail() {
  $('mailBlock').hidden = !mail?.generatedAt;
  if (!mail?.generatedAt) return;
  const at = new Date(mail.generatedAt);
  const sameDay = at.toDateString() === new Date().toDateString();
  $('mailMeta').textContent = `Samenvatting van ${sameDay ? '' : at.toLocaleDateString('nl-BE', { weekday: 'long' }) + ' '}${hhmm(nowMin(at))} · ${mail.total ?? 0} mails bekeken`;
  list($('mail'), mail.items ?? [], mailEl, 'Niets belangrijks in je mail.');
}

function renderStatus(now) {
  const s = $('synced');
  const at = planner?.syncedAt;
  const failed = Object.keys(planner?.errors ?? {});
  const syncError = failed.length ? `Sync faalt voor ${failed.join(', ')}: die info kan oud zijn` : '';
  s.className = 'status' + (lastError || syncError ? ' error' : !at || now - at > STALE_MS ? ' stale' : '');
  s.textContent = lastError || syncError || (at ? 'Laptop bijgewerkt ' + new Date(at).toLocaleString('nl-BE', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : 'Nog geen planner van je laptop ontvangen');
}

function render() {
  const now = new Date();
  $('dateLine').textContent = now.toLocaleDateString('nl-BE', { weekday: 'long', day: 'numeric', month: 'long' });
  renderStatus(now.getTime());
  renderBrief(now);

  const plan = { weeks: replan(planner, absences, now) };
  const isoNow = isoToday(now);
  $('attendToday').replaceChildren(absencePicker(isoNow, 'Vandaag naar school?', 'today'));
  $('absentNote').textContent = absences[isoNow] === 'ziek' ? 'Ziek: alles voor vandaag is geschrapt. Rust goed uit.'
    : absences[isoNow] === 'vrij' ? 'Geen school: lessen en treinen zijn geschrapt, studie van later in de week staat nu vandaag.' : '';
  const todayApple = appleForDay(apple?.events, now);
  const today = dayItems(plan, now, now, todayApple.timed);
  $('allDay').replaceChildren(...todayApple.allDay.map((e) => el('li', null, e.title)));
  const { now: current, next } = nowNext(today);
  $('focus').replaceChildren(
    ...(current ? [focusCard(current, 'Nu', `tot ${hhmm(current.end)}`, 'now')] : []),
    ...(next ? [focusCard(next, current ? 'Straks' : 'Hierna', `${untilText(next.start, nowMin(now))} · ${hhmm(next.start)}`, 'next')] : []),
  );
  list($('today'), today, blockEl, 'Niets gepland vandaag.');

  const deadlines = openDeadlines(planner?.deadlines, now);
  list($('deadlinesSoon'), deadlines.filter((d) => d.urgency), deadlineEl, 'Niets dringends in de komende 3 dagen.');
  list($('deadlinesAll'), deadlines, deadlineEl, 'Geen open deadlines.');
  renderMail();
  renderTip(now);

  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  $('week').replaceChildren(...DAYS.map((name, d) => {
    const date = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + d);
    const wrap = el('div', 'day' + (date.toDateString() === now.toDateString() ? ' today' : ''));
    const dayApple = appleForDay(apple?.events, date);
    const ol = el('ol', 'timeline');
    list(ol, dayItems(plan, date, now, dayApple.timed), blockEl, absences[isoToday(date)] === 'ziek' ? 'Ziek: rust goed uit.' : 'Vrij.');
    const chips = el('ul', 'allday');
    chips.append(...dayApple.allDay.map((e) => el('li', null, e.title)));
    const head = el('h2', null, `${name} ${date.getDate()}/${date.getMonth() + 1}`);
    const isPast = date < new Date(now.getFullYear(), now.getMonth(), now.getDate());
    wrap.append(head, ...(d < 5 && !isPast ? [absencePicker(isoToday(date), 'Naar school?', 'week')] : []), chips, ol);
    return wrap;
  }));
  renderCalendar();
  renderInterview(dayItems(plan, now));
}

function renderNotes() {
  list($('notes'), notes.filter((n) => n.kind === 'note'), noteEl, 'Nog geen notities. Schrijf of voeg hierboven iets toe.');
  list($('checkins'), notes.filter((n) => n.kind === 'checkin'), checkinEl, 'Nog geen avondchecks.');
}

// ---- push notifications (sent by the Supabase Edge Function "notify", also when the app is closed) ----
const NOTIFY_URL = 'https://uizhyrexbiagykzxqmct.supabase.co/functions/v1/notify';
const b64ToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
const pushMsg = (text) => { $('pushState').textContent = text; };

async function refreshPushState() {
  if (!('PushManager' in window) || !('Notification' in window)) {
    $('pushOn').disabled = true;
    return pushMsg('Meldingen werken alleen als je de app opent via het icoon op je beginscherm (iPhone met iOS 16.4 of nieuwer).');
  }
  const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
  $('pushOn').hidden = !!sub;
  $('pushTest').hidden = !sub;
  if (sub) pushMsg('Meldingen staan aan op dit toestel.');
  else if (Notification.permission === 'denied') pushMsg('Meldingen zijn geweigerd. Zet ze aan via Instellingen › Meldingen › Overal.');
}

$('pushOn').addEventListener('click', async () => {
  $('pushOn').disabled = true;
  try {
    if (await Notification.requestPermission() !== 'granted') return refreshPushState();
    const { publicKey } = await (await fetch(NOTIFY_URL + '?action=key')).json();
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) })).toJSON();
    const { error } = await db.from('push_subscriptions').upsert({ endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth });
    if (error) throw error;
    await refreshPushState();
  } catch (err) {
    pushMsg('Aanzetten mislukt: ' + err.message);
  } finally {
    $('pushOn').disabled = false;
  }
});

$('pushTest').addEventListener('click', async () => {
  pushMsg('Testmelding versturen…');
  const { data } = await db.auth.getSession();
  const res = await fetch(NOTIFY_URL + '?action=test', { method: 'POST', headers: { Authorization: 'Bearer ' + data.session?.access_token } });
  const out = await res.json().catch(() => ({}));
  pushMsg(res.ok && out.sent ? 'Verstuurd. Je zou hem nu moeten zien.' : 'Versturen mislukt' + (out.error ? ': ' + out.error : '.'));
});

// ---- films for the TV (red button) ----
// The Edge Function "films" identifies what was typed and fills in genre, images and where to watch;
// status 'ask' means it wants the user to pick one of up to three posters.
const FILMS_URL = 'https://uizhyrexbiagykzxqmct.supabase.co/functions/v1/films';
const TMDB_IMG = 'https://image.tmdb.org/t/p/w185';
const STRIP_LABEL = { action: 'Action', scifi: 'Sci-fi', thriller: 'Thriller', crime: 'Crime', drame: 'Drama', comedie: 'Komedie', romance: 'Romance', horreur: 'Horror', histoire: 'Geschiedenis', anime: 'Anime', animation: 'Animatie', docu: 'Docu' };
const SERVICE = { netflix: 'Netflix', prime: 'Prime Video' };
let films = [];

async function loadFilms() {
  const { data, error } = await db.from('films').select('id, query, status, media, title, year, genre, poster, providers, candidates, error, created_at')
    .neq('status', 'seen').order('created_at', { ascending: false });
  if (error) return showError(error);
  films = data;
  renderFilms();
}

async function filmCall(body) {
  const { data: { session } } = await db.auth.getSession();
  const res = await fetch(FILMS_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + session?.access_token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json().catch(() => ({ error: 'geen antwoord' }));
}

$('filmForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const query = $('filmInput').value.trim();
  if (!query) return;
  $('filmInput').disabled = true;
  say($('filmMsg'), 'Zoeken…');
  const out = await filmCall({ action: 'add', query });
  $('filmInput').disabled = false;
  if (out.error && !out.status) return say($('filmMsg'), 'Niet gelukt: ' + out.error, false);
  $('filmInput').value = '';
  say($('filmMsg'), out.status === 'ask' ? 'Welke bedoel je? Kies hieronder.' : out.status === 'error' ? 'Niet gevonden: ' + out.error
    : out.duplicate ? 'Stond al op je lijst ✓' : `${out.title} staat op je TV ✓`, out.status !== 'error');
  loadFilms();
});

function askEl(f) {
  const li = el('li', 'card');
  li.append(el('p', 'q', `Welke bedoel je met “${f.query}”?`));
  const row = el('div', 'choices');
  for (const c of f.candidates || []) {
    const b = el('button', 'choice');
    b.setAttribute('aria-label', `${c.title} (${c.year ?? '?'})`);
    if (c.poster) { const img = el('img'); img.src = TMDB_IMG + c.poster; img.alt = ''; img.loading = 'lazy'; b.append(img); }
    b.append(el('span', null, c.title), el('small', null, c.year ?? ''));
    b.addEventListener('click', async () => {
      row.querySelectorAll('button').forEach((x) => { x.disabled = true; });
      const out = await filmCall({ action: 'choose', id: f.id, media: c.media, tmdb_id: c.tmdb_id });
      say($('filmMsg'), out.error ? 'Niet gelukt: ' + out.error : `${out.title ?? c.title} staat op je TV ✓`, !out.error);
      loadFilms();
    });
    row.append(b);
  }
  const del = el('button', 'link', 'Geen van deze');
  del.addEventListener('click', () => mutate(db.from('films').delete().eq('id', f.id)));
  li.append(row, del);
  return li;
}

function filmEl(f) {
  const li = el('li', f.status === 'error' ? 'failed' : '');
  const pic = el('div', 'poster');
  if (f.poster) { const img = el('img'); img.src = TMDB_IMG + f.poster; img.alt = ''; img.loading = 'lazy'; pic.append(img); }
  const text = el('div', 'text');
  if (f.status === 'error') {
    text.append(el('strong', null, f.query), el('small', null, f.error || 'Niet gevonden'));
    const retry = el('button', 'link', 'Opnieuw proberen');
    retry.addEventListener('click', async () => { say($('filmMsg'), 'Zoeken…'); await filmCall({ action: 'retry', id: f.id }); loadFilms(); });
    text.append(retry);
  } else if (f.status === 'pending') {
    text.append(el('strong', null, f.query), el('small', null, 'Zoeken…'));
  } else {
    const where = (f.providers || []).map((p) => SERVICE[p]).filter(Boolean).join(' · ') || 'Niet op Netflix of Prime';
    text.append(el('strong', null, `${f.title}${f.year ? ' (' + f.year + ')' : ''}`), el('small', null, `${STRIP_LABEL[f.genre] ?? f.genre} · ${where}`));
  }
  const del = el('button', 'del');
  del.setAttribute('aria-label', 'Van de lijst halen');
  del.innerHTML = '<svg aria-hidden="true"><use href="#i-x"/></svg>';
  del.addEventListener('click', () => mutate(db.from('films').delete().eq('id', f.id)));
  li.append(pic, text, del);
  return li;
}

function renderFilms() {
  const ask = films.filter((f) => f.status === 'ask');
  $('filmAsk').replaceChildren(...ask.map(askEl));
  const rest = films.filter((f) => f.status !== 'ask');
  $('films').replaceChildren(...(rest.length ? rest.map(filmEl) : [el('li', 'empty', 'Nog niets. Typ hierboven een film of serie.')]));
}

// ---- tabs ----
document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('nav button').forEach((x) => x.toggleAttribute('aria-current', x === b));
  document.querySelectorAll('section[data-tab]').forEach((s) => { s.hidden = s.dataset.tab !== b.dataset.go; });
  $('title').textContent = TITLES[b.dataset.go];
  window.scrollTo({ top: 0 });
  if (b.dataset.go === 'week') document.querySelector('.day.today')?.scrollIntoView({ block: 'start' });
}));

// A notification can deep-link to a tab, e.g. ./#avond for the evening check-in.
const openTab = () => document.querySelector(`nav button[data-go="${location.hash.slice(1)}"]`)?.click();
window.addEventListener('hashchange', openTab);
openTab();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').then(refreshPushState);
