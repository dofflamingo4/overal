import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm';
import { hhmm, dayItems, openDeadlines, nowNext, untilText, dueLabel } from './logic.js';

// The publishable key is meant to be public: Row Level Security limits every row to its owner.
const db = createClient('https://uizhyrexbiagykzxqmct.supabase.co', 'sb_publishable_a0EhD2sC_LkoRgoR2F4i6A_XDtg455V');

const DAYS = ['Maandag', 'Dinsdag', 'Woensdag', 'Donderdag', 'Vrijdag', 'Zaterdag', 'Zondag'];
const TITLES = { vandaag: 'Vandaag', week: 'Deze week', deadlines: 'Deadlines', notities: 'Notities', avond: 'Avondcheck' };
const KINDS = { les: 'Les', opt: 'Werkcollege', reis: 'Reis', studie: 'Studie', extra: 'Extra', deadline: 'Deadline-werk', werk: 'Werk' };
const STALE_MS = 2 * 3600e3; // laptop data older than this gets an orange dot
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const kindOf = (i) => (i.optional ? 'opt' : i.kind);
const color = (node, i) => { node.style.setProperty('--c', `var(--${kindOf(i)})`); return node; };
const nowMin = (d) => d.getHours() * 60 + d.getMinutes();

let planner = null;
let notes = [];
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
  await Promise.all([loadPlanner(), loadNotes()]);
  // Changes made on another device arrive here within a second or two.
  db.channel('sync')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'snapshots' }, loadPlanner)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'notes' }, loadNotes)
    .subscribe();
  setInterval(render, 30_000); // keeps the "now" marker and countdown moving
  document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
}

async function loadPlanner() {
  const { data, error } = await db.from('snapshots').select('data').eq('source', 'weekplanner').maybeSingle();
  if (error) return showError(error);
  planner = data?.data ?? null;
  render();
}

async function loadNotes() {
  const { data, error } = await db.from('notes').select('*').order('created_at', { ascending: false });
  if (error) return showError(error);
  notes = data;
  render();
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

function addNote(input, kind) {
  const body = input.value.trim();
  if (!body) return;
  input.value = '';
  mutate(db.from('notes').insert({ body, kind }));
}
$('noteForm').addEventListener('submit', (e) => { e.preventDefault(); addNote($('noteInput'), 'note'); });
$('checkinForm').addEventListener('submit', (e) => { e.preventDefault(); addNote($('checkinInput'), 'checkin'); });

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
  del.addEventListener('click', () => mutate(db.from('notes').delete().eq('id', n.id)));
  li.append(check, el('span', 'text', n.body), del);
  return li;
}

function checkinEl(n) {
  const li = el('li', 'entry');
  li.append(el('span', 'text', n.body), el('span', 'date', new Date(n.created_at).toLocaleDateString('nl-BE', { weekday: 'short', day: 'numeric', month: 'numeric' })));
  return li;
}

function renderStatus(now) {
  const s = $('synced');
  const at = planner?.syncedAt;
  s.className = 'status' + (lastError ? ' error' : !at || now - at > STALE_MS ? ' stale' : '');
  s.textContent = lastError || (at ? 'Laptop bijgewerkt ' + new Date(at).toLocaleString('nl-BE', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : 'Nog geen planner van je laptop ontvangen');
}

function render() {
  const now = new Date();
  $('dateLine').textContent = now.toLocaleDateString('nl-BE', { weekday: 'long', day: 'numeric', month: 'long' });
  renderStatus(now.getTime());

  const today = dayItems(planner, now);
  const { now: current, next } = nowNext(today);
  $('focus').replaceChildren(
    ...(current ? [focusCard(current, 'Nu', `tot ${hhmm(current.end)}`, 'now')] : []),
    ...(next ? [focusCard(next, current ? 'Straks' : 'Hierna', `${untilText(next.start, nowMin(now))} · ${hhmm(next.start)}`, 'next')] : []),
  );
  list($('today'), today, blockEl, 'Niets gepland vandaag.');

  const deadlines = openDeadlines(planner?.deadlines, now);
  list($('deadlinesSoon'), deadlines.filter((d) => d.urgency), deadlineEl, 'Niets dringends in de komende 3 dagen.');
  list($('deadlinesAll'), deadlines, deadlineEl, 'Geen open deadlines.');

  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  $('week').replaceChildren(...DAYS.map((name, d) => {
    const date = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + d);
    const wrap = el('div', 'day' + (date.toDateString() === now.toDateString() ? ' today' : ''));
    const ol = el('ol', 'timeline');
    list(ol, dayItems(planner, date, now), blockEl, 'Vrij.');
    wrap.append(el('h2', null, `${name} ${date.getDate()}/${date.getMonth() + 1}`), ol);
    return wrap;
  }));

  list($('notes'), notes.filter((n) => n.kind === 'note'), noteEl, 'Nog geen notities. Schrijf hierboven je eerste idee.');
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
