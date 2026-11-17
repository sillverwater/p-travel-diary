import { request } from './api.js';
import { placeUrl, routeUrl } from './maps.js';
import { confirmDialog, tagOf } from './ui.js';
const $ = id => document.getElementById(id);
let tripId = null, draft = null, sequence = 0, generating = false, applying = false;
let chatSequence = 0;
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
// One sentence per line: break after . ! ? (and closing quotes) when followed by a space.
const lineBySentence = text => text.replace(/([.!?…][”"')]?)[ \t]+(?=\S)/g, '$1\n');
function message(role, content, date, animate = false) {
  if (role === 'assistant') content = lineBySentence(content);
  const article = document.createElement('article'); article.className = `planning-message ${role}`;
  const name = document.createElement('span'); name.className = 'name-tag'; name.textContent = role === 'user' ? '나' : '너굴';
  const when = document.createElement('small'); when.textContent = date;
  const body = document.createElement('p');
  article.append(name, when, body); $('planning-chat').append(article);
  const chat = $('planning-chat');
  if (!animate || reduceMotion.matches) { body.textContent = content; chat.scrollTop = chat.scrollHeight; return; }
  // Typewriter effect for the newest reply; screen readers get the full text at once.
  const full = document.createElement('span'); full.className = 'sr-only'; full.textContent = content;
  const visible = document.createElement('span'); visible.setAttribute('aria-hidden', 'true');
  body.append(full, visible); article.classList.add('typing-text');
  let index = 0;
  const step = () => {
    if (!article.isConnected) return;
    index = Math.min(content.length, index + 2);
    visible.textContent = content.slice(0, index);
    chat.scrollTop = chat.scrollHeight;
    if (index < content.length) setTimeout(step, 18); else article.classList.remove('typing-text');
  };
  step();
}
// Bubble label: the time the message was sent (HH:MM). Older messages saved before this existed show nothing.
function timeOf(entry) {
  return entry.created_at ? entry.created_at.slice(11, 16) : '';
}
const nowClock = () => new Date().toTimeString().slice(0, 5);
async function loadMessages(id, animateLast = false) {
  const token = ++chatSequence;
  try {
    const history = await request(`/api/trips/${id}/planner/messages`);
    if (token !== chatSequence || id !== tripId) return;
    $('planning-chat').replaceChildren();
    if (!history.length) message('assistant', '안녕하세요. 이번 여행을 함께 설계할 여행 플래너 너굴이에요. 하고 싶은 일을 편하게 말씀해 주세요. “밥 먹고 바다 보고 근처 카페에서 쉬고 싶어”처럼 대략적으로 말해도 괜찮아요. 등록된 항공편·숙소와 취향을 참고해 동선과 시간을 정리해 드리고, 예약 시간과 맞지 않는 부분이 있으면 먼저 여쭤볼게요.', '시작하기');
    history.forEach((entry, index) => message(entry.role, entry.content, timeOf(entry),
      animateLast && index === history.length - 1 && entry.role === 'assistant'));
  } catch (error) { if (id === tripId) $('ai-status').textContent = error.message; }
}
function showTyping() {
  hideTyping();
  const article = document.createElement('article'); article.className = 'planning-message assistant typing'; article.id = 'typing-indicator';
  const name = document.createElement('span'); name.className = 'name-tag'; name.textContent = '너굴';
  const dots = document.createElement('p'); dots.setAttribute('role', 'status');
  const label = document.createElement('span'); label.className = 'typing-label'; label.textContent = '답변을 준비하고 있어요';
  dots.append(label, ...[0, 1, 2].map(() => { const dot = document.createElement('i'); dot.setAttribute('aria-hidden', 'true'); return dot; }));
  article.append(name, dots); $('planning-chat').append(article);
  $('planning-chat').scrollTop = $('planning-chat').scrollHeight;
}
function hideTyping() { $('typing-indicator')?.remove(); }
function clearPreview() {
  draft = null; $('ai-preview').hidden = true; $('ai-apply').disabled = true;
}
export function selectPlannerTrip(trip) {
  const next = trip?.id ?? null;
  if (tripId !== next) {
    tripId = next; sequence++; chatSequence++; clearPreview(); $('ai-status').textContent = '';
    $('planning-chat').replaceChildren(); $('ai-request').value = '';
    if (tripId) loadMessages(tripId);
  }
}
// ---------- start/end time from fixed travel (same rules as the server) ----------
const ARRIVE_BUFFER = { flight: 40, train: 15, bus: 15, car: 10 };
const DEPART_BUFFER = { flight: 90, train: 30, bus: 30, car: 0 };
const DEFAULT_START = '09:00', DEFAULT_END = '23:00';
const toMin = hhmm => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const toClock = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const roundUp10 = m => Math.ceil(m / 10) * 10, roundDown10 = m => Math.floor(m / 10) * 10;
function dayWindow(trip, day) {
  const legs = [
    ...(trip.flights ?? []).map(f => ({ kind: 'flight', dep: f.departure_at ?? '', arr: f.arrival_at ?? '' })),
    ...(trip.ground ?? []).map(g => ({ kind: g.mode, dep: g.departure_at ?? '', arr: g.arrival_at ?? '' })),
  ].filter(leg => leg.dep || leg.arr).sort((a, b) => String(a.dep || a.arr).localeCompare(String(b.dep || b.arr)));
  let start = null, end = null;
  if (!legs.length) return { start, end };
  const final = legs.at(-1);
  const finalIsHome = legs.length >= 2 || (String(final.dep).slice(0, 10) === trip.end_date && trip.end_date !== trip.start_date);
  for (const leg of legs) {
    const dep = String(leg.dep || ''), arr = String(leg.arr || '');
    if (leg === final && finalIsHome) {
      if (dep.slice(0, 10) === day) {
        const extra = leg.kind === 'flight' && trip.region === 'overseas' ? 60 : 0;
        const leave = toMin(dep.slice(11, 16)) - DEPART_BUFFER[leg.kind] - extra;
        end = end === null ? leave : Math.min(end, leave);
      }
      continue;
    }
    let ready = null;
    if (arr.slice(0, 10) === day) ready = toMin(arr.slice(11, 16)) + ARRIVE_BUFFER[leg.kind];
    else if (!arr && dep.slice(0, 10) === day) ready = toMin(dep.slice(11, 16)) + 60 + ARRIVE_BUFFER[leg.kind];
    if (ready !== null) start = start === null ? ready : Math.max(start, ready);
  }
  return {
    start: start === null ? null : toClock(Math.min(roundUp10(start), 23 * 60 + 50)),
    end: end === null ? null : toClock(Math.max(roundDown10(end), 0)),
  };
}
let windowKey = '';
// Fill 시작/종료 when the selected day changes; manual edits stay until another day is picked.
function applyDayWindow(trip, day) {
  const key = `${trip?.id}|${day}|${JSON.stringify([trip?.flights, trip?.ground])}`;
  if (!trip || !day || key === windowKey) return;
  windowKey = key;
  const { start, end } = dayWindow(trip, day);
  $('ai-start').value = start ?? DEFAULT_START;
  $('ai-end').value = end ?? DEFAULT_END;
  const notes = [];
  if (start) notes.push(`도착 후 ${start} 시작`);
  if (end) notes.push(`출발 전 ${end} 종료`);
  $('ai-start').title = start ? '이동 도착 시각 + 여유 시간으로 자동 설정' : '';
  $('ai-end').title = end ? '돌아가는 편 출발 시각 − 여유 시간으로 자동 설정' : '';
  const box = document.querySelector('.chat-conditions');
  if (box) box.dataset.auto = notes.join(' · ');
}

// Context-aware prompt suggestions for the selected day. Clicking fills the composer (does not send).
export function updateSuggestions({ trip, day, dayNumber, totalDays, dayItems }) {
  applyDayWindow(trip, day);
  const box = $('prompt-chips');
  if (!box) return;
  box.replaceChildren();
  if (!trip || !day) return;
  const dest = trip.destination;
  const hhmm = value => value.slice(11, 16);
  const arrival = trip.flights.find(f => f.arrival_at.slice(0, 10) === day && dayNumber < totalDays);
  const departure = trip.flights.find(f => f.departure_at.slice(0, 10) === day && dayNumber > 1);
  const stay = trip.accommodations.find(s => s.check_in.slice(0, 10) <= day && day <= s.check_out.slice(0, 10));
  const stayName = stay ? stay.name : '숙소';
  const list = [];
  if (arrival) list.push({ text: `${arrival.arrival_airport}에 ${hhmm(arrival.arrival_at)} 도착하면 ${stayName}에 짐 먼저 맡기고, 근처에서 첫 끼 먹고 가볍게 산책하고 싶어.` });
  if (departure) list.push({ text: `${hhmm(departure.departure_at)} 비행기라서 그 전까지 ${dest}에서 가볍게 기념품 쇼핑하고 점심 먹은 뒤 ${departure.departure_airport}으로 여유 있게 가고 싶어.` });
  if (!arrival && !departure) list.push({ text: `${dest} 대표 관광지 두 곳이랑 현지 음식 맛집으로 하루를 짜줘. 너무 빡빡하지 않게!` });
  list.push({ text: stay ? `${stayName}에서 걸어서 15분 안쪽에 있는 분위기 좋은 카페에서 쉬고 싶어.` : `${dest}에서 분위기 좋은 카페 한 곳 넣어줘.` });
  if (trip.must_visit_places?.length) list.push({ text: `꼭 가고 싶은 ${trip.must_visit_places.slice(0, 2).join(', ')} 넣어서 동선 짜줘.` });
  if (dayItems.length) {
    list.push({ text: '지금 일정 사이 빈 시간에 디저트 카페나 산책 코스 하나 넣어줘.' });
    list.push({ text: '오늘 일정 전체를 더 여유 있게 다시 짜줘. 오후에 숙소에서 1시간 쉬는 시간도 넣어줘.', mode: 'replace' });
  } else {
    list.push({ text: '비가 와도 괜찮게 실내 위주로 하루를 짜줘.' });
  }
  for (const item of list.slice(0, 5)) {
    const chip = document.createElement('button');
    chip.type = 'button'; chip.className = 'prompt-chip'; chip.textContent = item.text;
    if (item.mode === 'replace') chip.dataset.mode = 'replace';
    chip.onclick = () => {
      const box = $('ai-request');
      box.value = box.value.trim() ? `${box.value.trim()} ${item.text}` : item.text;
      $('ai-mode').value = item.mode ?? 'auto';
      box.dispatchEvent(new Event('input'));
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    };
    box.append(chip);
  }
}

export function initializePlanner(reload) {
  $('ai-generate').onclick = async () => {
    if (!tripId || generating) return;
    const prompt = $('ai-request').value.trim();
    if (!prompt) { $('ai-status').textContent = '메시지를 입력해주세요.'; return; }
    const id = tripId, token = ++sequence;
    clearPreview(); generating = true; $('ai-generate').disabled = true;
    $('ai-status').textContent = '장소 후보와 시간 배분을 생각하고 있어요…';
    // Show my message in the chat right away; the server history replaces it when the reply arrives.
    message('user', prompt, nowClock());
    const pending = $('planning-chat').lastElementChild;
    $('ai-request').value = ''; $('ai-request').style.height = '';
    showTyping();
    try {
      const result = await request(`/api/trips/${id}/planner/generate`, { method: 'POST', body: {
        date: $('itinerary-day').value, prompt,
        start_time: $('ai-start').value, end_time: $('ai-end').value,
        travel_mode: $('route-mode').value, mode: $('ai-mode').value,
      } });
      if (token !== sequence || id !== tripId) return;
      await loadMessages(id, true);
      if (token !== sequence || id !== tripId) return;
      if (result.kind === 'clarification') {
        clearPreview(); $('ai-status').textContent = '위 질문에 답해주시면 조건을 확인하고 일정을 이어서 구성할게요.';
        $('ai-request').focus(); return;
      }
      draft = result;
      $('ai-summary').textContent = `${result.date} · ${result.mode === 'replace' ? '[이 날 일정 교체] ' : ''}${result.summary}`;
      $('ai-assumptions').replaceChildren();
      for (const text of result.assumptions) { const li = document.createElement('li'); li.textContent = text; $('ai-assumptions').append(li); }
      $('ai-stops').replaceChildren();
      for (const item of result.items) {
        const card = document.createElement('article'); card.className = 'day-item';
        const time = document.createElement('strong'); time.textContent = item.time.slice(0, 5);
        const body = document.createElement('div'); const title = document.createElement('h3'); title.textContent = `${tagOf(item)} ${item.category === 'transfer' ? '이동' : item.title}`;
        const location = document.createElement('p'); location.textContent = `${item.location} · 예상 ${item.estimated_cost_krw.toLocaleString('ko-KR')}원`;
        const notes = document.createElement('p'); notes.className = 'draft-notes';
        notes.textContent = item.notes.split('\n참고 블로그:')[0];
        let url = placeUrl(item.location || item.title), label = '카카오맵에서 확인 ↗';
        if (item.category === 'transfer') {
          const at = result.items.indexOf(item);
          const from = [...result.items.slice(0, at)].reverse().find(other => other.category !== 'transfer');
          const to = result.items.slice(at + 1).find(other => other.category !== 'transfer');
          url = from && to ? routeUrl(from.location, to.location, $('route-mode').value) : '';
          label = '카카오맵 길찾기 ↗';
        }
        const a = document.createElement('a'); a.href = url || '#'; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = label; a.className = 'secondary-button';
        if (!url) a.hidden = true;
        body.append(title, location, notes);
        if (item.sources?.length) {
          const list = document.createElement('ul'); list.className = 'draft-sources';
          for (const source of item.sources) {
            if (!/^https?:\/\//.test(source.url)) continue;
            const li = document.createElement('li'); const link = document.createElement('a');
            link.href = source.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
            link.textContent = source.title === '카카오맵 장소 정보' ? source.title : `블로그: ${source.title}`; li.append(link); list.append(li);
          }
          if (list.children.length) body.append(list);
        }
        body.append(a); card.append(time, body); $('ai-stops').append(card);
      }
      const total = result.items.reduce((sum, item) => sum + item.estimated_cost_krw, 0);
      $('ai-total').textContent = `추가될 일정 ${result.items.length}개 · 예상 비용 합계 ${total.toLocaleString('ko-KR')}원 (실제 지출 아님)`;
      $('ai-preview').hidden = false; $('ai-apply').disabled = false;
      $('ai-preview').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      $('ai-status').textContent = result.mode === 'replace'
        ? '기존 일정의 흐름을 고친 초안이에요. 담으면 이 날 일정이 이 초안으로 바뀝니다(항공 일정은 유지).'
        : '초안입니다. 장소와 시간을 확인한 뒤 담아주세요. 기존 일정은 유지됩니다.';
    } catch (error) {
      if (token === sequence) {
        $('ai-status').textContent = error.message || 'AI 요청을 처리하지 못했습니다.';
        // Not saved on the server: take the bubble back out and return the text to the input box.
        pending?.remove();
        if (id === tripId && !$('ai-request').value) $('ai-request').value = prompt;
      }
    }
    finally { generating = false; $('ai-generate').disabled = false; hideTyping(); }
  };
  $('ai-apply').onclick = async () => {
    if (!draft || !tripId || applying) return;
    const selected = draft, id = tripId;
    applying = true; $('ai-apply').disabled = true;
    const question = selected.mode === 'replace'
      ? `${selected.date}의 기존 일정 ${selected.replace_ids?.length ?? 0}개를 지우고 새 일정 ${selected.items.length}개로 바꿀까요? 지운 일정은 되돌릴 수 없어요.`
      : `${selected.date}에 ${selected.items.length}개 일정을 추가할까요? 기존 일정은 삭제하지 않습니다.`;
    if (!(await confirmDialog(question))) {
      applying = false; if (draft === selected) $('ai-apply').disabled = false; return;
    }
    if (draft !== selected || tripId !== id) { applying = false; return; }
    try {
      const result = await request(`/api/trips/${id}/planner/drafts/${selected.id}/apply`, { method: 'POST' });
      if (tripId === id) {
        clearPreview(); $('itinerary-day').value = result.date;
        $('ai-status').textContent = result.replaced
          ? `기존 일정 ${result.replaced}개를 새 일정 ${result.added}개로 바꿨습니다.`
          : `${result.added}개 일정을 저장했습니다. 일정별 수정 버튼으로 조정할 수 있습니다.`;
        await reload();
      }
    } catch (error) {
      if (tripId === id) { $('ai-status').textContent = error.message; $('ai-apply').disabled = false; }
    } finally { applying = false; }
  };
  $('ai-discard').onclick = () => { clearPreview(); $('ai-status').textContent = '초안을 닫았습니다. 저장된 일정은 변경되지 않았습니다.'; };
  const grow = () => { const box = $('ai-request'); box.style.height = 'auto'; box.style.height = `${Math.min(box.scrollHeight, 180)}px`; };
  $('ai-request').addEventListener('input', grow);
  $('ai-request').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault(); $('ai-generate').click();
    }
  });
}
