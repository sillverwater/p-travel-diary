"""Generate (staged: interpret -> search -> choose -> code-computed times) -> preview -> single-use apply."""
import hashlib
import json
import re
from contextvars import ContextVar
from datetime import date, datetime, time, timezone
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, ValidationError, model_validator

from backend.database import connect
from backend.routers.itinerary import ItemInput, check_date
from backend.routers.trips import get_row
from backend.services.planner import choose, gather, interpret, openai_client, stay_for_day
from backend.services.places import configured, distance_m
from backend.services.documents import search as search_documents
from backend.services import kakao, routing
from backend.services.place_names import normalize_place_name

router = APIRouter(prefix="/api/trips/{trip_id}/planner", tags=["AI planner"])


class PlanRequest(BaseModel):
    date: date
    prompt: str = Field(min_length=1, max_length=6000)
    start_time: time = time(9, 0)
    end_time: time = time(23, 0)
    # transit = 차 없음 (도보 + 대중교통), driving = 차 있음 (도보 + 자동차). walking kept for old clients.
    travel_mode: str = Field(pattern="^(walking|driving|transit)$", default="transit")
    # auto = 너굴이 요청을 보고 추가(add)인지 기존 흐름 수정(replace)인지 판단
    mode: Literal["auto", "add", "replace"] = "auto"

    @model_validator(mode="after")
    def valid_window(self):
        if self.start_time.tzinfo or self.end_time.tzinfo or self.start_time >= self.end_time:
            raise ValueError("시작·종료 시간은 같은 날의 현지 시각이며 종료 시간이 더 늦어야 합니다.")
        return self


def snapshot(db, trip_id, day):
    trip = get_row(db, trip_id)
    existing = [dict(row) for row in db.execute(
        "SELECT * FROM itinerary_items WHERE trip_id=? AND date=? ORDER BY time, id", (trip_id, day)
    )]
    fingerprint = hashlib.sha256(json.dumps([trip, existing], sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    return trip, existing, fingerprint


def minute(value):
    # Accept common model formatting such as "9:00" without changing the time.
    value = value.strip()
    if re.fullmatch(r"\d:\d{2}(?::00)?", value):
        value = "0" + value
    parsed = time.fromisoformat(value)
    if parsed.tzinfo is not None or parsed.second or parsed.microsecond:
        raise ValueError("분 단위 현지 시간이 필요합니다.")
    return parsed.hour * 60 + parsed.minute


def clock(minutes):
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


ASKED_AT: ContextVar[str] = ContextVar("asked_at", default="")


def now_local():
    return datetime.now().astimezone().isoformat(timespec="seconds")


def save_exchange(db, trip_id, day, prompt, reply):
    """User message gets the time it was sent, the reply the time it was ready."""
    asked = ASKED_AT.get() or now_local()
    db.executemany("INSERT INTO planning_messages (trip_id, date, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
                   [(trip_id, day, "user", prompt, asked), (trip_id, day, "assistant", reply, now_local())])


def clarification(trip_id, payload, reply):
    with connect() as db:
        get_row(db, trip_id)
        save_exchange(db, trip_id, payload.date.isoformat(), payload.prompt, reply)
    return {"kind": "clarification", "date": payload.date.isoformat(), "summary": reply, "items": []}


def explicit_start(prompt):
    # Deliberately narrow: ask about ambiguous hours instead of inventing AM/PM.
    match = re.search(r"(?:(오전|오후|아침|저녁|밤)\s*)?(\d{1,2})\s*시\s*(?:(\d{1,2})\s*분\s*)?(?:부터|에\s*시작)", prompt)
    if not match:
        return None
    period, hour, minutes = match.groups()
    hour, minutes = int(hour), int(minutes or 0)
    if hour > 23 or minutes > 59:
        return None
    if period in {"오후", "저녁", "밤"} and hour < 12:
        hour += 12
    elif period in {"오전", "아침"} and hour == 12:
        hour = 0
    return hour * 60 + minutes


@router.get("/messages")
def messages(trip_id: str):
    with connect() as db:
        get_row(db, trip_id)
        return [dict(row) for row in db.execute(
            "SELECT id, date, role, content, created_at FROM planning_messages WHERE trip_id=? ORDER BY id", (trip_id,)
        )]


DEFAULT_DURATION = {"food": 70, "cafe": 60, "sight": 90, "shopping": 60, "stay": 20, "transfer": 30, "other": 60}
CATEGORY = {"food": "food", "cafe": "food", "sight": "visit", "shopping": "visit", "stay": "stay", "transfer": "transfer", "other": "other"}
# (fixed overhead minutes, metres per minute); straight-line distance x1.3 detour factor. Rough estimates only.
SPEED = {"walking": (0, 70), "transit": (10, 350), "driving": (5, 450)}
UNKNOWN_TRAVEL = {"walking": 20, "transit": 30, "driving": 25}
MODE_LABEL = {"walking": "도보", "transit": "대중교통", "driving": "자동차"}
EXISTING_BLOCK_MINUTES = 60


def up(value, step):
    return -(-value // step) * step


def travel_estimate(a, b, mode):
    if a and b:
        straight = distance_m(a, b)
        base, speed = SPEED[mode]
        return max(5, up(round(base + straight * 1.3 / speed), 5)), f"직선 {straight}m 기준 {MODE_LABEL[mode]} 추정"
    return UNKNOWN_TRAVEL[mode], f"위치 미확인 {MODE_LABEL[mode]} 기본값"


TAG = {"visit": "관광", "flight": "항공", "stay": "숙소", "food": "식사", "transfer": "이동", "other": "기타"}


def tag_of(item):
    """'[관광] 광안리 해변' style label used in chat replies (cafés shown as 카페)."""
    if item["category"] == "food" and any(word in item["title"] for word in ("카페", "디저트")):
        return "카페"
    return TAG.get(item["category"], "기타")


def latest_draft(trip_id, day):
    """Activities of the newest unsaved draft for this day (transfers left out), or []."""
    with connect() as db:
        row = db.execute("SELECT payload FROM plan_drafts WHERE trip_id=? AND date=? AND applied=0 ORDER BY rowid DESC LIMIT 1",
                         (trip_id, day)).fetchone()
    if not row:
        return []
    try:
        items = json.loads(row["payload"]).get("items", [])
    except (ValueError, TypeError):
        return []
    return [{"time": item["time"][:5], "title": item["title"], "place": item["location"].split(",")[0].strip(),
             "category": item["category"]} for item in items if item.get("category") != "transfer"]


# Earliest sensible start for some activities when the user gave no exact time.
EARLIEST = [("야식", 21 * 60), ("저녁", 17 * 60 + 30), ("야경", 18 * 60), ("점심", 11 * 60 + 30)]


def earliest_start(title):
    for word, at in EARLIEST:
        if word in title:
            return at
    return None


def is_transfer_like(activity):
    title = activity.title.strip()
    return activity.kind == "transfer" or title.startswith("이동") or title.startswith("이동(")


# ---------- fixed travel legs (flight / train / bus / car) for one day ----------
ARRIVE_BUFFER = {"flight": 40, "train": 15, "bus": 15, "car": 10}      # 수속·수하물·하차·주차 여유
DEPART_BUFFER = {"flight": 90, "train": 30, "bus": 30, "car": 0}       # 출발 전 도착 여유 (해외 항공은 +60)
LEG_LABEL = {"flight": "항공편", "train": "기차", "bus": "버스", "car": "자차"}
MIN_WINDOW = 60


def day_legs(trip, day):
    """Returns (arrivals, departures) on this day. Each: {kind, place, minute, label, estimated}.
    The trip's final leg on its last day is treated as the trip home (a departure), every other leg as an arrival."""
    legs = []
    for f in trip.get("flights", []):
        legs.append({"kind": "flight", "from": f["departure_airport"], "to": f["arrival_airport"],
                     "dep": f.get("departure_at"), "arr": f.get("arrival_at"), "code": f.get("flight_number", "")})
    for g in trip.get("ground", []):
        legs.append({"kind": g["mode"], "from": g["from_place"], "to": g["to_place"],
                     "dep": g.get("departure_at"), "arr": g.get("arrival_at"), "code": g.get("label", "")})
    legs = [leg for leg in legs if leg["dep"] or leg["arr"]]
    if not legs:
        return [], []
    legs.sort(key=lambda leg: str(leg["dep"] or leg["arr"]))
    final = legs[-1]
    final_is_home = len(legs) >= 2 or (str(final["dep"] or "")[:10] == trip["end_date"] and trip["end_date"] != trip["start_date"])
    arrivals, departures = [], []
    for leg in legs:
        label = f"{LEG_LABEL[leg['kind']]}{(' ' + leg['code']) if leg['code'] else ''}"
        dep, arr = str(leg["dep"] or ""), str(leg["arr"] or "")
        if leg is final and final_is_home:
            if dep[:10] == day:
                departures.append({"kind": leg["kind"], "place": leg["from"], "minute": minute(dep[11:16]), "label": label})
            continue
        if arr[:10] == day:
            arrivals.append({"kind": leg["kind"], "place": leg["to"], "minute": minute(arr[11:16]), "label": label, "estimated": False})
        elif not arr and dep[:10] == day:
            # No arrival time entered: assume about an hour after departure (and say so).
            arrivals.append({"kind": leg["kind"], "place": leg["to"], "minute": minute(dep[11:16]) + 60, "label": label, "estimated": True})
    return arrivals, departures


@router.post("/generate")
def generate(trip_id: str, payload: PlanRequest):
    ASKED_AT.set(now_local())
    day = payload.date.isoformat()
    with connect() as db:
        check_date(db, trip_id, payload.date)
        trip, existing, fingerprint = snapshot(db, trip_id, day)
        planned_text = " ".join(f"{row['title']} {row['location']}" for row in db.execute(
            "SELECT title, location FROM itinerary_items WHERE trip_id=?", (trip_id,))).replace(" ", "").casefold()
        history = [dict(row) for row in db.execute(
            "SELECT date, role, content FROM planning_messages WHERE trip_id=? ORDER BY id DESC LIMIT 12",
            (trip_id,),
        )][::-1]
    arrivals, departures = day_legs(trip, day)
    last_arrival = max(arrivals, key=lambda a: a["minute"]) if arrivals else None
    first_departure = min(departures, key=lambda d: d["minute"]) if departures else None
    ready_at = last_arrival["minute"] + ARRIVE_BUFFER[last_arrival["kind"]] if last_arrival else None
    leave_by = None
    if first_departure:
        leave_by = first_departure["minute"] - DEPART_BUFFER[first_departure["kind"]] - (
            60 if first_departure["kind"] == "flight" and trip.get("region") == "overseas" else 0)
    requested = explicit_start(payload.prompt)
    if last_arrival and requested is not None and requested < last_arrival["minute"]:
        # The user explicitly asked for a time before they even arrive: ask instead of guessing.
        return clarification(trip_id, payload,
            f"등록된 {last_arrival['label']}은 {day} {last_arrival['place']}에 {clock(last_arrival['minute'])} 도착 예정이에요"
            f"{' (도착 시각이 없어 출발 1시간 뒤로 가정)' if last_arrival['estimated'] else ''}. "
            f"요청하신 {clock(requested)} 시작은 도착보다 빨라요. "
            f"도착 후 {clock(ready_at)}부터 시작할까요, 아니면 출발 전 일정이라면 그렇게 알려주시겠어요?")
    if ready_at is not None and leave_by is not None and leave_by - ready_at < MIN_WINDOW:
        return clarification(trip_id, payload,
            f"이 날은 {clock(last_arrival['minute'])} 도착, {clock(first_departure['minute'])} {first_departure['label']} 출발이라 "
            "일정을 넣을 시간이 거의 없어요. 예약 시간을 확인해 주시거나, 넣고 싶은 활동 하나만 알려주시겠어요?")

    context = {
        "request": payload.model_dump(mode="json"),
        "trip": {key: trip.get(key) for key in ("title", "destination", "start_date", "end_date", "travelers",
                                                 "budget_krw", "travel_style", "must_visit_places",
                                                 "region", "access", "local_car", "ground")},
        "stays": [{k: s.get(k) for k in ("name", "address", "check_in", "check_out")} for s in trip.get("accommodations", [])],
        # Fixed travel today: plan only after arrivals_today (+buffer) and finish before departures_today (-buffer).
        "arrivals_today": [{"type": a["label"], "place": a["place"], "time": clock(a["minute"]),
                            "plan_from": clock(a["minute"] + ARRIVE_BUFFER[a["kind"]]), "estimated": a["estimated"]} for a in arrivals],
        "departures_today": [{"type": d["label"], "place": d["place"], "time": clock(d["minute"]),
                              "finish_by": clock(leave_by)} for d in departures],
        # Must-visit places not yet in any day's itinerary (simple name containment check).
        "must_visit_remaining": [p for p in trip.get("must_visit_places", []) if p.replace(" ", "").casefold() not in planned_text],
        "existing_items": [{"time": item["time"][:5], "title": item["title"], "location": item["location"], "category": item["category"],
                            "locked_flight": item.get("source", "").startswith("flight:")} for item in existing],
        "prior_conversation": history,
        # Latest draft for this day that was not saved yet: a follow-up like "저녁만 횟집으로" edits this.
        "current_draft": latest_draft(trip_id, day),
    }
    context["mode"] = payload.mode
    with openai_client() as client:
        with connect() as db:
            excerpts = search_documents(client, db, trip_id, payload.prompt, k=4)
        if excerpts:
            context["trip_documents"] = [{"document": e["document"], "excerpt": e["excerpt"]} for e in excerpts]
        intent = interpret(client, context)
        if intent.kind == "clarification" or not intent.activities:
            return clarification(trip_id, payload, intent.question.strip()
                                 or "어떤 활동을 하고 싶은지 순서대로 알려주시겠어요? 예: 점심 국밥 → 바다 산책 → 카페")
        # Transfers are inserted by code between activities, so drop any the model produced.
        intent.activities = [a for a in intent.activities if not is_transfer_like(a)]
        if not intent.activities:
            return clarification(trip_id, payload, "이동 말고 하고 싶은 활동을 알려주시겠어요? 예: 점심 국밥 → 바다 산책 → 카페")
        # Decide add vs. revise. Revise = the whole day is re-listed and replaces the saved (non-flight) items.
        saved = [i for i in existing if not i.get("source", "").startswith("flight:")]
        effective = payload.mode if payload.mode != "auto" else ("replace" if intent.action == "revise" and saved else "add")
        replace = effective == "replace"
        context["mode"] = effective
        slots, anchor, notices = gather(intent, trip, day, payload.travel_mode)
        selection = choose(client, context, slots)

    mode = payload.travel_mode
    window_start, end_limit = minute(payload.start_time.isoformat()), minute(payload.end_time.isoformat())
    adjustments, dropped, planned = [], [], []
    cursor = window_start
    if ready_at is not None and cursor < ready_at:
        cursor = ready_at
        adjustments.append(f"{last_arrival['label']} 도착({clock(last_arrival['minute'])}"
                           f"{', 시각 미입력이라 출발 1시간 뒤로 가정' if last_arrival['estimated'] else ''}) 후 "
                           f"여유 {ARRIVE_BUFFER[last_arrival['kind']]}분을 두고 {clock(cursor)}부터 배치했습니다.")
    if leave_by is not None and end_limit > leave_by:
        end_limit = max(leave_by, cursor)
        adjustments.append(f"{first_departure['label']} 출발({clock(first_departure['minute'])}, {first_departure['place']}) 전에 "
                           f"{clock(end_limit)}까지 일정을 마치도록 종료 시각을 앞당겼습니다. 출발지까지 이동 시간도 확인하세요.")
    blocks = []
    for item in ([i for i in existing if i.get("source", "").startswith("flight:")] if replace else existing):
        try:
            begin = minute(item["time"][:5])
        except ValueError:
            continue
        blocks.append((begin, begin + EXISTING_BLOCK_MINUTES, item["title"]))
    stay = stay_for_day(trip, day)
    previous_point = None
    # Where the day starts moving from: the arrival airport on an arrival day, otherwise unknown.
    previous_name = last_arrival["place"] if last_arrival else ""
    if previous_name and kakao.configured():
        try:  # Airport coordinates so the first transfer can be routed too.
            found = kakao.keyword(previous_name, size=1)
            previous_point = found[0] if found else None
        except kakao.KakaoError:
            previous_point = None

    for slot in slots:
        activity = slot["activity"]
        pick = getattr(selection, f"slot_{slot['index']}")
        chosen = next((row for row in slot["candidates"] if row["id"] == pick.choice), None)
        point = chosen or (anchor if activity.kind == "stay" else None)
        duration = activity.duration_minutes if 10 <= activity.duration_minutes <= 600 else DEFAULT_DURATION[activity.kind]
        leg = None
        if planned or previous_name:
            # Research this leg with map services (Kakao driving / OSM walking / transit estimate).
            leg = routing.segment(previous_point, point, mode)
            travel, basis = leg["minutes"], f"{leg['label']} · {leg['basis']}"
        else:
            travel, basis = 0, "첫 활동 (출발 위치 미정)"
        start = up(cursor + travel, 10)
        earliest = None if activity.fixed_time else earliest_start(activity.title)
        if earliest is not None and start < earliest and earliest + duration <= end_limit:
            adjustments.append(f"{activity.title}: 보통 {clock(earliest)} 이후가 자연스러워 {clock(start)} 대신 {clock(earliest)}에 배치했습니다.")
            start = earliest
        if activity.fixed_time:
            try:
                wanted = minute(activity.fixed_time)
                if wanted >= start:
                    start = wanted
                else:
                    adjustments.append(f"{activity.title}: 요청 시각 {clock(wanted)}은 이전 활동·이동 때문에 {clock(start)}로 조정했습니다.")
            except ValueError:
                pass
        moved = True
        while moved:  # Skip over saved items (assumed {EXISTING_BLOCK_MINUTES} min each).
            moved = False
            for begin, finish, title in blocks:
                if begin < start + duration and start < finish:
                    adjustments.append(f"{activity.title}: 저장된 ‘{title}’({clock(begin)})과 겹치지 않도록 뒤로 옮겼습니다.")
                    start, moved = up(finish + 10, 10), True
        end = start + duration
        if end > end_limit:
            dropped.extend(s["activity"].title for s in slots[slot["index"]:])
            break

        if chosen:
            location = f"{chosen['name']}, {chosen['address'] or trip['destination']}"
            title = activity.title  # 장소명은 장소 칸에만
        elif activity.kind == "stay" and stay and not activity.fixed_place:
            location = f"{stay['name']}, {stay.get('address') or trip['destination']}"
            title = activity.title
        else:
            location = activity.fixed_place or activity.search_query or f"{activity.title}, {trip['destination']}"
            title = activity.title
        lines = [f"[AI 추천·미검증] 체류 {duration}분 / 직전 장소에서 이동 {travel}분 ({basis})",
                 f"추천 이유: {pick.reason.strip()}", f"확인할 사항: {pick.cautions.strip()}"]
        sources = []
        if chosen:
            distance = f" · 숙소 직선거리 약 {chosen['distance_m']}m" if chosen.get("distance_m") is not None else ""
            if chosen.get("sort") == "kakao":
                if chosen.get("fixed"):
                    lines.append(f"장소 확인: 직접 지정한 ‘{slot['query']}’을 카카오에서 확인 ({chosen.get('category_path') or chosen['category']}){distance}")
                else:
                    lines.append(f"출처: 카카오 로컬 검색 ‘{slot['query']}’ ({chosen.get('category_path') or chosen['category']}){distance}")
                if chosen.get("mentions") is not None and not chosen.get("fixed"):
                    lines.append(f"선정 기준: 후보 {chosen.get('compared', 1)}곳 중 다음 블로그 언급 최다(약 {chosen['mentions']:,}건) · 평점·리뷰 점수가 아닌 언급량 기준")
                if chosen.get("place_url"):
                    lines.append(f"카카오맵 장소 정보: {chosen['place_url']}")
            elif chosen.get("sort") == "osm":
                lines.append(f"출처: OpenStreetMap ‘{slot['query']}’ 주변 {chosen['search_rank']}번째 후보 ({chosen['category']}){distance} · © OpenStreetMap contributors")
                if chosen.get("opening_hours"):
                    lines.append(f"OSM 등록 영업시간(미검증): {chosen['opening_hours']}")
            else:
                lines.append(f"출처: 네이버 지역 검색 ‘{slot['query']}’ {chosen['search_rank']}번째 후보 ({chosen['category']}){distance}")
            sources = [{"title": p["title"], "url": p["url"]} for p in chosen.get("blog", [])]
            if chosen.get("place_url"):
                sources.insert(0, {"title": "카카오맵 장소 정보", "url": chosen["place_url"]})
            if sources:
                lines.append("참고 블로그:\n" + "\n".join(f"- {p['title']} {p['url']}" for p in sources))
        elif slot["candidates"]:
            lines.append("검색 후보 중 조건에 맞는 곳이 없어 지도 검색어로 제안했습니다.")
        lines.append("실제 영업·가격·이동시간은 지도와 공식 안내에서 확인하세요.")
        try:
            item = ItemInput(date=payload.date, time=clock(start), title=title[:100],
                             location=normalize_place_name(location)[:3000], category=CATEGORY[activity.kind],
                             estimated_cost_krw=min(max(int(pick.estimated_cost_krw), 0), 1_000_000_000_000),
                             notes="\n".join(lines)[:3000])
        except ValidationError:
            adjustments.append(f"{activity.title}: 형식 문제로 초안에서 제외했습니다.")
            continue
        current_name = (chosen["name"] if chosen else location.split(",")[0]).strip()
        if travel and previous_name:
            # Mandatory transfer row between stops (time = when the previous stop ends).
            fare, fare_note = routing.leg_cost(leg, trip.get("travelers", 1), trip.get("region", "domestic"))
            transfer = ItemInput(
                date=payload.date, time=clock(min(cursor, start)), category="transfer",
                title=f"이동({leg['label'] if leg else MODE_LABEL[mode]} {travel}분): {previous_name} → {current_name}"[:100],
                location=f"{previous_name} → {current_name}"[:3000], estimated_cost_krw=min(max(int(fare), 0), 1_000_000_000_000),
                notes=(f"[자동 추가 이동] {basis}\n예상 교통비: {fare_note}\n"
                       "실제 경로·소요 시간·요금은 카카오맵 길찾기에서 확인하세요.")[:3000])
            planned.append({**transfer.model_dump(mode="json"), "duration_minutes": travel,
                            "travel_minutes_before": 0, "sources": []})
        planned.append({**item.model_dump(mode="json"), "duration_minutes": duration,
                        "travel_minutes_before": travel, "sources": sources})
        cursor = end
        previous_point = point
        previous_name = current_name

    if not planned:
        return clarification(trip_id, payload,
            f"선택한 시간({clock(window_start)}~{clock(end_limit)}) 안에 활동을 배치하지 못했어요. "
            "종료 시각을 늦추거나 활동 수를 줄여주시겠어요? 기존 일정은 변경하지 않았어요.")

    assumptions = ["시각·이동시간은 직선거리 기반 추정입니다. 실제 경로·영업시간·가격은 별도 확인이 필요합니다.",
                   *intent.assumptions, *notices, *adjustments]
    if dropped:
        assumptions.append(f"종료 시각 {clock(end_limit)}까지 시간이 부족해 제외한 활동: {', '.join(dropped)}")
    if configured():
        assumptions.append("후보 순위는 네이버 지역 검색의 카페·블로그 리뷰순이며 방문자 리뷰 수나 평점이 아닙니다.")
    elif kakao.configured():
        assumptions.append("후보 순위는 카카오 로컬 검색의 정확도순(숙소 근처 조건이면 반경 안)이며 평점·리뷰 수가 아닙니다.")
    fixed = sum(item.get("cost_krw", 0) for item in trip.get("flights", []) + trip.get("accommodations", []) + trip.get("ground", []))
    if trip.get("budget_krw", 0) and fixed + sum(item["estimated_cost_krw"] for item in planned) > trip["budget_krw"]:
        assumptions.append("이 초안과 예약 비용 합계가 여행 총예산을 초과합니다. 적용 전에 비용을 조정해주세요.")
    if excerpts:
        assumptions.append(f"올려둔 여행 자료에서 관련 내용 {len(excerpts)}건을 참고했습니다: {', '.join(dict.fromkeys(e['document'] for e in excerpts))}")
    replaceable = [item for item in existing if not item.get("source", "").startswith("flight:")]
    if replace and replaceable:
        assumptions.insert(0, f"적용하면 이 날의 기존 일정 {len(replaceable)}개를 삭제하고 이 초안으로 교체합니다. 항공편 일정은 유지합니다.")
    elif existing:
        assumptions.append(f"기존 일정은 각각 {EXISTING_BLOCK_MINUTES}분으로 가정해 겹치지 않게 배치했습니다.")
    draft = {"kind": "plan", "id": uuid4().hex, "date": day, "summary": selection.summary.strip(),
             "assumptions": list(dict.fromkeys(a for a in assumptions if a)), "items": planned,
             "mode": effective, "replace_ids": [item["id"] for item in existing if not item.get("source", "").startswith("flight:")] if replace else []}

    with connect() as db:
        _, _, current = snapshot(db, trip_id, day)
        if current != fingerprint:
            raise HTTPException(409, "생성 중 여행 또는 일정이 변경됐습니다. 새로 생성해주세요.")
        db.execute("INSERT INTO plan_drafts (id, trip_id, date, fingerprint, payload) VALUES (?, ?, ?, ?, ?)",
                   (draft["id"], trip_id, day, fingerprint, json.dumps(draft, ensure_ascii=False)))
        reply = draft["summary"] + "\n" + "\n".join(f"{item['time'][:5]} [{tag_of(item)}] {item['title']} ({item['location'].split(',')[0]})"
                                                    for item in planned if item["category"] != "transfer")
        if dropped:
            reply += f"\n시간이 부족해 제외: {', '.join(dropped)}"
        save_exchange(db, trip_id, day, payload.prompt, reply)
    return draft


@router.post("/drafts/{draft_id}/apply")
def apply_draft(trip_id: str, draft_id: str):
    with connect() as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT * FROM plan_drafts WHERE trip_id=? AND id=?", (trip_id, draft_id)).fetchone()
        if not row:
            raise HTTPException(404, "초안을 찾을 수 없습니다.")
        if row["applied"]:
            raise HTTPException(409, "이미 적용한 초안입니다. 중복으로 추가하지 않았습니다.")
        _, _, current = snapshot(db, trip_id, row["date"])
        if current != row["fingerprint"]:
            raise HTTPException(409, "여행 또는 일정이 변경됐습니다. 새 초안을 생성해주세요.")
        draft = json.loads(row["payload"])
        now = datetime.now(timezone.utc).isoformat()
        replaced = 0
        if draft.get("mode") == "replace":
            # Fingerprint check above guarantees these are exactly the items the user saw.
            for item_id in draft.get("replace_ids", []):
                replaced += db.execute("DELETE FROM itinerary_items WHERE trip_id=? AND id=?", (trip_id, item_id)).rowcount
        for value in draft["items"]:
            item = ItemInput.model_validate({key: val for key, val in value.items() if key not in {"duration_minutes", "travel_minutes_before", "sources"}})
            check_date(db, trip_id, item.date)
            db.execute("INSERT INTO itinerary_items (id, trip_id, date, time, title, location, category, estimated_cost_krw, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                       (uuid4().hex, trip_id, item.date.isoformat(), item.time.isoformat(), item.title, item.location, item.category, item.estimated_cost_krw, item.notes, now))
        db.execute("UPDATE plan_drafts SET applied=1 WHERE id=?", (draft_id,))
    return {"added": len(draft["items"]), "replaced": replaced, "date": draft["date"]}
