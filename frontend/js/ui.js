// Small UI helpers (dialogs, calendar, checklist, sentence line breaks). User text is always set with textContent.
const $ = id => document.getElementById(id);

// Promise-based replacement for window.confirm using the pixel WARNING dialog.
export function confirmDialog(message) {
  const dialog = $('confirm-dialog');
  if (!dialog || typeof dialog.showModal !== 'function') return Promise.resolve(window.confirm(message));
  if (dialog.open) return Promise.resolve(false);
  $('confirm-message').textContent = message;
  dialog.returnValue = '';
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'yes'), { once: true });
    dialog.showModal();
    $('confirm-no').focus(); // Safer default for destructive actions.
  });
}

// Packing checklist: a per-browser convenience, not trip data, so it lives in localStorage.
const checklistKey = 'travel-planner-checklist';
const defaultChecklist = ['여권·신분증 챙기기', '충전기·보조배터리', '숙소 주소 저장해두기', '물 자주 마시기'].map(text => ({ text, done: false }));

function readChecklist() {
  try {
    const saved = JSON.parse(localStorage.getItem(checklistKey));
    if (Array.isArray(saved)) return saved.filter(item => typeof item?.text === 'string').slice(0, 30);
  } catch { /* Storage unavailable or invalid: fall back to defaults. */ }
  return defaultChecklist.map(item => ({ ...item }));
}

function initChecklist() {
  const list = $('checklist'), form = $('checklist-form'), input = $('checklist-input');
  if (!list || !form) return;
  let items = readChecklist();
  const save = () => { try { localStorage.setItem(checklistKey, JSON.stringify(items)); } catch { /* Optional only. */ } };
  const render = () => {
    list.replaceChildren();
    items.forEach((item, index) => {
      const li = document.createElement('li');
      const label = document.createElement('label');
      const box = document.createElement('input'); box.type = 'checkbox'; box.checked = item.done;
      box.onchange = () => { item.done = box.checked; save(); li.classList.toggle('done', item.done); };
      const text = document.createElement('span'); text.textContent = item.text;
      label.append(box, text);
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×';
      remove.setAttribute('aria-label', `${item.text} 삭제`);
      remove.onclick = () => { items.splice(index, 1); save(); render(); };
      li.classList.toggle('done', item.done);
      li.append(label, remove); list.append(li);
    });
    if (!items.length) { const li = document.createElement('li'); li.className = 'muted'; li.textContent = '모두 챙겼어요!'; list.append(li); }
  };
  form.onsubmit = event => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text || items.length >= 30) return;
    items.push({ text, done: false }); input.value = ''; save(); render();
  };
  render();
}

let calendarTrips = [];
let calendarMonth = null; // { year, month } currently shown
let lastDay = '';

function isoDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function renderCalendar() {
  const box = $('calendar');
  if (!box) return;
  const now = new Date();
  if (!calendarMonth) calendarMonth = { year: now.getFullYear(), month: now.getMonth() };
  const { year, month } = calendarMonth;
  const today = isoDate(now);
  box.replaceChildren();
  const head = document.createElement('div'); head.className = 'cal-head';
  const prev = document.createElement('button'); prev.type = 'button'; prev.textContent = '‹'; prev.setAttribute('aria-label', '이전 달');
  const next = document.createElement('button'); next.type = 'button'; next.textContent = '›'; next.setAttribute('aria-label', '다음 달');
  const title = document.createElement('b'); title.textContent = `${year}년 ${month + 1}월`;
  prev.onclick = () => { calendarMonth = month === 0 ? { year: year - 1, month: 11 } : { year, month: month - 1 }; renderCalendar(); };
  next.onclick = () => { calendarMonth = month === 11 ? { year: year + 1, month: 0 } : { year, month: month + 1 }; renderCalendar(); };
  head.append(prev, title, next);
  const grid = document.createElement('div'); grid.className = 'cal-grid'; grid.setAttribute('role', 'grid');
  for (const name of ['일', '월', '화', '수', '목', '금', '토']) {
    const cell = document.createElement('span'); cell.className = 'cal-weekday'; cell.textContent = name; grid.append(cell);
  }
  const firstDay = new Date(year, month, 1).getDay();
  const days = new Date(year, month + 1, 0).getDate();
  for (let i = 0; i < firstDay; i++) grid.append(document.createElement('span'));
  for (let day = 1; day <= days; day++) {
    const value = isoDate(new Date(year, month, day));
    const cell = document.createElement('span'); cell.className = 'cal-day'; cell.textContent = String(day);
    const trips = calendarTrips.filter(trip => trip.start_date <= value && value <= trip.end_date);
    if (value === today) { cell.classList.add('today'); cell.setAttribute('aria-current', 'date'); }
    if (trips.length) { cell.classList.add('trip-day'); cell.title = trips.map(trip => trip.title).join(', '); }
    const weekday = (firstDay + day - 1) % 7;
    if (weekday === 0) cell.classList.add('sun');
    if (weekday === 6) cell.classList.add('sat');
    grid.append(cell);
  }
  box.append(head, grid);
  const upcoming = calendarTrips.filter(trip => trip.start_date.slice(0, 7) <= `${year}-${String(month + 1).padStart(2, '0')}` && trip.end_date.slice(0, 7) >= `${year}-${String(month + 1).padStart(2, '0')}`);
  if (upcoming.length) {
    const legend = document.createElement('p'); legend.className = 'cal-legend';
    legend.textContent = `이번 달 여행: ${upcoming.map(trip => trip.title).join(', ')}`;
    box.append(legend);
  }
}

export function setCalendarTrips(trips) {
  calendarTrips = trips.map(trip => ({ title: trip.title, start_date: trip.start_date, end_date: trip.end_date }));
  renderCalendar();
}

function startClock() {
  const clock = $('today-clock'), date = $('today-date');
  if (!clock) return;
  const timeFormat = new Intl.DateTimeFormat('ko-KR', { hour: 'numeric', minute: '2-digit' });
  const dateFormat = new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });
  const tick = () => {
    const now = new Date();
    clock.textContent = timeFormat.format(now); clock.dateTime = now.toISOString();
    if (date) date.textContent = dateFormat.format(now);
    const today = isoDate(now);
    if (today !== lastDay) { lastDay = today; calendarMonth = null; renderCalendar(); }
  };
  tick();
  setInterval(tick, 15000);
}

// One sentence per line for guide/intro/status text across the site (also for text set later by JS).
const SENTENCE_TARGETS = ['.hero-description', '.steps p', '.cta p', '.intro-note', '.empty-card', '.empty-card p', '.docs-intro p',
  '.field-hint', '.note-hint', '.trips-toolbar p', '#ai-assumptions li', '.draft-notes', '.day-item p', '.talk-bubble p',
  '.summary-more > p', '.extract-notes li', '#health-message', '.status'].join(', ');
const breakSentences = text => text.replace(/([.!?…][”"')]?)[ \t]+(?=\S)/g, '$1\n');
function formatSentences(root) {
  if (!root || root.nodeType !== 1) return;
  const targets = root.matches(SENTENCE_TARGETS) ? [root] : [];
  const owner = root.closest(SENTENCE_TARGETS);
  if (owner && owner !== root) targets.push(owner);
  targets.push(...root.querySelectorAll(SENTENCE_TARGETS));
  for (const element of targets) {
    for (const node of element.childNodes) {
      if (node.nodeType !== 3) continue;
      const next = breakSentences(node.nodeValue);
      if (next !== node.nodeValue) node.nodeValue = next; // Stable after one pass, so the observer settles.
    }
  }
}
function watchSentences() {
  formatSentences(document.body);
  new MutationObserver(records => {
    for (const record of records) formatSentences(record.type === 'characterData' ? record.target.parentElement : record.target);
  }).observe(document.body, { subtree: true, childList: true, characterData: true });
}

export function initializeUi() {
  watchSentences();
  startClock();
  initChecklist();
  // Window "×" buttons in form dialogs reuse each form's own cancel logic (respects busy state).
  document.querySelectorAll('[data-close-for]').forEach(button => {
    button.addEventListener('click', () => $(button.dataset.closeFor)?.click());
  });
}

// "[관광] 광안리 해변" style label for schedule rows, drafts (cafés shown as [카페]).
const TAG = { visit: '관광', flight: '항공', stay: '숙소', food: '식사', transfer: '이동', other: '기타' };
export const tagOf = item => `[${item.category === 'food' && /카페|디저트/.test(item.title) ? '카페' : TAG[item.category] ?? '기타'}]`;
