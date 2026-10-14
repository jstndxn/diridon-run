#!/usr/bin/env node
/**
 * Diridon Run — local proxy for 511 SF Bay transit data.
 *
 * Holds your 511.org API token server-side, calls the SIRI StopMonitoring and
 * GTFS-RT service alert endpoints, normalizes the results, and serves the
 * dashboard from the same origin so the browser never deals with CORS.
 *
 * Node 18+ required (uses global fetch). No dependencies.
 *
 *   FIVEONEONE_KEY=your-token node server.js
 *   open http://localhost:8511
 */

/* Every time in this app is Pacific. Pin it so a server running in UTC still
   matches aimed times against the printed timetable correctly. */
process.env.TZ = process.env.TZ || "America/Los_Angeles";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

/* ------------------------------------------------------------------ config */

const KEY = (process.env.FIVEONEONE_KEY || process.env.API_KEY_511 || readKeyFile() || "").trim();
const PORT = Number(process.env.PORT || 8511);
/* Loopback by default: this proxy answers with your token attached, so binding
   0.0.0.0 would let anyone on the same Wi-Fi spend your 511 quota.
   Set HOST=0.0.0.0 deliberately if you want it reachable from your phone. */
const HOST = process.env.HOST || "127.0.0.1";
const AGENCY = process.env.AGENCY || "CT";              // Caltrain
const STOP_DEP = process.env.STOP_DEP || "70172";       // Palo Alto, southbound
const STOP_ARR = process.env.STOP_ARR || "70262";       // San Jose Diridon, southbound

/* 511 allows 60 requests per hour per token by default. These TTLs keep a
   single running instance at roughly 48/hour with headroom to spare. */
const TTL = {
  departures: Number(process.env.TTL_DEPARTURES || 120) * 1000,
  arrivals:   Number(process.env.TTL_ARRIVALS   || 300) * 1000,
  alerts:     Number(process.env.TTL_ALERTS     || 600) * 1000
};
const HOURLY_CAP = Number(process.env.HOURLY_CAP || 55);

function readKeyFile(){
  try { return fs.readFileSync(path.join(__dirname, "key.txt"), "utf8"); }
  catch { return null; }
}

/* Baseline timetable — must stay in sync with the board in the HTML.
   Used to attach live times to the right train when 511 reports a trip id
   we can't parse a train number out of. */
const SCHEDULE = [
  {no:"136", type:"Local",   pa:"14:44", sj:"15:13"},
  {no:"138", type:"Local",   pa:"15:14", sj:"15:42"},
  {no:"140", type:"Local",   pa:"15:44", sj:"16:14"},
  {no:"514", type:"Express", pa:"15:59", sj:"16:20"},
  {no:"142", type:"Local",   pa:"16:14", sj:"16:42"},
  {no:"416", type:"Limited", pa:"16:29", sj:"16:58"},
  {no:"144", type:"Local",   pa:"16:44", sj:"17:13"},
  {no:"518", type:"Express", pa:"16:59", sj:"17:20"},
  {no:"146", type:"Local",   pa:"17:14", sj:"17:42"},
  {no:"420", type:"Limited", pa:"17:29", sj:"17:58"},
  {no:"148", type:"Local",   pa:"17:44", sj:"18:13"},
  {no:"522", type:"Express", pa:"17:59", sj:"18:20"},
  {no:"150", type:"Local",   pa:"18:14", sj:"18:42"},
  {no:"424", type:"Limited", pa:"18:29", sj:"18:58"},
  {no:"152", type:"Local",   pa:"18:44", sj:"19:13"},
  {no:"526", type:"Express", pa:"18:59", sj:"19:20"},
  {no:"154", type:"Local",   pa:"19:14", sj:"19:42"},
  {no:"428", type:"Limited", pa:"19:29", sj:"19:58"}
];

/* ------------------------------------------------------- quota + cache ---- */

const calls = [];              // timestamps of upstream requests
const cache = new Map();       // key -> {ts, data, error}

function quotaLeft(){
  const cutoff = Date.now() - 3600_000;
  while (calls.length && calls[0] < cutoff) calls.shift();
  return HOURLY_CAP - calls.length;
}

/** Fetch through the cache. Serves stale data rather than failing. */
async function cached(key, ttl, fetcher){
  const hit = cache.get(key);
  const fresh = hit && Date.now() - hit.ts < ttl;
  if (fresh) return {...hit, cached:true, ageSec:Math.round((Date.now()-hit.ts)/1000)};

  if (quotaLeft() <= 0){
    if (hit) return {...hit, cached:true, stale:true, note:"hourly quota reached, serving cache",
                     ageSec:Math.round((Date.now()-hit.ts)/1000)};
    return {ts:Date.now(), data:null, error:"511 hourly request cap reached and nothing cached yet"};
  }

  try{
    const data = await fetcher();   // quota is counted inside get511
    const rec = {ts:Date.now(), data, error:null};
    cache.set(key, rec);
    return {...rec, cached:false, ageSec:0};
  }catch(err){
    if (hit) return {...hit, cached:true, stale:true, note:"upstream failed: " + err.message,
                     ageSec:Math.round((Date.now()-hit.ts)/1000)};
    return {ts:Date.now(), data:null, error:err.message};
  }
}

/* ----------------------------------------------------------- 511 calls ---- */

/** 511 prefixes its JSON with a UTF-8 BOM, which JSON.parse chokes on. */
async function get511(pathname, params){
  if (!KEY) throw new Error("no 511 token configured");
  const url = new URL("https://api.511.org/transit/" + pathname);
  url.searchParams.set("api_key", KEY);
  url.searchParams.set("format", "json");
  for (const [k,v] of Object.entries(params)) url.searchParams.set(k, v);

  calls.push(Date.now());
  const res = await fetch(url, {headers:{"Accept":"application/json"}});
  const body = (await res.text()).replace(/^\uFEFF/, "").trim();

  if (res.status === 401 || res.status === 403) throw new Error("511 rejected the token (HTTP " + res.status + ")");
  if (res.status === 429) throw new Error("511 rate limit hit (HTTP 429)");
  if (!res.ok) throw new Error("511 returned HTTP " + res.status);

  try { return JSON.parse(body); }
  catch { throw new Error("511 returned a non-JSON body (" + body.slice(0,80) + ")"); }
}

const arr = v => Array.isArray(v) ? v : (v == null ? [] : [v]);
const pick = (o, ...keys) => { for (const k of keys) if (o && o[k] != null) return o[k]; return null; };

/** Pull MonitoredStopVisit entries out of a SIRI StopMonitoring response. */
function siriVisits(json){
  const sd = pick(json, "ServiceDelivery", "serviceDelivery") || {};
  const deliveries = arr(pick(sd, "StopMonitoringDelivery", "stopMonitoringDelivery"));
  return deliveries.flatMap(d => arr(pick(d, "MonitoredStopVisit", "monitoredStopVisit")));
}

/** Best effort train number: Caltrain puts it in VehicleRef or the trip ref. */
function trainNumber(mvj){
  const fields = [
    pick(mvj, "VehicleRef", "vehicleRef"),
    pick(pick(mvj, "FramedVehicleJourneyRef", "framedVehicleJourneyRef") || {},
         "DatedVehicleJourneyRef", "datedVehicleJourneyRef"),
    pick(mvj, "JourneyNote", "journeyNote"),
    pick(mvj, "VehicleJourneyName", "vehicleJourneyName")
  ].filter(Boolean).map(String);

  for (const f of fields){
    const m = f.match(/\b([1458]\d{2})\b/);
    if (m && SCHEDULE.some(t => t.no === m[1])) return m[1];
  }
  for (const f of fields){
    const m = f.match(/\b(\d{3})\b/);
    if (m) return m[1];
  }
  return null;
}

const hhmm = iso => {
  const d = new Date(iso);
  return String(d.getHours()).padStart(2,"0") + ":" + String(d.getMinutes()).padStart(2,"0");
};
const minsBetween = (a,b) => Math.round((new Date(a) - new Date(b)) / 60000);

/** Normalize one stop's live board into {trainNo|aimedHHMM -> times}. */
function normalizeStop(json, kind){
  const out = [];
  for (const visit of siriVisits(json)){
    const mvj = pick(visit, "MonitoredVehicleJourney", "monitoredVehicleJourney");
    if (!mvj) continue;
    const call = pick(mvj, "MonitoredCall", "monitoredCall") || {};

    const aimed = kind === "arrival"
      ? pick(call, "AimedArrivalTime", "aimedArrivalTime", "AimedDepartureTime", "aimedDepartureTime")
      : pick(call, "AimedDepartureTime", "aimedDepartureTime", "AimedArrivalTime", "aimedArrivalTime");
    const expected = kind === "arrival"
      ? pick(call, "ExpectedArrivalTime", "expectedArrivalTime", "ExpectedDepartureTime", "expectedDepartureTime")
      : pick(call, "ExpectedDepartureTime", "expectedDepartureTime", "ExpectedArrivalTime", "expectedArrivalTime");
    if (!aimed && !expected) continue;

    const no = trainNumber(mvj);
    const sched = no ? SCHEDULE.find(t => t.no === no) : null;
    const aimedKey = aimed ? hhmm(aimed) : null;

    /* If we couldn't read a train number, fall back to matching the aimed
       time against the printed timetable (within 3 minutes). */
    let matched = sched;
    if (!matched && aimedKey){
      const field = kind === "arrival" ? "sj" : "pa";
      matched = SCHEDULE.find(t => t[field] === aimedKey)
             || SCHEDULE.find(t => Math.abs(toMin(t[field]) - toMin(aimedKey)) <= 3);
    }

    out.push({
      train: matched ? matched.no : no,
      matched: Boolean(matched),
      aimed: aimed || null,
      aimedHHMM: aimedKey,
      expected: expected || aimed || null,
      delayMin: (aimed && expected) ? minsBetween(expected, aimed) : 0,
      destination: String(pick(mvj, "DestinationName", "destinationName") || "").trim() || null,
      vehicle: pick(mvj, "VehicleRef", "vehicleRef") || null,
      atStop: Boolean(pick(call, "VehicleAtStop", "vehicleAtStop"))
    });
  }
  return out;
}
const toMin = s => { const [h,m] = String(s).split(":").map(Number); return h*60+m; };

/** GTFS-RT service alerts, requested as JSON. Field casing varies, so be loose. */
function normalizeAlerts(json){
  const entities = arr(pick(json, "entity", "Entity", "entities", "Entities"));
  const txt = node => {
    const t = arr(pick(node || {}, "translation", "Translation"));
    const en = t.find(x => (pick(x,"language","Language") || "en").startsWith("en")) || t[0];
    return en ? String(pick(en,"text","Text") || "").trim() : "";
  };
  return entities.map(e => {
    const a = pick(e, "alert", "Alert") || {};
    const periods = arr(pick(a, "active_period", "activePeriod", "ActivePeriod"));
    const start = periods.length ? Number(pick(periods[0], "start", "Start")) : null;
    return {
      id: String(pick(e, "id", "Id") || ""),
      header: txt(pick(a, "header_text", "headerText", "HeaderText")),
      body: txt(pick(a, "description_text", "descriptionText", "DescriptionText")),
      effect: pick(a, "effect", "Effect") || null,
      cause: pick(a, "cause", "Cause") || null,
      startsAt: start ? new Date(start * 1000).toISOString() : null
    };
  }).filter(a => a.header || a.body);
}

/* ------------------------------------------------------------- handlers --- */

async function apiDepartures(){
  const [dep, arrv] = await Promise.all([
    cached("dep", TTL.departures, async () =>
      normalizeStop(await get511("StopMonitoring", {agency:AGENCY, stopCode:STOP_DEP}), "departure")),
    cached("arr", TTL.arrivals, async () =>
      normalizeStop(await get511("StopMonitoring", {agency:AGENCY, stopCode:STOP_ARR}), "arrival"))
  ]);

  const byTrain = {};
  for (const d of (dep.data || [])){
    if (!d.train) continue;
    byTrain[d.train] = {
      train: d.train,
      aimedDep: d.aimed, expectedDep: d.expected, depDelayMin: d.delayMin,
      atStop: d.atStop, destination: d.destination, vehicle: d.vehicle,
      matchedTimetable: d.matched
    };
  }
  for (const a of (arrv.data || [])){
    if (!a.train) continue;
    byTrain[a.train] = Object.assign({train:a.train}, byTrain[a.train], {
      aimedArr: a.aimed, expectedArr: a.expected, arrDelayMin: a.delayMin
    });
  }

  return {
    stops: {departure: STOP_DEP, arrival: STOP_ARR, agency: AGENCY},
    trains: Object.values(byTrain).sort((x,y) =>
      String(x.aimedDep||x.aimedArr||"").localeCompare(String(y.aimedDep||y.aimedArr||""))),
    meta: {
      departures: {cached:dep.cached, stale:!!dep.stale, ageSec:dep.ageSec, error:dep.error, note:dep.note},
      arrivals:   {cached:arrv.cached, stale:!!arrv.stale, ageSec:arrv.ageSec, error:arrv.error, note:arrv.note},
      quotaLeftThisHour: quotaLeft(),
      fetchedAt: new Date().toISOString(),
      attribution: "Real-time data from 511 SF Bay"
    }
  };
}

async function apiAlerts(){
  const r = await cached("alerts", TTL.alerts, async () =>
    normalizeAlerts(await get511("servicealerts", {agency:AGENCY})));
  return {
    alerts: r.data || [],
    meta: {cached:r.cached, stale:!!r.stale, ageSec:r.ageSec, error:r.error, note:r.note,
           quotaLeftThisHour: quotaLeft(), attribution: "Service alerts from 511 SF Bay"}
  };
}

function apiHealth(){
  return {
    ok: Boolean(KEY),
    tokenConfigured: Boolean(KEY),
    agency: AGENCY,
    stops: {departure: STOP_DEP, arrival: STOP_ARR},
    ttlSeconds: {departures:TTL.departures/1000, arrivals:TTL.arrivals/1000, alerts:TTL.alerts/1000},
    upstreamCallsLastHour: HOURLY_CAP - quotaLeft(),
    quotaLeftThisHour: quotaLeft(),
    cacheKeys: [...cache.keys()],
    serverTime: new Date().toISOString()
  };
}

/* --------------------------------------------------------------- server --- */

const TYPES = {".html":"text/html; charset=utf-8", ".js":"text/javascript", ".css":"text/css",
               ".json":"application/json", ".ico":"image/x-icon", ".svg":"image/svg+xml"};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
  const send = (code, obj) => {
    const body = JSON.stringify(obj, null, 2);
    res.writeHead(code, {"Content-Type":"application/json; charset=utf-8",
                         "Cache-Control":"no-store",
                         "Access-Control-Allow-Origin":"*"});
    res.end(body);
  };

  try{
    if (url.pathname === "/api/departures") return send(200, await apiDepartures());
    if (url.pathname === "/api/alerts")     return send(200, await apiAlerts());
    if (url.pathname === "/api/health")     return send(200, apiHealth());

    /* static */
    let file = url.pathname === "/" ? "diridon_run.html" : decodeURIComponent(url.pathname.slice(1));
    if (file.includes("..")) { res.writeHead(400); return res.end("bad path"); }
    const full = path.join(__dirname, file);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()){
      res.writeHead(404, {"Content-Type":"text/plain"});
      return res.end("Not found: " + file);
    }
    res.writeHead(200, {"Content-Type": TYPES[path.extname(full)] || "application/octet-stream",
                        "Cache-Control":"no-cache"});
    fs.createReadStream(full).pipe(res);
  }catch(err){
    send(500, {error: err.message});
  }
});

module.exports = {server, normalizeStop, normalizeAlerts, trainNumber, apiHealth, SCHEDULE};

if (require.main !== module) return;

server.listen(PORT, HOST, () => {
  console.log("\n  Diridon Run  →  http://localhost:" + PORT + "   (bound to " + HOST + ")");
  console.log("  511 token:   " + (KEY ? "loaded (" + KEY.slice(0,4) + "…)" : "MISSING — board runs in manual mode"));
  console.log("  Stops:       departures " + STOP_DEP + " (Palo Alto SB) · arrivals " + STOP_ARR + " (Diridon SB)");
  console.log("  Cache TTL:   departures " + TTL.departures/1000 + "s · arrivals " + TTL.arrivals/1000 + "s · alerts " + TTL.alerts/1000 + "s");
  if (!KEY) console.log("\n  Get a free token at https://511.org/open-data/token, then:\n" +
                        "    FIVEONEONE_KEY=your-token node server.js\n");
});
