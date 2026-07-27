# BC Wildfire Proximity Check

## Structure
- `server.js` — backend (Express). All geocoding, BC Wildfire Service, and
  Evacuation Orders/Alerts lookups happen here.
- `public/index.html` — frontend (HTML + CSS + a thin client script that
  calls this app's own `/api/check` endpoint).
- `package.json` — dependencies (just Express; uses Node's built-in `fetch`).

## Setup
```
npm install
npm start
```
Then open http://localhost:3000

Requires **Node.js 18+** (for the built-in global `fetch` used in `server.js`).

## API
`GET /api/check?mode=postal&place=V0K%201K0`
`GET /api/check?mode=city&place=Clinton%2C%20BC`

Returns JSON:
```json
{
  "location": { "lat": 51.09, "lon": -121.59, "label": "..." },
  "radiusKm": 100,
  "allFiresCount": 3,
  "fires": [
    {
      "fireNumber": "K71082",
      "name": "K71082",
      "status": "Out of Control",
      "distanceKm": 42.1,
      "evacs": [
        { "status": "Order", "orderAlertName": "...", "issuingAgency": "...", "eventType": "Wildfire" }
      ]
    }
  ]
}
```
On failure: `{ "error": "message" }` with a non-2xx status.
