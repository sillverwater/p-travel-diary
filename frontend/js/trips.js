import { request } from './api.js';
import { addReservation, fillReservations, readReservations } from './reservations.js';
import { initializeItinerary, selectItineraryTrip } from './itinerary.js';
import { confirmDialog, setCalendarTrips } from './ui.js';
import { initializeExpenses, selectExpenseTrip } from './expenses.js';
import { initializeDocuments, selectDocumentTrip } from './documents.js';
import { readFileBase64 } from './files.js';

const $ = id => document.getElementById(id);
let editingId = null;
let detailId = null;
let busy = false;
let loading = false;
let currentTrip = null;

// Pages: #home (default), #trips (ticket list), #trip/{id} (one trip inside "내 여행").
function setPage(name) {
  $('home-page').hidden = name !== 'home';
  $('trips-page').hidden = name !== 'trips';
  $('travel-page').hidden = name !== 'trip';
  document.body.classList.toggle('travel-workspace', name === 'trip');
  const section = name === 'trip' ? 'trips' : name;
  for (const link of document.querySelectorAll('[data-nav]')) {
    const active = link.dataset.nav === section;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
}

function goHome(page = 'home') {
  detailId = null; currentTrip = null;
  selectItineraryTrip(null);
  selectExpenseTrip(null);
  selectDocumentTrip(null);
  setPage(page);
  if (location.hash.startsWith('#trip/')) location.hash = page;
}

async function navigate() {
  if (!location.hash.startsWith('#trip/')) {
    const page = location.hash === '#trips' ? 'trips' : 'home';
    goHome(page);
    if (location.hash === '#checklist-card') $('checklist-card').scrollIntoView({ block: 'start' });
    else window.scrollTo({ top: 0 });
    return;
  }
  const id = location.hash.slice(6);
  try {
    const value = await request(`/api/trips/${encodeURIComponent(id)}`);
    if (location.hash === `#trip/${id}`) showDetail(value);
  } catch (error) { goHome(); showError(error); }
}

function showError(error) {
  $('trips-status').textContent = error.message || '연결을 확인하고 다시 시도해주세요.';
}

const REGION_LABEL = { domestic: '국내', overseas: '해외' };
const ACCESS_LABEL = { flight: '비행기', train_bus: '기차·버스', car: '자차' };
const checkedValue = name => document.querySelector(`input[name="${name}"]:checked`)?.value;

// Overseas → flight only. Flight section only when going by plane. 자차 implies a car at the destination.
function syncAccessUI() {
  const overseas = checkedValue('trip-region') === 'overseas';
  for (const radio of document.querySelectorAll('input[name="trip-access"]')) {
    radio.disabled = overseas && radio.value !== 'flight';
    if (overseas && radio.value === 'flight') radio.checked = true;
  }
  const access = checkedValue('trip-access') ?? 'flight';
  $('flight-section').hidden = access !== 'flight';
  $('ground-section').hidden = access !== 'train_bus';
  $('car-section').hidden = access !== 'car';
  // Hidden sections must not block form validation; disabled inputs keep their values.
  for (const id of ['flight-section', 'ground-section', 'car-section']) {
    for (const control of $(id).querySelectorAll('input, select, button')) control.disabled = $(id).hidden;
  }
  $('trip-local-car').disabled = access === 'car';
  if (access === 'car') $('trip-local-car').checked = true;
  $('trip-access-hint').textContent = {
    flight: overseas ? '해외여행은 비행기로 이동해요. 아래에 항공편을 등록하면 일정표에 출발·도착이 자동으로 들어가요.'
      : '아래에 항공편을 등록하면 일정표에 출발·도착이 자동으로 들어가요.',
    train_bus: '아래에 기차·버스 구간을 등록하면 일정표에 이동 일정이 자동으로 들어가요.',
    car: '아래에 자차 출발·도착 위치를 등록해 주세요. 현지에서도 차로 이동하는 기준으로 일정을 짜고, 주차 가능 여부를 함께 안내해 드려요.',
  }[access];
}

const MODE_LABEL = { train: '기차', bus: '버스', car: '자차' };
const reservedCost = trip => [...trip.flights, ...trip.accommodations, ...(trip.ground ?? [])].reduce((sum, item) => sum + (item.cost_krw || 0), 0);
const shortTime = value => (value ? value.slice(5, 16).replace('T', ' ').replace('-', '/') : '');

function openEditor(trip = null) {
  editingId = trip?.id ?? null;
  $('trip-form').reset();
  $('trip-form-title').textContent = trip ? '여행 수정하기' : '새 여행 만들기';
  $('trip-title').value = trip?.title ?? '';
  $('trip-destination').value = trip?.destination ?? '';
  $('trip-start').value = trip?.start_date ?? '';
  $('trip-end').value = trip?.end_date ?? '';
  $('trip-end').min = $('trip-start').value;
  $('trip-travelers').value = trip?.travelers ?? 1;
  $('trip-budget').value = trip?.budget_krw ?? 0;
  $('trip-style').value = trip?.travel_style ?? '';
  $('trip-places').value = (trip?.must_visit_places ?? []).join('\n');
  fillReservations(trip);
  const region = trip?.region ?? 'domestic', access = trip?.access ?? 'flight';
  document.querySelector(`input[name="trip-region"][value="${region}"]`).checked = true;
  document.querySelector(`input[name="trip-access"][value="${access}"]`).checked = true;
  $('trip-local-car').checked = Boolean(trip?.local_car);
  syncAccessUI();
  $('trip-form-error').textContent = '';
  $('extract-text').value = ''; $('extract-file').value = ''; $('extract-status').textContent = ''; $('extract-notes').replaceChildren();
  document.querySelector('.extract-box').open = false;
  $('trip-dialog').showModal();
}

function showDetail(trip) {
  currentTrip = trip;
  setPage('trip');
  $('summary-destination').textContent = `${trip.destination} · ${REGION_LABEL[trip.region] ?? '국내'} · ${ACCESS_LABEL[trip.access] ?? '비행기'}${trip.local_car && trip.access !== 'car' ? ' · 렌터카' : ''}`;
  $('summary-dates').textContent = `${trip.start_date} ~ ${trip.end_date}`;
  $('summary-travelers').textContent = `${trip.travelers}명`;
  $('summary-budget').textContent = `예산 ${Number(trip.budget_krw).toLocaleString('ko-KR')}원`;
  if (location.hash !== `#trip/${trip.id}`) location.hash = `trip/${trip.id}`;
  detailId = trip.id;
  $('detail-title').textContent = trip.title;
  $('detail-destination').textContent = trip.destination;
  $('detail-dates').textContent = `${trip.start_date} ~ ${trip.end_date}`;
  $('detail-travelers').textContent = `${trip.travelers}명`;
  const won = value => `${Number(value).toLocaleString('ko-KR')}원`;
  $('detail-budget').textContent = won(trip.budget_krw);
  $('detail-style').textContent = trip.travel_style || '미설정';
  $('detail-places').textContent = trip.must_visit_places.join(' · ') || '미설정';
  const fixed = reservedCost(trip);
  $('detail-reserved').textContent = won(fixed);
  $('detail-remaining').textContent = trip.budget_krw === 0 ? '예산 미설정' : won(trip.budget_krw - fixed);
  $('detail-budget-note').textContent = trip.budget_krw > 0 && fixed > trip.budget_krw
    ? '예약 비용이 총예산을 초과했습니다. 예산 또는 예약 정보를 확인해주세요.'
    : '예약 비용은 계획용 금액입니다. 실제 지출로 자동 등록되지 않습니다.';
  const localTime = value => value.replace('T', ' ');
  const renderRows = (id, items, describe) => {
    const list = $(id); list.replaceChildren();
    for (const item of items) { const row = document.createElement('li'); row.textContent = describe(item); list.append(row); }
    if (!items.length) { const row = document.createElement('li'); row.textContent = '등록된 정보가 없습니다.'; list.append(row); }
  };
  // "가는 방법" block follows the trip's access: 항공편 / 기차·버스 / 자차.
  const access = trip.access ?? 'flight';
  $('detail-access').textContent = `${REGION_LABEL[trip.region] ?? '국내'} · ${ACCESS_LABEL[access]}${trip.local_car && access !== 'car' ? ' · 현지 렌터카' : ''}`;
  $('detail-transport-title').textContent = { flight: '항공편', train_bus: '기차·버스', car: '자차 이동' }[access];
  if (access === 'flight') {
    renderRows('detail-flights', trip.flights, f => `${f.flight_number || '항공편'} · ${f.departure_airport} → ${f.arrival_airport}\n출발 ${localTime(f.departure_at)} (${f.departure_timezone})\n도착 ${localTime(f.arrival_at)} (${f.arrival_timezone}) · ${won(f.cost_krw)}`);
  } else {
    renderRows('detail-flights', trip.ground ?? [], g => [
      `${MODE_LABEL[g.mode]}${g.label ? ' ' + g.label : ''} · ${g.from_place} → ${g.to_place}`,
      [g.departure_at ? `출발 ${localTime(g.departure_at)}` : '', g.arrival_at ? `도착 ${localTime(g.arrival_at)}` : ''].filter(Boolean).join(' · ') || '시각 미정',
      `${g.mode === 'car' ? '예상 비용' : '예약 비용'} ${won(g.cost_krw)}`,
    ].join('\n'));
  }
  renderRows('detail-stays', trip.accommodations, s => `${s.name}${s.address ? ' · ' + s.address : ''}\n${localTime(s.check_in)} ~ ${localTime(s.check_out)} (${s.timezone}) · ${won(s.cost_krw)}`);
  $('trip-detail').hidden = false;
  if ($('travel-page').dataset.trip !== trip.id) {
    showTab('plan'); // New trip opened: start on the planner tab.
    // Default 차량 choice from how the trip is travelled.
    $('route-mode').value = trip.access === 'car' || trip.local_car ? 'driving' : 'transit';
  }
  $('travel-page').dataset.trip = trip.id;
  selectItineraryTrip(trip);
  selectExpenseTrip(trip);
  selectDocumentTrip(trip);
}


function todayString() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function dDay(trip) {
  const today = todayString();
  if (today > trip.end_date) return '다녀옴';
  if (today >= trip.start_date) return '여행 중';
  const days = Math.round((Date.parse(trip.start_date) - Date.parse(today)) / 86400000);
  return `D-${days}`;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function sprite(name, className) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', `px ${className}`); svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `/static/island.svg#${name}`);
  svg.append(use); return svg;
}

// Infographic for the nearest upcoming/ongoing trip (or the latest past one). Uses saved data only.
function renderSpotlight(trips) {
  const box = $('trip-spotlight');
  box.replaceChildren();
  const today = todayString();
  const upcoming = trips.filter(trip => trip.end_date >= today).sort((a, b) => a.start_date.localeCompare(b.start_date));
  const trip = upcoming[0] ?? [...trips].sort((a, b) => b.end_date.localeCompare(a.end_date))[0];
  const sky = element('div', 'info-sky');
  sky.append(sprite('cloud', 'info-cloud c1'), sprite('cloud', 'info-cloud c2'), sprite('plane', 'info-plane'));
  if (!trip) {
    sky.append(element('p', 'info-label', 'NEXT TRIP'), element('h3', 'info-dest', '어디로 떠나볼까요?'));
    const add = element('button', 'primary-button info-open', '＋ 첫 여행 만들기');
    add.type = 'button'; add.onclick = () => openEditor();
    box.append(sky, add); return;
  }
  const label = trip.end_date < today ? 'LAST TRIP' : today >= trip.start_date ? 'NOW TRAVELING' : 'NEXT TRIP';
  sky.append(element('span', 'info-dday', dDay(trip)), element('p', 'info-label', label), element('h3', 'info-dest', trip.destination), element('p', 'info-title', trip.title));

  const route = element('div', 'info-route');
  const from = firstLeg(trip)?.from || '출발';
  route.append(element('span', 'info-stop', from), element('i', 'info-dots'), sprite('pin', 'info-pin'), element('i', 'info-dots'), element('span', 'info-stop', trip.destination));
  route.setAttribute('aria-label', `${from}에서 ${trip.destination}까지`);

  const nights = Math.round((Date.parse(trip.end_date) - Date.parse(trip.start_date)) / 86400000);
  const stats = element('dl', 'info-stats');
  for (const [term, value] of [
    ['기간', nights === 0 ? '당일치기' : `${nights}박 ${nights + 1}일`],
    ['인원', `${trip.travelers}명`],
    (trip.access ?? 'flight') === 'flight' ? ['항공편', `${trip.flights.length}건`] : [ACCESS_LABEL[trip.access], `${(trip.ground ?? []).length}건`],
    ['숙소', `${trip.accommodations.length}곳`],
  ]) {
    const cell = element('div'); cell.append(element('dt', '', term), element('dd', '', value)); stats.append(cell);
  }

  const reserved = reservedCost(trip);
  const budget = element('div', 'info-budget');
  const won = value => Number(value).toLocaleString('ko-KR');
  const head = element('p');
  head.append(element('span', '', '예약 비용 / 예산'), element('span', '', trip.budget_krw > 0 ? `${won(reserved)} / ${won(trip.budget_krw)}원` : `${won(reserved)}원 · 예산 미설정`));
  const meter = element('div', 'info-meter'); const fill = element('i');
  const percent = trip.budget_krw > 0 ? Math.min(100, Math.round(reserved / trip.budget_krw * 100)) : 0;
  fill.style.width = `${percent}%`;
  if (trip.budget_krw > 0 && reserved > trip.budget_krw) meter.dataset.over = 'true';
  meter.setAttribute('role', 'img'); meter.setAttribute('aria-label', trip.budget_krw > 0 ? `예산의 ${percent}% 예약에 사용` : '예산 미설정');
  meter.append(fill); budget.append(head, meter);

  const open = element('a', 'primary-button info-open', '이 여행 열기 →');
  open.href = `#trip/${encodeURIComponent(trip.id)}`;
  box.append(sky, route, stats, budget, open);
}

function shortWon(value) {
  if (value >= 100000000) return `${(value / 100000000).toFixed(1).replace(/\.0$/, '')}억`;
  if (value >= 10000) return `${Math.round(value / 10000).toLocaleString('ko-KR')}만`;
  return value.toLocaleString('ko-KR');
}

// Reserved (flights + stays) vs total budget per trip, upcoming trips first. Saved data only.
function renderBudgetChart(trips) {
  const box = $('budget-chart');
  box.replaceChildren();
  const today = todayString();
  const ordered = [...trips].sort((a, b) => (a.end_date < today) - (b.end_date < today) || a.start_date.localeCompare(b.start_date)).slice(0, 5);
  if (!ordered.length) { box.append(element('p', 'muted', '여행을 만들면 예산 사용 현황이 여기에 보여요.')); return; }
  for (const trip of ordered) {
    const reserved = reservedCost(trip);
    const row = element('div', 'budget-row');
    const name = element('span', 'budget-name', trip.title);
    const track = element('div', 'budget-track'); const fill = element('i');
    const percent = trip.budget_krw > 0 ? Math.min(100, Math.round(reserved / trip.budget_krw * 100)) : 0;
    fill.style.width = `${percent}%`;
    if (trip.budget_krw > 0 && reserved > trip.budget_krw) track.dataset.over = 'true';
    track.setAttribute('role', 'img');
    track.setAttribute('aria-label', trip.budget_krw > 0 ? `${trip.title}: 예산의 ${percent}%를 예약에 사용` : `${trip.title}: 예산 미설정`);
    track.append(fill);
    const value = element('span', 'budget-value', trip.budget_krw > 0 ? `${shortWon(reserved)} / ${shortWon(trip.budget_krw)}원` : '예산 미설정');
    row.append(name, track, value); box.append(row);
  }
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
function prettyDate(value) {
  const day = new Date(`${value}T00:00:00`);
  return `${value.replace(/-/g, '.')} (${WEEKDAYS[day.getDay()]})`;
}

function field(label, value) {
  const box = element('div', 'ticket-field');
  box.append(element('span', '', label), element('b', '', value));
  return box;
}

// First outbound leg for the trip's access (항공편 / 기차·버스 / 자차), normalised for display.
function firstLeg(trip) {
  if ((trip.access ?? 'flight') === 'flight') {
    const f = [...trip.flights].sort((a, b) => a.departure_at.localeCompare(b.departure_at))[0];
    return f && { from: f.departure_airport, to: f.arrival_airport, dep: f.departure_at, arr: f.arrival_at, code: f.flight_number, kind: '항공편' };
  }
  const g = [...(trip.ground ?? [])].sort((a, b) => (a.departure_at ?? '9').localeCompare(b.departure_at ?? '9'))[0];
  return g && { from: g.from_place, to: g.to_place, dep: g.departure_at, arr: g.arrival_at, code: g.label, kind: MODE_LABEL[g.mode] };
}

// Boarding-pass style card. All trip text is assigned with textContent.
function ticket(trip, index) {
  const leg = firstLeg(trip);
  const flights = [...trip.flights].sort((a, b) => a.departure_at.localeCompare(b.departure_at));
  const first = flights[0];
  const nights = Math.round((Date.parse(trip.end_date) - Date.parse(trip.start_date)) / 86400000);
  const card = element('article', 'trip-card ticket');
  card.dataset.tone = String(index % 3);

  const main = element('div', 'ticket-main');
  const head = element('header', 'ticket-head');
  const bird = element('span', 'ticket-bird'); bird.setAttribute('aria-hidden', 'true');
  const headText = element('div');
  headText.append(element('p', 'ticket-kicker', { flight: 'Boarding Pass', train_bus: 'Train · Bus Pass', car: 'Road Trip Pass' }[trip.access] ?? 'Boarding Pass'), element('p', 'ticket-label', 'Trip Name'), element('h3', 'ticket-title', trip.title));
  head.append(bird, headText);

  const body = element('div', 'ticket-body');
  const route = element('p', 'ticket-route');
  route.append(element('span', '', leg?.from || '출발지'), element('small', '', 'TO'), element('span', 'trip-destination', leg?.to && trip.access !== 'flight' ? leg.to : trip.destination));
  const access = trip.access ?? 'flight';
  const grid = element('div', 'ticket-grid');
  grid.append(
    field('DATE', `${prettyDate(trip.start_date)}`),
    field('UNTIL', prettyDate(trip.end_date)),
    field('STAY', nights === 0 ? '당일치기' : `${nights}박 ${nights + 1}일`),
    access === 'flight'
      ? field('FLIGHT', first?.flight_number || (flights.length ? '항공편' : '미등록'))
      : field(access === 'car' ? 'BY CAR' : 'TRAIN · BUS', leg ? `${leg.kind}${leg.code ? ' ' + leg.code : ''}` : `${ACCESS_LABEL[access]} 미등록`),
  );
  body.append(route, grid);
  const scene = element('div', 'ticket-scene'); scene.setAttribute('aria-hidden', 'true');
  main.append(head, body, scene);

  const stub = element('div', 'ticket-stub');
  const plane = element('div', 'stub-plane'); plane.setAttribute('aria-hidden', 'true');
  const actions = element('div', 'trip-actions');
  actions.innerHTML = '<button type="button" data-action="open">열기</button><button type="button" data-action="edit">수정</button><button type="button" data-action="delete" class="danger-button">삭제</button>';
  const airport = element('div', 'stub-scene'); airport.setAttribute('aria-hidden', 'true');
  stub.append(plane, actions, airport);
  card.append(main, stub);
  card.setAttribute('aria-label', `${trip.title} 여행 티켓 · 눌러서 열기`);
  return card;
}

function renderQuickLinks(trips) {
  const list = $('quick-links');
  list.replaceChildren();
  const today = todayString();
  const ordered = [...trips].sort((a, b) => (a.end_date < today) - (b.end_date < today) || a.start_date.localeCompare(b.start_date));
  for (const trip of ordered.slice(0, 5)) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `#trip/${encodeURIComponent(trip.id)}`;
    const text = element('span', 'quick-text');
    text.append(element('b', '', trip.title), element('small', '', `${trip.destination} · ${trip.start_date.slice(5).replace('-', '/')} ~ ${trip.end_date.slice(5).replace('-', '/')}`));
    a.append(text, element('span', 'quick-dday', dDay(trip)));
    li.append(a); list.append(li);
  }
  if (!trips.length) list.append(element('li', 'muted', '아직 여행이 없어요. 새 여행을 만들어보세요.'));
}

async function loadTrips() {
  if (loading) return;
  loading = true;
  $('trips-status').textContent = '여행을 불러오는 중…';
  try {
    const trips = await request('/api/trips');
    $('trip-list').replaceChildren();
    $('trip-empty').hidden = trips.length !== 0;
    $('trip-count').textContent = `(${trips.length})`;
    renderQuickLinks(trips);
    renderSpotlight(trips);
    setCalendarTrips(trips);
    renderBudgetChart(trips);
    trips.forEach((trip, index) => {
      const card = ticket(trip, index);
      card.querySelector('[data-action="open"]').onclick = async () => {
        try {
          const current = await request(`/api/trips/${trip.id}`);
          showDetail(current);
          window.scrollTo({ top: 0 });
        } catch (error) { showError(error); }
      };
      card.querySelector('[data-action="edit"]').onclick = () => openEditor(trip);
      card.querySelector('[data-action="delete"]').onclick = async event => {
        const button = event.currentTarget;
        if (!(await confirmDialog(`“${trip.title}” 여행을 삭제할까요? 삭제한 내용은 복구할 수 없습니다.`))) return;
        button.disabled = true;
        try {
          await request(`/api/trips/${trip.id}`, { method: 'DELETE' });
          if (detailId === trip.id) goHome();
          await loadTrips();
        } catch (error) { showError(error); }
        finally { button.disabled = false; }
      };
      // Clicking anywhere on the ticket (except its buttons) opens the trip, same as "열기".
      card.tabIndex = 0;
      card.addEventListener('click', event => {
        if (event.target.closest('button, a, input, select, textarea')) return;
        card.querySelector('[data-action="open"]').click();
      });
      card.addEventListener('keydown', event => {
        if (event.target !== card || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        card.querySelector('[data-action="open"]').click();
      });
      $('trip-list').append(card);
    });
    if (detailId) {
      const selected = trips.find(trip => trip.id === detailId);
      if (selected) showDetail(selected);
      else goHome();
    }
    $('trips-status').textContent = '여행 정보는 이 컴퓨터에 자동 저장됩니다.';
  } catch (error) { showError(error); }
  finally { loading = false; }
}

function showTab(name, focus = false) {
  for (const tab of document.querySelectorAll('[role="tab"][data-tab]')) {
    const selected = tab.dataset.tab === name;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    $(tab.getAttribute('aria-controls')).hidden = !selected;
    if (selected && focus) tab.focus();
  }
}

function initializeTabs() {
  const tabs = [...document.querySelectorAll('[role="tab"][data-tab]')];
  tabs.forEach((tab, index) => {
    tab.onclick = () => showTab(tab.dataset.tab);
    tab.onkeydown = event => {
      const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      event.preventDefault();
      showTab(tabs[(index + step + tabs.length) % tabs.length].dataset.tab, true);
    };
  });
}

function initializeExtraction() {
  let running = false;
  $('extract-run').onclick = async () => {
    if (running) return;
    const text = $('extract-text').value.trim();
    const file = $('extract-file').files[0];
    if (!text && !file) { $('extract-status').textContent = '안내문을 붙여넣거나 파일을 선택해주세요.'; return; }
    running = true; $('extract-run').disabled = true;
    $('extract-status').textContent = '예약 정보를 읽는 중…'; $('extract-notes').replaceChildren();
    try {
      const body = { text };
      if (file) { body.name = file.name; body.content_base64 = await readFileBase64(file); }
      const result = await request('/api/reservations/extract', { method: 'POST', body });
      for (const flight of result.flights) addReservation('flight', flight);
      for (const stay of result.accommodations) addReservation('stay', stay);
      $('extract-status').textContent = `항공편 ${result.flights.length}건, 숙소 ${result.accommodations.length}건을 아래 칸에 추가했어요. 확인 후 저장해주세요.`;
      for (const note of result.notes) { const li = document.createElement('li'); li.textContent = note; $('extract-notes').append(li); }
    } catch (error) { $('extract-status').textContent = error.message; }
    finally { running = false; $('extract-run').disabled = false; }
  };
}

export function initializeTrips() {
  initializeItinerary();
  initializeExpenses();
  initializeDocuments();
  initializeTabs();
  initializeExtraction();
  $('back-to-trips').onclick = () => goHome('trips');
  $('edit-current-trip').onclick = () => { if (currentTrip) openEditor(currentTrip); };
  document.querySelector('.nav-item').href = '#home';
  window.addEventListener('hashchange', navigate);
  navigate();
  $('add-flight').onclick = () => addReservation('flight');
  $('add-stay').onclick = () => addReservation('stay');
  $('add-train').onclick = () => addReservation('train');
  $('add-bus').onclick = () => addReservation('bus');
  $('add-car').onclick = () => addReservation('car');
  document.querySelectorAll('[data-new-trip]').forEach(button => {
    button.onclick = () => openEditor();
  });
  $('reload-trips').onclick = loadTrips;
  $('trip-cancel').onclick = () => { if (!busy) $('trip-dialog').close(); };
  $('trip-dialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  $('trip-start').onchange = () => { $('trip-end').min = $('trip-start').value; };
  for (const input of document.querySelectorAll('input[name="trip-region"], input[name="trip-access"]')) input.addEventListener('change', syncAccessUI);
  $('trip-form').onsubmit = async event => {
    event.preventDefault();
    if (busy) return;
    const payload = {
      title: $('trip-title').value.trim(),
      destination: $('trip-destination').value.trim(),
      start_date: $('trip-start').value,
      end_date: $('trip-end').value,
      travelers: Number($('trip-travelers').value),
      budget_krw: Number($('trip-budget').value),
      travel_style: $('trip-style').value.trim(),
      must_visit_places: [...new Set($('trip-places').value.split('\n').map(value => value.trim()).filter(Boolean))],
      region: checkedValue('trip-region') ?? 'domestic',
      access: checkedValue('trip-access') ?? 'flight',
      local_car: $('trip-local-car').checked,
      // Flights are only kept for trips that go by plane.
      flights: (checkedValue('trip-access') ?? 'flight') === 'flight' ? readReservations('flight') : [],
      // 기차·버스 or 자차 segments, only for the matching access.
      ground: { flight: [], train_bus: readReservations('ground'), car: readReservations('car') }[checkedValue('trip-access') ?? 'flight'],
      accommodations: readReservations('stay'),
    };
    if (!payload.title || !payload.destination) {
      $('trip-form-error').textContent = '여행 이름과 여행지를 입력해주세요.';
      return;
    }
    if (payload.end_date < payload.start_date) {
      $('trip-form-error').textContent = '종료일은 시작일보다 빠를 수 없습니다.';
      return;
    }
    busy = true;
    $('trip-form-error').textContent = '';
    const controls = [...$('trip-form').elements];
    controls.forEach(control => { control.disabled = true; });
    try {
      const trip = await request(editingId ? `/api/trips/${editingId}` : '/api/trips', {
        method: editingId ? 'PUT' : 'POST', body: payload,
      });
      $('trip-dialog').close();
      showDetail(trip);
      await loadTrips();
    } catch (error) { $('trip-form-error').textContent = error.message; }
    finally {
      busy = false;
      controls.forEach(control => { control.disabled = false; });
      syncAccessUI(); // restore overseas/자차 disabled states
    }
  };
  loadTrips();
}
