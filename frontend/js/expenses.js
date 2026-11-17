// Travel ledger UI. Amounts are actual spending; booking costs are shown separately.
import { request } from './api.js';
import { confirmDialog } from './ui.js';

const $ = id => document.getElementById(id);
const won = value => `${Number(value).toLocaleString('ko-KR')}원`;
const categoryLabels = { food: '식비', transport: '교통', stay: '숙박', shopping: '쇼핑', activity: '관광·체험', other: '기타' };
const paymentLabels = { card: '카드', cash: '현금', other: '기타' };
let trip = null, editingId = null, busy = false, revision = 0;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function todayIn(range) {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return today >= range.start_date && today <= range.end_date ? today : range.start_date;
}

function resetForm() {
  editingId = null;
  $('expense-form').reset();
  if (trip) { $('expense-date').min = trip.start_date; $('expense-date').max = trip.end_date; $('expense-date').value = todayIn(trip); }
  $('expense-submit').textContent = '기록하기';
  $('expense-cancel').hidden = true;
  $('expense-error').textContent = '';
}

function renderSummary(data) {
  const stats = $('ledger-stats');
  stats.replaceChildren();
  const tiles = [
    ['실제 지출', won(data.spent_krw)],
    ['예약 비용', won(data.reserved_krw)],
    ['예산 남음', data.remaining_krw === null ? '예산 미설정' : won(data.remaining_krw)],
    ['1인당 합계', won(data.per_person_krw)],
  ];
  for (const [term, value] of tiles) {
    const cell = element('div'); cell.append(element('dt', '', term), element('dd', '', value)); stats.append(cell);
  }
  const meter = $('ledger-meter');
  const percent = data.budget_krw > 0 ? Math.min(100, Math.round(data.total_krw / data.budget_krw * 100)) : 0;
  meter.querySelector('i').style.width = `${percent}%`;
  meter.dataset.over = data.budget_krw > 0 && data.total_krw > data.budget_krw ? 'true' : 'false';
  meter.setAttribute('aria-label', data.budget_krw > 0 ? `예산의 ${percent}% 사용` : '예산 미설정');
  $('ledger-meter-label').textContent = data.budget_krw > 0
    ? `예약 비용 + 실제 지출 ${won(data.total_krw)} / 총예산 ${won(data.budget_krw)} (${percent}%)`
    : '총예산을 설정하면 사용률을 보여드려요. 여행 정보 수정에서 입력할 수 있어요.';

  const categories = $('ledger-categories');
  categories.replaceChildren();
  const max = Math.max(1, ...data.by_category.map(row => row.amount_krw));
  for (const row of data.by_category.filter(row => row.amount_krw > 0)) {
    const line = element('div', 'budget-row');
    const track = element('div', 'budget-track'); const fill = element('i');
    fill.style.width = `${Math.round(row.amount_krw / max * 100)}%`; track.append(fill);
    track.setAttribute('role', 'img'); track.setAttribute('aria-label', `${row.label} ${won(row.amount_krw)}`);
    line.append(element('span', 'budget-name', row.label), track, element('span', 'budget-value', won(row.amount_krw)));
    categories.append(line);
  }
  if (!categories.children.length) categories.append(element('p', 'muted', '아직 지출이 없어요.'));

  const days = $('ledger-days');
  days.replaceChildren();
  for (const row of data.by_date) {
    const li = element('li'); li.append(element('span', '', row.date), element('b', '', won(row.amount_krw))); days.append(li);
  }
  if (!days.children.length) days.append(element('li', 'muted', '날짜별 합계가 여기에 표시돼요.'));
}

function renderList(items) {
  const body = $('expense-items');
  body.replaceChildren();
  $('expense-empty').hidden = items.length > 0;
  for (const item of items) {
    const row = document.createElement('tr');
    const date = element('td', 'schedule-time', item.date.slice(5).replace('-', '/'));
    const info = element('td');
    info.append(element('h3', '', item.title), element('p', '', `${categoryLabels[item.category]} · ${paymentLabels[item.payment]}${item.memo ? ' · ' + item.memo : ''}`));
    const amount = element('td', 'schedule-cost', won(item.amount_krw));
    const manage = element('td'); const actions = element('div', 'trip-actions');
    const edit = element('button', '', '수정'); edit.type = 'button';
    edit.onclick = () => {
      editingId = item.id;
      $('expense-date').value = item.date; $('expense-title').value = item.title; $('expense-category').value = item.category;
      $('expense-amount').value = item.amount_krw; $('expense-payment').value = item.payment; $('expense-memo').value = item.memo;
      $('expense-submit').textContent = '수정 저장'; $('expense-cancel').hidden = false; $('expense-title').focus();
    };
    const remove = element('button', 'danger-button', '삭제'); remove.type = 'button';
    remove.onclick = async () => {
      const id = trip.id;
      if (!(await confirmDialog(`“${item.title}” 지출 기록을 삭제할까요?`)) || trip?.id !== id) return;
      remove.disabled = true;
      try { await request(`/api/trips/${id}/expenses/${item.id}`, { method: 'DELETE' }); if (editingId === item.id) resetForm(); await load(); }
      catch (error) { $('ledger-status').textContent = error.message; remove.disabled = false; }
    };
    actions.append(edit, remove); manage.append(actions);
    row.append(date, info, amount, manage); body.append(row);
  }
}

async function load() {
  if (!trip) return;
  const id = trip.id, generation = ++revision;
  $('ledger-status').textContent = '가계부를 불러오는 중…';
  try {
    const [items, data] = await Promise.all([request(`/api/trips/${id}/expenses`), request(`/api/trips/${id}/expenses/summary`)]);
    if (generation !== revision || trip?.id !== id) return;
    renderList(items); renderSummary(data);
    $('ledger-status').textContent = `${data.count}건 · 실제 지출만 기록합니다. 항공·숙소 예약 비용은 위 요약에 따로 더해져요.`;
  } catch (error) { if (generation === revision) $('ledger-status').textContent = error.message; }
}

export function selectExpenseTrip(selected) {
  if (selected && trip && selected.id === trip.id) { trip = selected; load(); return; } // Same trip: keep the form.
  revision++;
  trip = selected;
  resetForm();
  $('expense-items').replaceChildren();
  if (trip) load();
}

export function initializeExpenses() {
  $('expense-cancel').onclick = resetForm;
  $('expense-form').onsubmit = async event => {
    event.preventDefault();
    if (busy || !trip) return;
    const payload = {
      date: $('expense-date').value, title: $('expense-title').value.trim(), category: $('expense-category').value,
      amount_krw: Number($('expense-amount').value), payment: $('expense-payment').value, memo: $('expense-memo').value.trim(),
    };
    if (!payload.title) { $('expense-error').textContent = '내용을 입력해주세요.'; return; }
    if (!Number.isInteger(payload.amount_krw) || payload.amount_krw < 0) { $('expense-error').textContent = '금액은 0 이상의 정수로 입력해주세요.'; return; }
    const id = trip.id;
    busy = true; $('expense-submit').disabled = true; $('expense-error').textContent = '';
    try {
      await request(editingId ? `/api/trips/${id}/expenses/${editingId}` : `/api/trips/${id}/expenses`, { method: editingId ? 'PUT' : 'POST', body: payload });
      if (trip?.id === id) { const keepDate = payload.date; resetForm(); $('expense-date').value = keepDate; await load(); }
    } catch (error) { $('expense-error').textContent = error.message; }
    finally { busy = false; $('expense-submit').disabled = false; }
  };
}

// Called when the trip's budget/reservations change so the summary stays in sync.
export function refreshExpenses() { if (trip) load(); }
