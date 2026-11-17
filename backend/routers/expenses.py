"""Travel ledger: actual spending during the trip. No external APIs or LLM calls."""
from datetime import date, datetime, timezone
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, ConfigDict

from backend.database import connect
from backend.routers.trips import get_row
from backend.schemas import LongText, Money, ShortText

router = APIRouter(prefix="/api/trips/{trip_id}/expenses", tags=["expenses"])

CATEGORIES = {"food": "식비", "transport": "교통", "stay": "숙박", "shopping": "쇼핑", "activity": "관광·체험", "other": "기타"}


class ExpenseInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    date: date
    title: ShortText
    category: Literal["food", "transport", "stay", "shopping", "activity", "other"] = "other"
    amount_krw: Money
    payment: Literal["card", "cash", "other"] = "card"
    memo: LongText = ""


class Expense(ExpenseInput):
    id: str
    trip_id: str
    created_at: datetime


def check_trip_date(db, trip_id, day):
    trip = get_row(db, trip_id)
    if not trip["start_date"] <= day.isoformat() <= trip["end_date"]:
        raise HTTPException(422, "지출 날짜는 여행 기간 안에 있어야 합니다.")
    return trip


def expense_row(db, trip_id, expense_id):
    row = db.execute("SELECT * FROM expenses WHERE trip_id=? AND id=?", (trip_id, expense_id)).fetchone()
    if row is None:
        raise HTTPException(404, "지출 기록을 찾을 수 없습니다.")
    return dict(row)


@router.get("", response_model=list[Expense])
def list_expenses(trip_id: str):
    with connect() as db:
        get_row(db, trip_id)
        return [dict(row) for row in db.execute(
            "SELECT * FROM expenses WHERE trip_id=? ORDER BY date, created_at, id", (trip_id,))]


@router.get("/summary")
def summary(trip_id: str):
    with connect() as db:
        trip = get_row(db, trip_id)
        rows = [dict(row) for row in db.execute("SELECT date, category, amount_krw, payment FROM expenses WHERE trip_id=?", (trip_id,))]
    spent = sum(row["amount_krw"] for row in rows)
    reserved = sum(item.get("cost_krw", 0) for item in trip.get("flights", []) + trip.get("accommodations", []) + trip.get("ground", []))
    by_category = {key: 0 for key in CATEGORIES}
    by_date, by_payment = {}, {"card": 0, "cash": 0, "other": 0}
    for row in rows:
        by_category[row["category"]] = by_category.get(row["category"], 0) + row["amount_krw"]
        by_date[row["date"]] = by_date.get(row["date"], 0) + row["amount_krw"]
        by_payment[row["payment"]] = by_payment.get(row["payment"], 0) + row["amount_krw"]
    budget = trip.get("budget_krw", 0)
    travelers = max(1, trip.get("travelers", 1))
    return {
        "budget_krw": budget, "reserved_krw": reserved, "spent_krw": spent,
        "total_krw": reserved + spent,
        "remaining_krw": budget - reserved - spent if budget else None,
        "per_person_krw": round((reserved + spent) / travelers),
        "by_category": [{"category": key, "label": CATEGORIES.get(key, key), "amount_krw": value} for key, value in by_category.items()],
        "by_date": [{"date": key, "amount_krw": value} for key, value in sorted(by_date.items())],
        "by_payment": by_payment, "count": len(rows),
    }


@router.post("", response_model=Expense, status_code=201)
def create_expense(trip_id: str, payload: ExpenseInput):
    expense_id = uuid4().hex
    with connect() as db:
        check_trip_date(db, trip_id, payload.date)
        db.execute("INSERT INTO expenses (id, trip_id, date, title, category, amount_krw, payment, memo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                   (expense_id, trip_id, payload.date.isoformat(), payload.title, payload.category, payload.amount_krw,
                    payload.payment, payload.memo, datetime.now(timezone.utc).isoformat()))
        return expense_row(db, trip_id, expense_id)


@router.put("/{expense_id}", response_model=Expense)
def update_expense(trip_id: str, expense_id: str, payload: ExpenseInput):
    with connect() as db:
        check_trip_date(db, trip_id, payload.date)
        expense_row(db, trip_id, expense_id)
        db.execute("UPDATE expenses SET date=?, title=?, category=?, amount_krw=?, payment=?, memo=? WHERE trip_id=? AND id=?",
                   (payload.date.isoformat(), payload.title, payload.category, payload.amount_krw, payload.payment,
                    payload.memo, trip_id, expense_id))
        return expense_row(db, trip_id, expense_id)


@router.delete("/{expense_id}", status_code=204)
def delete_expense(trip_id: str, expense_id: str):
    with connect() as db:
        expense_row(db, trip_id, expense_id)
        db.execute("DELETE FROM expenses WHERE trip_id=? AND id=?", (trip_id, expense_id))
    return Response(status_code=204)
