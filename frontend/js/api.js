// Same-origin requests: no API keys belong in frontend code.
export async function request(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    cache: 'no-store',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const detail = data.detail;
    if (Array.isArray(detail)) {
      throw new Error(detail.map(item => item.msg).join(' / '));
    }
    throw new Error(typeof detail === 'string' ? detail : '요청을 처리하지 못했습니다. 다시 시도해주세요.');
  }
  return response.status === 204 ? null : response.json();
}

export async function getHealth() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch('/api/health', {
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!response.ok) throw new Error('서버 상태를 확인하지 못했습니다.');
    const result = await response.json();
    if (result.status !== 'ok') throw new Error('서버 응답을 확인해주세요.');
    return result;
  } finally {
    clearTimeout(timeout);
  }
}
