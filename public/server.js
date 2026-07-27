// BC Wildfire Proximity Check - backend
//
// All third-party lookups (postal code / city geocoding, BC Wildfire Service
// fire locations, and the Evacuation Orders and Alerts feed) happen here on
// the server rather than in the browser. The frontend only ever talks to
// this server's own /api/check endpoint.
//
// Requires Node.js 18+ (for the built-in global `fetch`). No other runtime
// dependencies besides Express.

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const RADIUS_KM = 50;

// BC Wildfire Service - current fire locations (public WFS layer, no key required)
const WFS_BASE = 'https://openmaps.gov.bc.ca/geo/pub/wfs';
const FIRE_LAYER = 'pub:WHSE_LAND_AND_NATURAL_RESOURCE.PROT_CURRENT_FIRE_PNTS_SP';
const SHAPE_FIELD = 'SHAPE';

// Evacuation Orders and Alerts - Emergency Management BC (ArcGIS FeatureServer,
// no key required). Separate dataset from the fire points above: an
// aggregated layer of *active* evacuation Order/Alert/Tactical Evacuation
// polygons submitted by local governments and First Nations. We cross-
// reference it against fire points by fire/event number to work out which
// specific fires currently have an evacuation order or alert attached.
const EVAC_QUERY_URL = 'https://services6.arcgis.com/ubm4tcTYICKBpist/arcgis/rest/services/Evacuation_Orders_and_Alerts/FeatureServer/0/query';
// Statuses that count as "an evacuation order or alert is in place".
// "Tactical Evacuation" is a related-but-distinct designation (used for
// short-notice, targeted evacuations during active response) - excluded
// here since we only want Order/Alert, but easy to add to this list too.
const ACTIVE_EVAC_STATUSES = ['Order', 'Alert'];

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Postal code -> lat/lon using Zippopotam.us
// Note: Zippopotam only holds the first 3 characters (the FSA) of Canadian
// postal codes, e.g. "V0K" from "V0K 1C0" - full 6-char precision isn't
// available for Canada from this free source. FSA-level precision is fine
// for a 100km radius check (FSAs are generally much smaller than 100km,
// except in very remote/rural areas).
async function geocodePostalCode(postalCode) {
  const cleaned = postalCode.toUpperCase().replace(/\s+/g, '');
  const fsa = cleaned.slice(0, 3); // first 3 chars = Canadian FSA
  if (!/^[A-Z][0-9][A-Z]$/.test(fsa)) {
    throw new Error('That doesn\'t look like a valid Canadian postal code (expected format like V8W 1P6).');
  }

  const url = `https://api.zippopotam.us/ca/${fsa}`;
  console.log('[wildfire-check] Geocoding postal code via:', url);

  let resp;
  try {
    resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
  } catch (networkErr) {
    throw new Error('Could not reach the geocoding service (network error).');
  }

  if (resp.status === 404) {
    throw new Error(`Postal code area "${fsa}" was not recognized. Double-check the format (e.g. V8W 1P6).`);
  }
  if (!resp.ok) throw new Error('Geocoding service unavailable (HTTP ' + resp.status + ').');

  const data = await resp.json();

  if (!data.places || data.places.length === 0) {
    throw new Error(`No location data found for postal code area "${fsa}".`);
  }

  return {
    lat: parseFloat(data.places[0].latitude),
    lon: parseFloat(data.places[0].longitude),
    label: `${data.places[0]['place name']}, ${data.places[0]['state abbreviation']} (FSA ${fsa})`
  };
}

// "City, Province" (or State) -> lat/lon using OpenStreetMap Nominatim.
// The caller supplies both parts (e.g. "Kelowna, BC") so the search isn't
// scoped to a single province/state - this also lets it resolve places
// just across the border for radius checks near BC's edges.
async function geocodeCityProvince(cityProvince) {
  const trimmed = cityProvince.trim();
  if (!trimmed.includes(',')) {
    throw new Error('Please include the province or state, e.g. "Kelowna, BC".');
  }

  const params = new URLSearchParams({
    format: 'json',
    q: trimmed,
    limit: '1'
  });
  const url = `https://nominatim.openstreetmap.org/search?${params.toString()}`;
  console.log('[wildfire-check] Geocoding city/province via:', url);

  let resp;
  try {
    // Nominatim's usage policy asks for a descriptive User-Agent on
    // server-side requests (browser requests are exempt from this since the
    // browser sends its own UA, but we're calling it from Node now).
    resp = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'bc-wildfire-proximity-check/1.0 (contact: set-your-contact-here)'
      }
    });
  } catch (networkErr) {
    throw new Error('Could not reach the geocoding service (network error).');
  }

  if (!resp.ok) throw new Error('Geocoding service unavailable (HTTP ' + resp.status + ').');

  const data = await resp.json();

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`Could not find a location matching "${trimmed}". Try a different spelling, or a nearby larger town.`);
  }

  return {
    lat: parseFloat(data[0].lat),
    lon: parseFloat(data[0].lon),
    label: data[0].display_name
  };
}

// Query BC Wildfire Service WFS for fire points within RADIUS_KM of the point
async function findNearbyFires(lat, lon) {
  // IMPORTANT: the layer's native geometry is stored in BC Albers (EPSG:3005,
  // units = metres). Without an explicit CRS tag, GeoServer reads the POINT
  // literal's coordinates as if they were already in that CRS - so plain
  // decimal-degree lon/lat gets misinterpreted as Albers metres and the
  // filter ends up testing a point nowhere near BC (always 0 results).
  // The EWKT "SRID=4326;" prefix tells GeoServer to reproject our WGS84
  // lon/lat into EPSG:3005 before evaluating DWITHIN.
  const cqlFilter = `DWITHIN(${SHAPE_FIELD},SRID=4326;POINT(${lon} ${lat}),${RADIUS_KM},kilometers)`;
  const params = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeNames: FIRE_LAYER,
    outputFormat: 'application/json',
    srsName: 'EPSG:4326',
    CQL_FILTER: cqlFilter
  });
  const url = `${WFS_BASE}?${params.toString()}`;
  console.log('[wildfire-check] Fire query URL:', url);

  let resp;
  try {
    resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
  } catch (networkErr) {
    throw new Error('Could not reach the BC Wildfire Service (network error).');
  }

  if (!resp.ok) {
    // BC's WFS returns a descriptive XML error body on 400s - log it
    // server-side rather than just the status code, so it's easy to debug
    const bodyText = await resp.text();
    console.error('[wildfire-check] Server error response body:', bodyText);
    throw new Error(`Wildfire service returned HTTP ${resp.status}.`);
  }
  const geojson = await resp.json();

  const features = (geojson && geojson.features) ? geojson.features : [];

  // Compute an actual distance for display purposes (DWITHIN already filtered server-side)
  return features.map(f => {
    const props = f.properties || {};
    const coords = f.geometry ? f.geometry.coordinates : null;
    let distanceKm = null;
    if (coords) {
      distanceKm = haversineKm(lat, lon, coords[1], coords[0]);
    }
    return {
      // Keep the bare fire number (e.g. "K71082") around for matching
      // against the evacuation layer's EVENT_NUMBER, separately from the
      // human-friendly display name.
      fireNumber: (props.FIRE_NUMBER || '').toUpperCase().trim(),
      name: props.FIRE_NUMBER || props.INCIDENT_NAME || props.FIRE_LABEL || 'Unnamed fire',
      status: props.FIRE_STATUS || props.STAGE_OF_CONTROL || 'Status unknown',
      distanceKm: distanceKm
    };
  }).sort((a, b) => (a.distanceKm ?? 999) - (b.distanceKm ?? 999));
}

// Query the Evacuation Orders and Alerts FeatureServer for active
// Order/Alert areas within RADIUS_KM of the point. Returns a Map keyed by
// normalized fire/event number -> array of matching evac records, so a
// fire with multiple overlapping order/alert polygons collects all of them.
async function findEvacuationAreas(lat, lon) {
  const params = new URLSearchParams({
    f: 'json',
    where: `ORDER_ALERT_STATUS IN (${ACTIVE_EVAC_STATUSES.map(s => `'${s}'`).join(',')})`,
    geometry: JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } }),
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    // Buffer the query point by RADIUS_KM before testing intersection -
    // this is the ArcGIS REST equivalent of the WFS DWITHIN check above.
    distance: String(RADIUS_KM),
    units: 'esriSRUnit_Kilometer',
    outFields: 'EVENT_NAME,EVENT_NUMBER,EVENT_TYPE,ORDER_ALERT_NAME,ORDER_ALERT_STATUS,ISSUING_AGENCY,EVENT_START_DATE,DATE_MODIFIED',
    returnGeometry: 'false'
  });
  const url = `${EVAC_QUERY_URL}?${params.toString()}`;
  console.log('[wildfire-check] Evacuation query URL:', url);

  let resp;
  try {
    resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
  } catch (networkErr) {
    throw new Error('Could not reach the Evacuation Orders and Alerts service (network error).');
  }

  if (!resp.ok) {
    throw new Error(`Evacuation Orders and Alerts service returned HTTP ${resp.status}.`);
  }

  const data = await resp.json();

  if (data.error) {
    throw new Error(`Evacuation Orders and Alerts service error: ${data.error.message || 'unknown error'}.`);
  }

  const evacByFireNumber = new Map();
  const features = data.features || [];
  for (const f of features) {
    const attrs = f.attributes || {};
    const fireNumber = (attrs.EVENT_NUMBER || '').toUpperCase().trim();
    if (!fireNumber) continue;
    const record = {
      status: attrs.ORDER_ALERT_STATUS || 'Unknown',
      orderAlertName: attrs.ORDER_ALERT_NAME || attrs.EVENT_NAME || 'Unnamed area',
      issuingAgency: attrs.ISSUING_AGENCY || null,
      eventType: attrs.EVENT_TYPE || null
    };
    if (!evacByFireNumber.has(fireNumber)) evacByFireNumber.set(fireNumber, []);
    evacByFireNumber.get(fireNumber).push(record);
  }
  return evacByFireNumber;
}

// --- Express app -----------------------------------------------------------

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// GET /api/check?mode=postal&place=V0K%201K0
// GET /api/check?mode=city&place=Clinton%2C%20BC
app.get('/api/check', async (req, res) => {
  const mode = req.query.mode === 'city' ? 'city' : 'postal';
  const place = (req.query.place || '').toString().trim();

  if (!place) {
    return res.status(400).json({ error: mode === 'postal' ? 'Enter a postal code first.' : 'Enter a city and province/state first.' });
  }

  try {
    const loc = mode === 'postal'
      ? await geocodePostalCode(place)
      : await geocodeCityProvince(place);

    const [allFires, evacByFireNumber] = await Promise.all([
      findNearbyFires(loc.lat, loc.lon),
      findEvacuationAreas(loc.lat, loc.lon)
    ]);

    // Only keep fires that have a matching active Order/Alert record.
    // Attach the matched evac record(s) so the frontend can display status/agency.
    const fires = allFires
      .filter(f => f.fireNumber && evacByFireNumber.has(f.fireNumber))
      .map(f => ({ ...f, evacs: evacByFireNumber.get(f.fireNumber) }));

    res.json({
      location: loc,
      radiusKm: RADIUS_KM,
      allFiresCount: allFires.length,
      fires
    });
  } catch (err) {
    console.error('[wildfire-check] /api/check error:', err);
    res.status(502).json({ error: err.message || 'Something went wrong completing the check.' });
  }
});

app.listen(PORT, () => {
  console.log(`BC Wildfire Proximity Check server listening on http://localhost:${PORT}`);
});
