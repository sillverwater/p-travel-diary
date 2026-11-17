"""Keep itinerary items in sync with the trip's flight reservations and 기차·버스·자차 segments.

Each flight produces a departure item and an arrival item (when the date is inside the trip).
Items are keyed by `source` = 'flight:<identity>:dep|arr'. Sync only inserts missing keys and deletes
keys whose flight no longer exists, so user edits to an existing flight item are preserved.
"""
import hashlib
from datetime import datetime, timezone
from uuid import uuid4

PREFIX = "flight:"


def _identity(flight):
    raw = "|".join(str(flight.get(k, "")) for k in ("flight_number", "departure_airport", "arrival_airport", "departure_at", "arrival_at"))
    return hashlib.sha1(raw.encode()).hexdigest()[:16]


def desired_items(trip):
    items = {}
    for flight in trip.get("flights", []):
        key = _identity(flight)
        number = (flight.get("flight_number") or "").strip()
        route = f"{flight['departure_airport']} → {flight['arrival_airport']}"
        label = f"{number} " if number else ""
        note = "항공편 예약에서 자동으로 추가된 일정입니다. 예약 정보를 바꾸면 함께 갱신돼요. 시각은 각 공항의 현지 시각입니다."
        for side, at, place, verb, zone in (("dep", flight["departure_at"], flight["departure_airport"], "출발", flight.get("departure_timezone", "")),
                                             ("arr", flight["arrival_at"], flight["arrival_airport"], "도착", flight.get("arrival_timezone", ""))):
            day, clock = at[:10], at[11:16]
            if not (trip["start_date"] <= day <= trip["end_date"]):
                continue
            items[f"{PREFIX}{key}:{side}"] = {
                "date": day, "time": clock, "title": f"{label}{route} {verb}"[:100], "location": place,
                "category": "flight", "estimated_cost_krw": 0, "notes": f"{note} ({zone})",
            }
    # 기차·버스·자차: one transfer row at the departure time (keys share PREFIX so they are locked like flights).
    labels = {"train": "기차", "bus": "버스", "car": "자차"}
    for segment in trip.get("ground", []):
        departure = segment.get("departure_at")
        if not departure:
            continue
        day, clock = departure[:10], departure[11:16]
        if not (trip["start_date"] <= day <= trip["end_date"]):
            continue
        raw = "|".join(str(segment.get(k, "")) for k in ("mode", "label", "from_place", "to_place", "departure_at", "arrival_at"))
        key = "g" + hashlib.sha1(raw.encode()).hexdigest()[:15]
        kind = labels.get(segment.get("mode"), "이동")
        detail = " ".join(part for part in (kind, (segment.get("label") or "").strip()) if part)
        arrival = segment.get("arrival_at")
        if arrival:
            minutes = int((datetime.fromisoformat(arrival) - datetime.fromisoformat(departure)).total_seconds() // 60)
            detail += f" {minutes // 60}시간 {minutes % 60}분" if minutes >= 60 else f" {minutes}분"
        items[f"{PREFIX}{key}:dep"] = {
            "date": day, "time": clock, "title": f"이동({detail}): {segment['from_place']} → {segment['to_place']}"[:100],
            "location": f"{segment['from_place']} → {segment['to_place']}", "category": "transfer", "estimated_cost_krw": 0,
            "notes": f"{detail} · 여행 정보의 {kind} 예약에서 자동으로 추가된 일정입니다."
                     + (f" 도착 예정 {arrival[5:16].replace('T', ' ')}" if arrival else ""),
        }
    return items


def sync(db, trip):
    wanted = desired_items(trip)
    current = {row["source"]: row["id"] for row in db.execute(
        "SELECT id, source FROM itinerary_items WHERE trip_id=? AND source LIKE ?", (trip["id"], PREFIX + "%"))}
    for source, item_id in current.items():
        if source not in wanted:
            db.execute("DELETE FROM itinerary_items WHERE id=?", (item_id,))
    now = datetime.now(timezone.utc).isoformat()
    for source, item in wanted.items():
        if source in current:
            continue
        db.execute("INSERT INTO itinerary_items (id, trip_id, date, time, title, location, category, estimated_cost_krw, notes, created_at, source) "
                   "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                   (uuid4().hex, trip["id"], item["date"], item["time"], item["title"], item["location"], item["category"],
                    item["estimated_cost_krw"], item["notes"], now, source))


def sync_all(db, serialize):
    for row in db.execute("SELECT * FROM trips").fetchall():
        sync(db, serialize(row))
