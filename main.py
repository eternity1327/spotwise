import sqlite3
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

BASE_DIR = Path(__file__).parent
DB_PATH = BASE_DIR / "tambay.db"

app = FastAPI()


class Spot(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    cost: int = Field(ge=0)
    wifi: bool
    outlets: bool
    quiet: bool
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    photo: str | None = Field(default=None, max_length=1_500_000, pattern=r"^data:image/(jpeg|png|webp);base64,")


def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def create_table():
    with connect() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS spots (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                cost INTEGER NOT NULL,
                wifi INTEGER NOT NULL,
                outlets INTEGER NOT NULL,
                quiet INTEGER NOT NULL,
                lat REAL NOT NULL,
                lng REAL NOT NULL,
                photo TEXT
            )
        """)
        columns = [row["name"] for row in conn.execute("PRAGMA table_info(spots)")]
        if "photo" not in columns:
            conn.execute("ALTER TABLE spots ADD COLUMN photo TEXT")


def to_dict(row):
    spot = dict(row)
    for key in ("wifi", "outlets", "quiet"):
        spot[key] = bool(spot[key])
    return spot


@app.get("/api/spots")
def list_spots():
    with connect() as conn:
        rows = conn.execute("SELECT * FROM spots").fetchall()
    return [to_dict(row) for row in rows]


@app.post("/api/spots", status_code=201)
def add_spot(spot: Spot):
    with connect() as conn:
        cursor = conn.execute(
            "INSERT INTO spots (name, cost, wifi, outlets, quiet, lat, lng, photo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (spot.name, spot.cost, spot.wifi, spot.outlets, spot.quiet, spot.lat, spot.lng, spot.photo),
        )
    return {"id": cursor.lastrowid, **spot.model_dump()}


create_table()
app.mount("/", StaticFiles(directory=BASE_DIR / "static", html=True), name="static")
