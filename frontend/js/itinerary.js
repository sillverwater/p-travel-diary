import { request } from './api.js';
import { placeUrl, routeUrl } from './maps.js';
import { initializePlanner, selectPlannerTrip, updateSuggestions } from './planner.js';
import { confirmDialog, tagOf } from './ui.js';

const $ = id => document.getElementById(id);
const categories = { visit: '관광', flight: '항공', stay: '숙소', food: '식사', transfer: '이동', other: '기타' };

let trip = null, items = [], editingId = null, busy = false, revision = 0;
const endpoint = () => `/api/trips/${trip.id}/itinerary`;
const won = value => `${Number(value).toLocaleString('ko-KR')}원`;
let inlineRow = null;

function editableText(text, label, edit) {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'cell-edit-button';
  button.textContent = text; button.title = `${label} 수정`;
  button.setAttribute('aria-label', `${label} 수정: ${text}`);
  button.onclick = edit;
  return button;
}

function editRow(row, item, focusField = 'title') {
  if (inlineRow && inlineRow !== row) {
    error(new Error('현재 편집 중인 행을 먼저 저장하거나 취소해주세요.')); return;
  }
  if (inlineRow === row) return;
  inlineRow = row;
  row.classList.add('editing-row');
  const id = trip.id, url = `${endpoint()}/${item.id}`;
  const timeCell = document.createElement('td');
  const infoCell = document.createElement('td'); infoCell.colSpan = 3;
  const costCell = document.createElement('td');
  const actionCell = document.createElement('td');
  const controls = {};
  const add = (parent, name, labelText, type, value, maxLength) => {
    const label = document.createElement('label'); label.className = 'inline-field'; label.textContent = labelText;
    const input = document.createElement(type === 'textarea' ? 'textarea' : 'input');
    if (type !== 'textarea') input.type = type;
    input.value = value; if (maxLength) input.maxLength = maxLength;
    input.required = ['date', 'time', 'title', 'estimated_cost_krw'].includes(name);
    controls[name] = input; label.append(input); parent.append(label); return input;
  };
  const day = add(timeCell, 'date', '날짜', 'date', item.date);
  day.min = trip.start_date; day.max = trip.end_date;
  add(timeCell, 'time', '시간', 'time', item.time.slice(0, 5));
  add(infoCell, 'title', '일정 이름', 'text', item.title, 100);
  add(infoCell, 'location', '장소·주소', 'text', item.location, 3000);
  const categoryLabel = document.createElement('label'); categoryLabel.className = 'inline-field'; categoryLabel.textContent = '분류';
  const category = document.createElement('select');
  for (const [value, title] of Object.entries(categories)) category.add(new Option(title, value));
  category.value = item.category; controls.category = category; categoryLabel.append(category); infoCell.append(categoryLabel);
  add(infoCell, 'notes', '메모', 'textarea', item.notes, 3000);
  const cost = add(costCell, 'estimated_cost_krw', '예상 비용 (원)', 'number', item.estimated_cost_krw);
  cost.min = '0'; cost.max = '1000000000000'; cost.step = '1';
  const actions = document.createElement('div'); actions.className = 'trip-actions';
  const save = document.createElement('button'); save.type = 'button'; save.textContent = '저장';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '취소';
  const status = document.createElement('p'); status.className = 'form-error'; status.setAttribute('role', 'alert');
  let saving = false;
  cancel.onclick = () => { if (!saving) { inlineRow = null; render(); } };
  save.onclick = async () => {
    if (saving) return;
    for (const control of Object.values(controls)) if (!control.reportValidity()) return;
    if (!controls.title.value.trim()) { status.textContent = '일정 이름을 입력해주세요.'; controls.title.focus(); return; }
    const payload = Object.fromEntries(Object.entries(controls).map(([key, input]) => [key, key === 'estimated_cost_krw' ? Number(input.value) : input.value.trim()]));
    saving = true; status.textContent = '저장 중…';
    [...Object.values(controls), save, cancel].forEach(control => control.disabled = true);
    try {
      await request(url, { method: 'PUT', body: payload });
      if (trip?.id === id) { inlineRow = null; $('itinerary-day').value = payload.date; await load(); }
    } catch (e) { status.textContent = e.message || '저장하지 못했습니다. 입력은 유지됩니다.'; }
    finally { saving = false; [...Object.values(controls), save, cancel].forEach(control => control.disabled = false); }
  };
  row.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !saving) { event.preventDefault(); cancel.click(); }
  });
  actions.append(save, cancel); actionCell.append(actions, status);
  row.replaceChildren(timeCell, infoCell, costCell, actionCell);
  controls[focusField]?.focus();
}
function error(error) { $('itinerary-status').textContent = error.message || '일정을 불러오지 못했습니다.'; }
function link(text, url) {
  const a = document.createElement('a'); a.textContent = text; a.href = url;
  a.target = '_blank'; a.rel = 'noopener noreferrer'; a.className = 'secondary-button'; return a;
}
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
// Transfer rows: "이동(대중교통 30분): A → B" → title "이동: A → B", remark "대중교통 30분".
function remarkOf(item) {
  if (item.category !== 'transfer') return '';
  const match = item.title.match(/^이동\(([^)]+)\)/);
  if (match) return match[1];
  return (item.notes || '').split('\n')[0].replace(/^\[[^\]]+\]\s*/, '').slice(0, 30);
}
function displayTitle(item) {
  // Transfer rows: the place column already shows "A → B", so the title is just "이동".
  // Older AI rows were saved as "활동 · 가게명"; the place column already has the name.
  return item.category === 'transfer' ? '이동' : item.title.split(' · ')[0];
}
function tripDays() {
  const days = [];
  for (let d = new Date(`${trip.start_date}T00:00:00`); days.length < 60; d.setDate(d.getDate() + 1)) {
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (value > trip.end_date) break;
    days.push({ value, label: `${value.slice(5).replace('-', '/')} (${WEEKDAYS[d.getDay()]})` });
  }
  return days;
}
let viewAll = false; // "전체" tab: show every day; AI still targets the last selected day.
let shown = { rows: [], dayIndex: {}, heading: '' }; // what the table currently shows (for image export)
function makeTab(titleText, subText, pressed, onClick) {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'day-tab';
  const title = document.createElement('b'); title.textContent = titleText;
  const sub = document.createElement('small'); sub.textContent = subText;
  button.append(title, sub); button.setAttribute('aria-pressed', String(pressed)); button.onclick = onClick;
  return button;
}
function busyEditing() {
  if (!inlineRow) return false;
  error(new Error('편집 중인 행을 먼저 저장하거나 취소해주세요.'));
  return true;
}
function renderDayTabs(day) {
  const box = $('day-tabs'); box.replaceChildren();
  const days = tripDays();
  box.append(makeTab('전체', `${days.length}일 · ${items.length}개`, viewAll, () => {
    if (viewAll || busyEditing()) return;
    viewAll = true; render();
  }));
  if (viewAll) $('day-heading').textContent = '전체 일정';
  days.forEach((entry, index) => {
    const count = items.filter(item => item.date === entry.value).length;
    const selected = entry.value === day;
    box.append(makeTab(`${index + 1}일차`, `${entry.label}${count ? ` · ${count}개` : ''}`, !viewAll && selected, () => {
      if (selected) {
        if (viewAll && !busyEditing()) { viewAll = false; render(); }
        return;
      }
      if (viewAll && busyEditing()) return;
      viewAll = false;
      $('itinerary-day').value = entry.value;
      $('itinerary-day').dispatchEvent(new Event('change'));
    }));
    if (selected) {
      $('ai-target').textContent = `${index + 1}일차 · ${entry.label}에 반영`;
      if (!viewAll) $('day-heading').textContent = `${index + 1}일차 · ${entry.label}`;
    }
  });
}
function render() {
  inlineRow = null;
  $('itinerary-day').dataset.previous = $('itinerary-day').value;
  $('route-mode').dataset.previous = $('route-mode').value;
  const day = $('itinerary-day').value;
  const daily = viewAll ? [...items].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)) : items.filter(item => item.date === day);
  $('day-items').replaceChildren();
  $('day-total').textContent = `${viewAll ? '전체' : '이 날'} 일정 예상 비용 ${won(daily.reduce((sum, item) => sum + item.estimated_cost_krw, 0))} · 실제 지출과 별개`;
  $('day-empty').hidden = daily.length > 0;
  renderDayTabs(day);
  const dayIndex = Object.fromEntries(tripDays().map((entry, index) => [entry.value, { index, label: entry.label }]));
  shown = { rows: daily, dayIndex, heading: viewAll ? '전체 일정' : $('day-heading').textContent };
  updateSuggestions({ trip, day, dayNumber: (dayIndex[day]?.index ?? 0) + 1, totalDays: Object.keys(dayIndex).length,
    dayItems: items.filter(item => item.date === day) });
  let groupDate = null, counter = 0;
  // For a transfer row: the nearest non-transfer stops before/after it on the same day.
  const isStop = other => other.category !== 'transfer' && other.location.trim();
  const neighbour = (position, step) => {
    for (let i = position + step; i >= 0 && i < daily.length; i += step) {
      if (daily[i].date !== daily[position].date) return null;
      if (isStop(daily[i])) return daily[i];
    }
    return null;
  };
  daily.forEach((item, position) => {
    if (viewAll && item.date !== groupDate) {
      // Day divider row in the "전체" view.
      groupDate = item.date; counter = 0;
      const divider = document.createElement('tr'); divider.className = 'day-group';
      const cell = document.createElement('th'); cell.colSpan = 6; cell.scope = 'colgroup';
      const info = dayIndex[item.date];
      cell.textContent = info ? `${info.index + 1}일차 · ${info.label}` : item.date;
      divider.append(cell); $('day-items').append(divider);
    }
    const index = counter++;
    const row = document.createElement('tr');
    const time = document.createElement('td'); time.className = 'schedule-time';
    const track = document.createElement('span'); track.className = 'track-no'; track.setAttribute('aria-hidden', 'true');
    track.textContent = String(index + 1).padStart(2, '0');
    time.append(track,editableText(item.time.slice(0, 5), '시간', () => editRow(row, item, 'time')));
    const info = document.createElement('td'); info.className = 'schedule-info';
    const chip = document.createElement('span'); chip.className = `cat-chip cat-${item.category}`; chip.textContent = tagOf(item);
    const titleButton = editableText(displayTitle(item), '일정 이름', () => editRow(row, item));
    titleButton.classList.add('row-title'); titleButton.title = displayTitle(item);
    const line = document.createElement('div'); line.className = 'row-line';
    line.append(chip, titleButton);
    info.append(line);
    const place = document.createElement('td'); place.className = 'schedule-place';
    const placeLine = document.createElement('div'); placeLine.className = 'row-line';
    const shortName = item.location ? item.location.split(',')[0].trim() : '위치 입력';
    const placeButton = editableText(shortName, '장소·주소', () => editRow(row, item, 'location'));
    placeButton.classList.add('row-title'); placeButton.title = item.location || '';
    placeLine.append(placeButton);
    place.append(placeLine);
    const actions = document.createElement('div'); actions.className = 'trip-actions';
    const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = '수정'; edit.onclick = () => openEditor(item);
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '삭제';
    remove.onclick = async () => {
      const url = `${endpoint()}/${item.id}`; const id = trip.id; remove.disabled = true;
      if (!(await confirmDialog('이 일정을 삭제할까요?')) || trip?.id !== id) { remove.disabled = false; return; }
      try { await request(url, { method: 'DELETE' }); if (trip?.id === id) await load(); }
      catch (e) { error(e); } finally { remove.disabled = false; }
    };
    remove.classList.add('danger-button');
    actions.append(edit, remove);
    if (item.category === 'transfer') {
      // Directions only on transfer rows: previous stop → next stop.
      const from = neighbour(position, -1), to = neighbour(position, 1);
      if (from && to) {
        const way = link('길찾기', routeUrl(from.location, to.location, $('route-mode').value));
        way.className = 'map-link route'; way.title = `${from.location.split(',')[0]} → ${to.location.split(',')[0]} 카카오맵 길찾기`;
        placeLine.append(way);
      }
    } else if (item.location) {
      const map = link('지도', placeUrl(item.location)); map.className = 'map-link'; map.title = `${item.location} 카카오맵에서 보기`;
      placeLine.append(map);
    }
    const cost = document.createElement('td'); cost.className = 'schedule-cost';
    cost.append(editableText(won(item.estimated_cost_krw), '예상 비용', () => editRow(row, item, 'estimated_cost_krw')));
    const manage = document.createElement('td'); manage.append(actions);
    const remark = document.createElement('td'); remark.className = 'schedule-remark'; remark.textContent = remarkOf(item);
    row.append(time, info, place, remark, cost, manage); $('day-items').append(row);
  });

}
// Draw the visible schedule into a canvas and download it as PNG (no external libraries).
async function exportImage() {
  if (!trip) return;
  if (!shown.rows.length) { error(new Error('저장할 일정이 없어요.')); return; }
  try { await document.fonts.ready; } catch { /* fonts optional */ }
  const display = getComputedStyle(document.body).getPropertyValue('--font-display').trim() || 'sans-serif';
  const body = getComputedStyle(document.body).fontFamily || 'sans-serif';
  const W = 1200, PAD = 40, ROW = 44, GROUP = 38, HEAD = 128, TH = 42, FOOT = 64;
  const cols = [['시간', 90], ['분류', 90], ['일정', 380], ['장소', 280], ['비고', 150], ['예상 비용', 130]];
  const groups = shown.rows.reduce((set, item) => set.add(item.date), new Set()).size;
  const isAll = shown.heading === '전체 일정';
  const H = HEAD + TH + shown.rows.length * ROW + (isAll ? groups * GROUP : 0) + FOOT + PAD;
  const scale = 2;
  const canvas = document.createElement('canvas'); canvas.width = W * scale; canvas.height = H * scale;
  const ctx = canvas.getContext('2d'); ctx.scale(scale, scale);
  const fit = (text, width) => {
    let value = String(text);
    if (ctx.measureText(value).width <= width) return value;
    while (value.length && ctx.measureText(value + '…').width > width) value = value.slice(0, -1);
    return value + '…';
  };
  ctx.fillStyle = '#fffdf4'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#56a37f'; ctx.fillRect(0, 0, W, HEAD - 20);
  ctx.fillStyle = '#ffffff'; ctx.font = `30px ${display}`; ctx.textBaseline = 'middle';
  ctx.fillText(fit(trip.title, W - PAD * 2), PAD, 42);
  ctx.font = `17px ${body}`;
  ctx.fillText(fit(`${trip.destination} · ${trip.start_date} ~ ${trip.end_date} · ${shown.heading}`, W - PAD * 2), PAD, 80);
  let y = HEAD;
  ctx.fillStyle = '#d8f1e4'; ctx.fillRect(PAD, y, W - PAD * 2, TH);
  ctx.fillStyle = '#1f5c40'; ctx.font = `16px ${display}`;
  let x = PAD;
  for (const [name, width] of cols) { ctx.fillText(name, x + 12, y + TH / 2); x += width; }
  y += TH;
  let group = null, stripe = 0;
  for (const item of shown.rows) {
    if (isAll && item.date !== group) {
      group = item.date;
      const info = shown.dayIndex[item.date];
      ctx.fillStyle = '#bfe7d2'; ctx.fillRect(PAD, y, W - PAD * 2, GROUP);
      ctx.fillStyle = '#1f5c40'; ctx.font = `16px ${display}`;
      ctx.fillText(info ? `${info.index + 1}일차 · ${info.label}` : item.date, PAD + 12, y + GROUP / 2);
      y += GROUP;
    }
    ctx.fillStyle = stripe++ % 2 ? '#fff8e4' : '#ffffff'; ctx.fillRect(PAD, y, W - PAD * 2, ROW);
    ctx.strokeStyle = '#efe4c6'; ctx.beginPath(); ctx.moveTo(PAD, y + ROW); ctx.lineTo(W - PAD, y + ROW); ctx.stroke();
    const cells = [item.time.slice(0, 5), categories[item.category], displayTitle(item), item.location ? item.location.split(',')[0] : '-', remarkOf(item) || '', won(item.estimated_cost_krw)];
    x = PAD;
    cells.forEach((text, index) => {
      const [, width] = cols[index];
      ctx.fillStyle = index === 1 ? '#2d7a52' : '#3f3124';
      ctx.font = `${index === 2 ? 'bold ' : ''}15px ${index === 0 || index === 1 ? display : body}`;
      const value = fit(text, width - 24);
      const offset = index === 5 ? width - 12 - ctx.measureText(value).width : 12;
      ctx.fillText(value, x + offset, y + ROW / 2);
      x += width;
    });
    y += ROW;
  }
  const total = shown.rows.reduce((sum, item) => sum + item.estimated_cost_krw, 0);
  ctx.fillStyle = '#2d7a52'; ctx.font = `17px ${display}`;
  ctx.fillText(`예상 비용 합계 ${won(total)}`, PAD, y + 34);
  ctx.fillStyle = '#8a7863'; ctx.font = `13px ${body}`;
  const stamp = `P의 여행수첩 · ${new Date().toLocaleDateString('ko-KR')} 저장`;
  ctx.fillText(stamp, W - PAD - ctx.measureText(stamp).width, y + 34);
  canvas.toBlob(blob => {
    if (!blob) { error(new Error('이미지를 만들지 못했어요.')); return; }
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${trip.title}_${shown.heading}`.replace(/[\\/:*?"<>|\s]+/g, '_') + '.png';
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 2000);
  }, 'image/png');
}
function reservationOptions() {
  const select = $('item-reservation'); select.replaceChildren(new Option('직접 입력', ''));
  const add = (label, value) => { const option = new Option(label, select.options.length.toString()); option.reservation = value; select.add(option); };
  for (const f of trip.flights) {
    add(`${f.flight_number || '항공편'} 출발 · ${f.departure_airport}`, { date: f.departure_at.slice(0, 10), time: f.departure_at.slice(11, 16), title: `${f.flight_number} 항공편 출발`.trim(), location: f.departure_airport, category: 'flight' });
    add(`${f.flight_number || '항공편'} 도착 · ${f.arrival_airport}`, { date: f.arrival_at.slice(0, 10), time: f.arrival_at.slice(11, 16), title: `${f.flight_number} 항공편 도착`.trim(), location: f.arrival_airport, category: 'flight' });
  }
  for (const s of trip.accommodations) {
    for (const [key, label] of [['check_in', '체크인'], ['check_out', '체크아웃']]) {
      add(`${s.name} ${label}`, { date: s[key].slice(0, 10), time: s[key].slice(11, 16), title: `${s.name} ${label}`, location: s.address ? `${s.name}, ${s.address}` : `${s.name}, ${trip.destination}`, category: 'stay' });
    }
  }
}
function openEditor(item = null) {
  if (!trip) return;
  editingId = item?.id ?? null; $('item-form').reset();
  $('item-form-title').textContent = item ? '일정 수정' : '일정 추가';
  $('item-date').min = trip.start_date; $('item-date').max = trip.end_date;
  $('item-date').value = item?.date ?? $('itinerary-day').value;
  $('item-time').value = item?.time.slice(0, 5) ?? '09:00';
  $('item-title').value = item?.title ?? ''; $('item-location').value = item?.location ?? '';
  $('item-category').value = item?.category ?? 'visit'; $('item-cost').value = item?.estimated_cost_krw ?? 0;
  $('item-notes').value = item?.notes ?? ''; $('item-error').textContent = '';
  reservationOptions(); $('item-dialog').showModal();
}
async function load() {
  if (!trip) return;
  if (inlineRow && !(await confirmDialog('저장하지 않은 행 수정 내용을 취소하고 일정을 새로 불러올까요?'))) return;
  if (!trip) return;
  const generation = ++revision; const url = endpoint();
  $('itinerary-status').textContent = '일정을 불러오는 중…';
  try {
    const result = await request(url);
    if (generation !== revision) return;
    items = result; render(); $('itinerary-status').textContent = '시간순으로 표시됩니다. 시각은 각 장소의 현지 시각이며, 지도는 별도 창에서 열립니다.';
  } catch (e) { if (generation === revision) error(e); }
}
export function selectItineraryTrip(selected) {
  selectPlannerTrip(selected);
  revision++; trip = selected; items = []; viewAll = false;
  $('itinerary-section').hidden = !trip;
  if (!trip) return;
  const day = $('itinerary-day'); day.min = trip.start_date; day.max = trip.end_date;
  if (!day.value || day.value < day.min || day.value > day.max) day.value = day.min;
  render(); load();
}
export function initializeItinerary() {
  initializePlanner(load);
  for (const id of ['itinerary-day', 'route-mode']) {
    $(id).onchange = async () => {
      if (inlineRow && !(await confirmDialog('저장하지 않은 행 수정 내용을 취소하고 전환할까요?'))) {
        $(id).value = $(id).dataset.previous; return;
      }
      render();
    };
  }
  $('add-item').onclick = () => openEditor(); $('reload-items').onclick = load;
  $('export-image').onclick = () => exportImage();
  $('item-cancel').onclick = () => { if (!busy) $('item-dialog').close(); };
  $('item-dialog').addEventListener('cancel', e => { if (busy) e.preventDefault(); });
  $('item-reservation').onchange = () => {
    const value = $('item-reservation').selectedOptions[0]?.reservation;
    if (!value) return;
    for (const [key, val] of Object.entries(value)) $(`item-${key}`).value = val;
    $('item-cost').value = 0; // Prevent duplicating flight/stay booking costs.
  };
  $('item-form').onsubmit = async e => {
    e.preventDefault(); if (busy || !trip) return;
    const payload = { date: $('item-date').value, time: $('item-time').value, title: $('item-title').value.trim(), location: $('item-location').value.trim(), category: $('item-category').value, estimated_cost_krw: Number($('item-cost').value), notes: $('item-notes').value.trim() };
    const id = trip.id, url = editingId ? `${endpoint()}/${editingId}` : endpoint();
    busy = true; const controls = [...$('item-form').elements]; controls.forEach(c => c.disabled = true); $('item-error').textContent = '';
    try {
      await request(url, { method: editingId ? 'PUT' : 'POST', body: payload });
      $('item-dialog').close();
      if (trip?.id === id) { $('itinerary-day').value = payload.date; await load(); }
    } catch (e) { $('item-error').textContent = e.message; }
    finally { busy = false; controls.forEach(c => c.disabled = false); }
  };
}
