# Spotwise

Find cheap, student-friendly study spots anywhere in the world and track what you spend on them.

## Features

- Map of study spots shared by students, with minimum spend, Wi-Fi, outlets and noise tags
- Nearby cafés, libraries, fast-food places and coworking spaces from OpenStreetMap
- Search that finds the nearest match first
- Photos, directions and a weekly study budget in your local currency

## Run locally

```
pip install -r requirements.txt
python -m uvicorn main:app --reload
```

Open http://localhost:8000

## Built with

FastAPI, SQLite, Leaflet, OpenStreetMap, Overpass API and Nominatim.
