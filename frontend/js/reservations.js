import { airportPicker } from './airports.js';
// Repeating reservation forms. User values are never interpolated into HTML.
const groundFields = [
  ['label', '열차·노선 (선택, 예: KTX 101)', 'text'],
  ['from_place', '출발역·터미널', 'text', true],
  ['to_place', '도착역·터미널', 'text', true],
  ['departure_at', '출발 날짜·시간', 'datetime-local', true],
  ['arrival_at', '도착 날짜·시간 (선택)', 'datetime-local'],
  ['cost_krw', '예약 비용 (전체 인원 합계·원)', 'number', true, 0],
];
const fields = {
  flight: [
    ['flight_number', '항공편 번호 (선택)', 'text'],
    ['departure_airport', '출발 공항', 'text', true],
    ['arrival_airport', '도착 공항', 'text', true],
    ['departure_at', '출발 현지 날짜·시간', 'datetime-local', true],
    ['departure_timezone', '출발 시간대', 'text', true, 'Asia/Seoul'],
    ['arrival_at', '도착 현지 날짜·시간', 'datetime-local', true],
    ['arrival_timezone', '도착 시간대', 'text', true, 'Asia/Seoul'],
    ['cost_krw', '예약 비용 (전체 인원 합계·원)', 'number', true, 0],
  ],
  stay: [
    ['name', '숙소 이름', 'text', true],
    ['address', '주소 (선택)', 'text'],
    ['check_in', '체크인 현지 날짜·시간', 'datetime-local', true],
    ['check_out', '체크아웃 현지 날짜·시간', 'datetime-local', true],
    ['timezone', '숙소 시간대', 'text', true, 'Asia/Seoul'],
    ['cost_krw', '예약 비용 (전체 숙박 합계·원)', 'number', true, 0],
  ],
  train: groundFields,
  bus: groundFields,
  car: [
    ['from_place', '출발 위치 (예: 집 주소, 서울역)', 'text', true],
    ['to_place', '도착 위치 (예: 숙소, 여행지)', 'text', true],
    ['departure_at', '출발 날짜·시간 (선택)', 'datetime-local'],
    ['arrival_at', '도착 예정 날짜·시간 (선택)', 'datetime-local'],
    ['cost_krw', '예상 비용 (유류·통행료·원)', 'number', true, 0],
  ],
};
const LEGEND = { flight: '항공편', stay: '숙소', train: '기차', bus: '버스', car: '자차 이동' };
const CONTAINER = { flight: 'flight-list', stay: 'stay-list', train: 'ground-list', bus: 'ground-list', car: 'car-list' };

export function addReservation(kind, value = {}) {
  const container = document.getElementById(CONTAINER[kind]);
  if (!container || container.children.length >= 30) return;
  const group = document.createElement('fieldset');
  group.className = 'reservation-card';
  group.dataset.kind = kind;
  const legend = document.createElement('legend');
  legend.textContent = LEGEND[kind];
  group.append(legend);
  const grid = document.createElement('div');
  grid.className = 'date-fields';
  for (const [name, title, type, required = false, fallback = ''] of fields[kind]) {
    const label = document.createElement('label');
    label.textContent = title;
    const input = document.createElement('input');
    input.type = type;
    input.dataset.field = name;
    input.required = required;
    const raw = value[name] ?? fallback;
    input.value = type === 'datetime-local' && raw ? String(raw).slice(0, 16) : raw;
    if (type === 'number') { input.min = '0'; input.max = '1000000000000'; input.step = '1'; }
    if (type === 'text') input.maxLength = name === 'address' ? 3000 : (name === 'flight_number' || name === 'label') ? 50 : 100;
    if (name.includes('timezone')) input.placeholder = '예: Asia/Tokyo, Europe/Paris';
    if (name === 'departure_airport' || name === 'arrival_airport') {
      const zoneField = name === 'departure_airport' ? 'departure_timezone' : 'arrival_timezone';
      label.append(airportPicker(input, () => group.querySelector(`[data-field="${zoneField}"]`)));
    }
    label.append(input);
    grid.append(label);
  }
  group.append(grid);
  const remove = document.createElement('button');
  remove.type = 'button'; remove.className = 'secondary-button'; remove.textContent = '항목 삭제';
  remove.onclick = () => group.remove();
  group.append(remove);
  container.append(group);
}

function readGroup(group) {
  return Object.fromEntries([...group.querySelectorAll('[data-field]')].map(input => [
    input.dataset.field,
    input.type === 'number' ? Number(input.value) : (input.type === 'datetime-local' && !input.value ? null : input.value.trim()),
  ]));
}

// kind: 'flight' | 'stay' | 'ground' (기차·버스 list) | 'car'
export function readReservations(kind) {
  const id = kind === 'ground' ? 'ground-list' : CONTAINER[kind];
  return [...document.getElementById(id).children].map(group => {
    const value = readGroup(group);
    if (kind === 'ground' || kind === 'car') value.mode = group.dataset.kind;
    return value;
  });
}

export function fillReservations(trip) {
  for (const id of ['flight-list', 'stay-list', 'ground-list', 'car-list']) document.getElementById(id).replaceChildren();
  for (const flight of trip?.flights ?? []) addReservation('flight', flight);
  for (const stay of trip?.accommodations ?? []) addReservation('stay', stay);
  for (const segment of trip?.ground ?? []) addReservation(segment.mode, segment);
}
