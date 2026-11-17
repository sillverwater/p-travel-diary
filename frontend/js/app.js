import { getHealth } from './api.js';
import { initializeTrips } from './trips.js';
import { initializeUi } from './ui.js';

const themeButton = document.querySelector('#theme-toggle');
const status = document.querySelector('#server-status');
const healthMessage = document.querySelector('#health-message');
const themeKey = 'travel-planner-theme';

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const dark = theme === 'dark';
  const label = themeButton.querySelector('.theme-label');
  if (label) label.textContent = dark ? '☀️' : '🌙';
  themeButton.setAttribute('aria-label', dark ? '라이트 모드로 전환' : '다크 모드로 전환');
}

let theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
try {
  const saved = localStorage.getItem(themeKey);
  if (['dark', 'light'].includes(saved)) theme = saved;
} catch {
  // Theme switching still works when browser storage is disabled.
}
applyTheme(theme);

themeButton.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem(themeKey, next); } catch { /* Optional preference only. */ }
});

async function checkServer() {
  try {
    const health = await getHealth();
    const provider = { kakao: '카카오', naver: '네이버', osm: 'OpenStreetMap', none: '사용 안 함' }[health.place_provider] ?? '확인 불가';
    status.textContent = `● 로컬 서버 연결됨 · 장소 검색: ${provider}`;
    status.dataset.state = 'ok';
    document.body.dataset.server = 'ok';
    if (healthMessage) healthMessage.textContent = `로컬 서버 연결 완료 · 장소 검색: ${provider}`;
  } catch {
    status.textContent = '● 서버 연결 안 됨';
    status.dataset.state = 'error';
    document.body.dataset.server = 'error';
    if (healthMessage) healthMessage.textContent = '서버에 연결할 수 없습니다. python run.py 실행 상태를 확인해주세요.';
  }
}
initializeUi();
checkServer();
initializeTrips();
