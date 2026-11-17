// Trip documents (RAG): upload, list, delete, search. Original files are not stored on the server.
import { request } from './api.js';
import { readFileBase64 } from './files.js';
import { confirmDialog } from './ui.js';

const $ = id => document.getElementById(id);
const kindLabels = { pdf: 'PDF', xlsx: 'Excel', csv: 'CSV', txt: '텍스트', md: 'Markdown', markdown: 'Markdown', image: '이미지' };
let trip = null, uploading = false, revision = 0;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function load() {
  if (!trip) return;
  const id = trip.id, generation = ++revision;
  try {
    const docs = await request(`/api/trips/${id}/documents`);
    if (generation !== revision || trip?.id !== id) return;
    const list = $('doc-list'); list.replaceChildren();
    for (const doc of docs) {
      const li = element('li');
      const info = element('div');
      info.append(element('b', '', doc.name), element('small', '', `${kindLabels[doc.kind] ?? doc.kind} · ${doc.chars.toLocaleString('ko-KR')}자 · 조각 ${doc.chunks}개`));
      const remove = element('button', 'secondary-button danger-button', '삭제'); remove.type = 'button';
      remove.onclick = async () => {
        if (!(await confirmDialog(`“${doc.name}” 자료를 삭제할까요? 일정 추천에서 더 이상 참고하지 않아요.`)) || trip?.id !== id) return;
        remove.disabled = true;
        try { await request(`/api/trips/${id}/documents/${doc.id}`, { method: 'DELETE' }); await load(); }
        catch (error) { $('doc-status').textContent = error.message; remove.disabled = false; }
      };
      // Toggle: show the text recognised from this file (loaded on first open).
      const preview = element('details', 'doc-preview');
      preview.append(element('summary', '', '인식된 내용 보기'));
      const body = element('pre', 'doc-preview-text', '불러오는 중…');
      preview.append(body);
      preview.addEventListener('toggle', async () => {
        if (!preview.open || preview.dataset.loaded) return;
        preview.dataset.loaded = '1';
        try {
          const result = await request(`/api/trips/${id}/documents/${doc.id}/text`);
          body.textContent = result.text.trim() || '인식된 글자가 없어요.';
          if (result.truncated) body.textContent += `\n\n… (앞부분 ${result.text.length.toLocaleString('ko-KR')}자만 표시)`;
        } catch (error) { body.textContent = error.message; delete preview.dataset.loaded; }
      });
      li.append(info, remove, preview); list.append(li);
    }
    if (!docs.length) list.append(element('li', 'muted', '아직 올린 자료가 없어요.'));
  } catch (error) { if (generation === revision) $('doc-status').textContent = error.message; }
}

export function selectDocumentTrip(selected) {
  if (selected && trip && selected.id === trip.id) { trip = selected; return; }
  revision++;
  trip = selected;
  $('doc-status').textContent = ''; $('doc-search-status').textContent = '';
  $('doc-results').replaceChildren(); $('doc-list').replaceChildren(); $('doc-form').reset();
  if (trip) load();
}

export function initializeDocuments() {
  $('doc-form').onsubmit = async event => {
    event.preventDefault();
    const file = $('doc-file').files[0];
    if (!trip || uploading || !file) return;
    const id = trip.id;
    uploading = true; $('doc-upload').disabled = true;
    $('doc-status').textContent = `“${file.name}”을 읽고 정리하는 중… (큰 파일은 시간이 걸려요)`;
    try {
      const content = await readFileBase64(file);
      const result = await request(`/api/trips/${id}/documents`, { method: 'POST', body: { name: file.name, content_base64: content } });
      if (trip?.id !== id) return;
      $('doc-status').textContent = `“${result.name}” 저장 완료 · ${result.chars.toLocaleString('ko-KR')}자, 조각 ${result.chunks}개${result.truncated ? ' (너무 길어 앞부분만 저장했어요)' : ''}`;
      $('doc-form').reset();
      await load();
    } catch (error) { if (trip?.id === id) $('doc-status').textContent = error.message; }
    finally { uploading = false; $('doc-upload').disabled = false; }
  };
  $('doc-search-form').onsubmit = async event => {
    event.preventDefault();
    const query = $('doc-query').value.trim();
    if (!trip || !query) return;
    const id = trip.id;
    $('doc-search-status').textContent = '찾는 중…';
    try {
      const results = await request(`/api/trips/${id}/documents/search`, { method: 'POST', body: { query } });
      if (trip?.id !== id) return;
      const box = $('doc-results'); box.replaceChildren();
      for (const result of results) {
        const card = element('article', 'doc-result');
        card.append(element('span', 'name-tag', result.document), element('p', '', result.excerpt));
        box.append(card);
      }
      $('doc-search-status').textContent = results.length ? `관련 내용 ${results.length}건` : '관련 내용을 찾지 못했어요. 자료를 먼저 올리거나 다른 표현으로 찾아보세요.';
    } catch (error) { $('doc-search-status').textContent = error.message; }
  };
}
