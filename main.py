import base64
import binascii
import os
import secrets
import sqlite3
from contextlib import closing
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, field_validator

BASE_DIR = Path(__file__).parent
DATABASE_URL = os.environ.get("DATABASE_URL")
ADMIN_KEY = os.environ.get("ADMIN_KEY", "")
HIDE_AFTER_REPORTS = 3
SPOT_COLUMNS = "id, name, cost, wifi, outlets, quiet, lat, lng, photo IS NOT NULL AS has_photo"
FLAGS = ("wifi", "outlets", "quiet", "has_photo")

app = FastAPI()


class Spot(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    name: str = Field(min_length=1, max_length=80)
    cost: int = Field(ge=0, le=100_000_000)
    wifi: bool
    outlets: bool
    quiet: bool
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    photo: str | None = Field(default=None, max_length=1_500_000, pattern=r"^data:image/(jpeg|png|webp);base64,")

    @field_validator("photo")
    @classmethod
    def photo_is_base64(cls, photo):
        if photo is not None:
            try:
                base64.b64decode(photo.split(",", 1)[1], validate=True)
            except binascii.Error as error:
                raise ValueError("photo is not valid base64") from error
        return photo


class Report(BaseModel):
    reporter: str = Field(min_length=8, max_length=64)


def connect():
    if DATABASE_URL:
        import psycopg
        from psycopg.rows import dict_row

        return psycopg.connect(DATABASE_URL, row_factory=dict_row)
    conn = sqlite3.connect(BASE_DIR / "spotwise.db")
    conn.row_factory = sqlite3.Row
    return conn


def query(sql, params=()):
    if DATABASE_URL:
        sql = sql.replace("?", "%s")
    with closing(connect()) as conn, conn:
        cursor = conn.execute(sql, params)
        return [dict(row) for row in cursor.fetchall()] if cursor.description else []


def create_tables():
    id_type = "SERIAL" if DATABASE_URL else "INTEGER"
    query(f"""
        CREATE TABLE IF NOT EXISTS spots (
            id {id_type} PRIMARY KEY,
            name TEXT NOT NULL,
            cost INTEGER NOT NULL,
            wifi BOOLEAN NOT NULL,
            outlets BOOLEAN NOT NULL,
            quiet BOOLEAN NOT NULL,
            lat DOUBLE PRECISION NOT NULL,
            lng DOUBLE PRECISION NOT NULL,
            photo TEXT
        )
    """)
    query("""
        CREATE TABLE IF NOT EXISTS reports (
            spot_id INTEGER NOT NULL,
            reporter TEXT NOT NULL,
            PRIMARY KEY (spot_id, reporter)
        )
    """)


def to_dict(row):
    for key in FLAGS:
        if key in row:
            row[key] = bool(row[key])
    return row


def require_admin(key):
    if not ADMIN_KEY or not secrets.compare_digest(key, ADMIN_KEY):
        raise HTTPException(status_code=403, detail="Admin key required")


@app.get("/api/spots")
def list_spots():
    rows = query(
        f"SELECT {SPOT_COLUMNS} FROM spots WHERE id NOT IN "
        "(SELECT spot_id FROM reports GROUP BY spot_id HAVING COUNT(*) >= ?)",
        (HIDE_AFTER_REPORTS,),
    )
    return [to_dict(row) for row in rows]


@app.post("/api/spots", status_code=201)
def add_spot(spot: Spot):
    rows = query(
        "INSERT INTO spots (name, cost, wifi, outlets, quiet, lat, lng, photo) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
        (spot.name, spot.cost, spot.wifi, spot.outlets, spot.quiet, spot.lat, spot.lng, spot.photo),
    )
    return {"id": rows[0]["id"], **spot.model_dump(exclude={"photo"}), "has_photo": spot.photo is not None}


@app.get("/api/spots/{spot_id}/photo")
def spot_photo(spot_id: int):
    rows = query("SELECT photo FROM spots WHERE id = ?", (spot_id,))
    if not rows or not rows[0]["photo"]:
        raise HTTPException(status_code=404, detail="No photo")
    header, data = rows[0]["photo"].split(",", 1)
    media_type = header.removeprefix("data:").split(";")[0]
    return Response(base64.b64decode(data), media_type=media_type, headers={"Cache-Control": "public, max-age=86400"})


@app.post("/api/spots/{spot_id}/report", status_code=204)
def report_spot(spot_id: int, report: Report):
    if not query("SELECT id FROM spots WHERE id = ?", (spot_id,)):
        raise HTTPException(status_code=404, detail="Spot not found")
    query("INSERT INTO reports (spot_id, reporter) VALUES (?, ?) ON CONFLICT DO NOTHING", (spot_id, report.reporter))


@app.get("/api/admin/spots")
def admin_spots(x_admin_key: str = Header(default="")):
    require_admin(x_admin_key)
    rows = query(
        f"SELECT {SPOT_COLUMNS}, (SELECT COUNT(*) FROM reports WHERE reports.spot_id = spots.id) AS reports "
        "FROM spots ORDER BY reports DESC, id DESC"
    )
    return [to_dict(row) for row in rows]


@app.delete("/api/admin/spots/{spot_id}", status_code=204)
def delete_spot(spot_id: int, x_admin_key: str = Header(default="")):
    require_admin(x_admin_key)
    query("DELETE FROM reports WHERE spot_id = ?", (spot_id,))
    query("DELETE FROM spots WHERE id = ?", (spot_id,))


@app.delete("/api/admin/spots/{spot_id}/reports", status_code=204)
def clear_reports(spot_id: int, x_admin_key: str = Header(default="")):
    require_admin(x_admin_key)
    query("DELETE FROM reports WHERE spot_id = ?", (spot_id,))


create_tables()
app.mount("/", StaticFiles(directory=BASE_DIR / "static", html=True), name="static")
