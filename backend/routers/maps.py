"""Kakao Map links (free URL scheme). Candidates come from the Kakao Local API when the key is set.

Web links: https://map.kakao.com/link/search/{query}, /link/map/{name},{lat},{lng},
           /link/from/{name},{lat},{lng}/to/{name},{lat},{lng}
App link:  kakaomap://route?sp={lat},{lng}&ep={lat},{lng}&by=FOOT|CAR|PUBLICTRANSIT
"""
import html
import json
from urllib.parse import quote

from fastapi import APIRouter, Query
from fastapi.responses import HTMLResponse, RedirectResponse

from backend.services import kakao
from backend.services.place_names import normalize_place_name

router = APIRouter(prefix="/api/maps", tags=["maps"])


def search_link(query):
    return "https://map.kakao.com/link/search/" + quote(query, safe="")


def best_place(query):
    """Resolve '장소명, 주소' to one Kakao place: exact name (+address) match first, else the top result."""
    if not kakao.configured():
        return None
    name, _, address = (part.strip() for part in query.partition(","))
    compact = lambda text: "".join((text or "").split()).casefold()
    area = " ".join(address.split()[:2])
    try:
        rows = (kakao.keyword(f"{name} {area}".strip(), size=5) if area else []) or kakao.keyword(name or query, size=5)
    except kakao.KakaoError:
        return None
    if not rows:
        return None
    exact = [r for r in rows if compact(r["name"]) == compact(name)]
    if address:
        located = [r for r in exact if compact(r["address"]) and (compact(r["address"]) in compact(address) or compact(address) in compact(r["address"]))]
        exact = located or exact
    return (exact or rows)[0]


def place_link(row):
    if row.get("place_url"):
        return row["place_url"]
    return "https://map.kakao.com/link/map/" + ",".join([quote(row["name"].replace(",", " "), safe=""), str(row["lat"]), str(row["lng"])])


@router.get("/place")
def place(query: str = Query(min_length=1, max_length=3000)):
    query = normalize_place_name(query)
    row = best_place(query)
    return RedirectResponse(place_link(row) if row else search_link(query), status_code=302)


@router.get("/route", response_class=HTMLResponse)
def route(origin: str = Query(min_length=1, max_length=3000), destination: str = Query(min_length=1, max_length=3000), mode: str = "walking",
          choose: bool = False):
    origin = normalize_place_name(origin)
    destination = normalize_place_name(destination)
    if not choose:
        # Direct: resolve both ends and open Kakao Map directions with start/end already set.
        start_row, end_row = best_place(origin), best_place(destination)
        if start_row and end_row:
            part = lambda r: ",".join([quote(r["name"].replace(",", " "), safe=""), str(r["lat"]), str(r["lng"])])
            return RedirectResponse(f"https://map.kakao.com/link/from/{part(start_row)}/to/{part(end_row)}", status_code=302)
    by = {"walking": "FOOT", "driving": "CAR", "transit": "PUBLICTRANSIT"}.get(mode, "FOOT")
    mode_label = {"FOOT": "도보", "CAR": "자동차", "PUBLICTRANSIT": "대중교통"}[by]
    escape = html.escape
    message = "출발지와 도착지를 골라주세요. 같은 이름의 지점이 있을 수 있어 자동으로 첫 결과를 고르지 않습니다."
    start, end = [], []
    if not kakao.configured():
        message = "카카오 REST API 키가 없어 장소 후보를 불러오지 못했습니다. 아래 검색 링크에서 카카오맵으로 직접 길찾기를 이용해주세요."
    else:
        try:
            # Search by the leading place name (before the address) for better matches.
            start = kakao.resolve(origin.split(",")[0]) or kakao.resolve(origin)
            end = kakao.resolve(destination.split(",")[0]) or kakao.resolve(destination)
        except kakao.KakaoError as exc:
            message = str(exc) + " 아래 검색 링크로 직접 확인할 수 있습니다."

    def options(rows):
        return '<option value="">장소 선택</option>' + ''.join(
            f'<option value="{escape(json.dumps({"name": r["name"], "lat": r["lat"], "lng": r["lng"]}, ensure_ascii=False), quote=True)}">'
            f'{escape(r["name"] + " · " + r["address"])}</option>' for r in rows)

    return f'''<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>카카오맵에서 경로 확인</title>
<style>body{{font:15px/1.8 system-ui,sans-serif;background:#5bb381;color:#5a4634;margin:0;padding:32px 16px}}main{{max-width:720px;margin:auto;padding:24px;background:#fffdf4;border-radius:28px}}
select{{width:100%;padding:12px;margin:6px 0 18px;border:2px solid #efe4c6;border-radius:14px;font:inherit}}a{{display:inline-block;margin:4px 8px 4px 0;padding:8px 16px;border-radius:999px;background:#d8f1e4;color:#1f5c40;text-decoration:none}}
h1{{margin:0 0 4px}}.hint{{color:#8a7863;font-size:.9rem}}</style>
<main><h1>오늘의 이동 경로</h1><p>{escape(origin)} → {escape(destination)} · {mode_label}</p><p class="hint">{escape(message)}</p>
<p><a href="{escape(search_link(origin))}" target="_blank" rel="noopener noreferrer">출발지 카카오맵 검색 ↗</a><a href="{escape(search_link(destination))}" target="_blank" rel="noopener noreferrer">도착지 카카오맵 검색 ↗</a></p>
<label>출발지<select id="start">{options(start)}</select></label><label>도착지<select id="end">{options(end)}</select></label>
<div id="links"></div>
<p class="hint">웹 길찾기에서는 카카오맵 화면에서 이동 수단을 다시 골라주세요. 앱 링크는 카카오맵 앱이 설치된 휴대폰에서 {mode_label} 길찾기로 열립니다. 실제 경로·소요 시간은 카카오맵에서 확인하세요.</p></main>
<script>
const by={json.dumps(by)};
const part=p=>[encodeURIComponent(p.name.replace(/,/g,' ')),p.lat,p.lng].join(',');
function update(){{const s=document.getElementById('start').value,d=document.getElementById('end').value,box=document.getElementById('links');box.replaceChildren();if(!s||!d)return;
const a=JSON.parse(s),b=JSON.parse(d);
const web='https://map.kakao.com/link/from/'+part(a)+'/to/'+part(b);
const app='kakaomap://route?sp='+a.lat+','+a.lng+'&ep='+b.lat+','+b.lng+'&by='+by;
for(const [label,url] of [['카카오맵 웹 길찾기 ↗',web],['카카오맵 앱에서 열기 ↗',app]]){{const link=document.createElement('a');link.textContent=label;link.href=url;link.target='_blank';link.rel='noopener noreferrer';box.append(link);}}}}
document.getElementById('start').onchange=update;document.getElementById('end').onchange=update;
</script></html>'''
