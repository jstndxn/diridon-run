/**
 * Diridon Run — Cloudflare Worker variant of the 511 proxy.
 *
 * Same three endpoints as server.js (/api/departures, /api/alerts, /api/health)
 * but hosted, so the dashboard works from a phone without a laptop running.
 *
 *   npx wrangler secret put FIVEONEONE_KEY
 *   npx wrangler deploy
 *
 * wrangler.toml:
 *   name = "diridon-run"
 *   main = "worker.js"
 *   compatibility_date = "2026-01-01"
 *   [vars]
 *   AGENCY = "CT"
 *   STOP_DEP = "70172"
 *   STOP_ARR = "70262"
 *   ALLOW_ORIGIN = "*"          # tighten to your page's origin
 *
 * Then point the dashboard at it by setting, near the top of its script:
 *   const API_BASE = "https://diridon-run.<your-subdomain>.workers.dev";
 * and prefixing the two fetch("/api/…") calls with it.
 */

const SCHEDULE = [
  {no:"136", pa:"14:44", sj:"15:13"}, {no:"138", pa:"15:14", sj:"15:42"},
  {no:"140", pa:"15:44", sj:"16:14"}, {no:"514", pa:"15:59", sj:"16:20"},
  {no:"142", pa:"16:14", sj:"16:42"}, {no:"416", pa:"16:29", sj:"16:58"},
  {no:"144", pa:"16:44", sj:"17:13"}, {no:"518", pa:"16:59", sj:"17:20"},
  {no:"146", pa:"17:14", sj:"17:42"}, {no:"420", pa:"17:29", sj:"17:58"},
  {no:"148", pa:"17:44", sj:"18:13"}, {no:"522", pa:"17:59", sj:"18:20"},
  {no:"150", pa:"18:14", sj:"18:42"}, {no:"424", pa:"18:29", sj:"18:58"},
  {no:"152", pa:"18:44", sj:"19:13"}, {no:"526", pa:"18:59", sj:"19:20"},
  {no:"154", pa:"19:14", sj:"19:42"}, {no:"428", pa:"19:29", sj:"19:58"}
];

const TTL = {departures: 120, arrivals: 300, alerts: 600};   // seconds

const arr = v => Array.isArray(v) ? v : (v == null ? [] : [v]);
const pick = (o, ...k) => { for (const x of k) if (o && o[x] != null) return o[x]; return null; };
const toMin = s => { const [h,m] = String(s).split(":").map(Number); return h*60+m; };

/** Pacific wall-clock HH:MM for an instant, independent of Worker locale. */
function pacificHHMM(iso){
  return new Intl.DateTimeFormat("en-US", {timeZone:"America/Los_Angeles", hour12:false,
    hour:"2-digit", minute:"2-digit"}).format(new Date(iso));
}

/** Cached upstream read using the Worker cache, keyed by endpoint. */
async function get511(env, pathname, params, ttl, ctx){
  const key = new URL("https://diridon.invalid/" + pathname + "?" + new URLSearchParams(params));
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return {json: await hit.json(), cached: true};

  const url = new URL("https://api.511.org/transit/" + pathname);
  url.searchParams.set("api_key", env.FIVEONEONE_KEY);
  url.searchParams.set("format", "json");
  for (const [k,v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url, {headers:{Accept:"application/json"}});
  if (res.status === 401 || res.status === 403) throw new Error("511 rejected the token");
  if (res.status === 429) throw new Error("511 rate limit hit");
  if (!res.ok) throw new Error("511 returned HTTP " + res.status);

  const body = (await res.text()).replace(/^\uFEFF/, "");
  let json;
  try { json = JSON.parse(body); } catch { throw new Error("511 returned a non-JSON body"); }

  const store = new Response(JSON.stringify(json), {headers:{"Cache-Control":"max-age=" + ttl}});
  ctx.waitUntil(cache.put(key, store));
  return {json, cached: false};
}

function siriVisits(json){
  const sd = pick(json, "ServiceDelivery", "serviceDelivery") || {};
  return arr(pick(sd, "StopMonitoringDelivery", "stopMonitoringDelivery"))
    .flatMap(d => arr(pick(d, "MonitoredStopVisit", "monitoredStopVisit")));
}

function trainNumber(mvj){
  const fields = [
    pick(mvj, "VehicleRef", "vehicleRef"),
    pick(pick(mvj, "FramedVehicleJourneyRef", "framedVehicleJourneyRef") || {},
         "DatedVehicleJourneyRef", "datedVehicleJourneyRef"),
    pick(mvj, "JourneyNote", "journeyNote")
  ].filter(Boolean).map(String);
  for (const f of fields){
    const m = f.match(/\b([1458]\d{2})\b/);
    if (m && SCHEDULE.some(t => t.no === m[1])) return m[1];
  }
  for (const f of fields){ const m = f.match(/\b(\d{3})\b/); if (m) return m[1]; }
  return null;
}

function normalizeStop(json, kind){
  const out = [];
  for (const visit of siriVisits(json)){
    const mvj = pick(visit, "MonitoredVehicleJourney", "monitoredVehicleJourney");
    if (!mvj) continue;
    const call = pick(mvj, "MonitoredCall", "monitoredCall") || {};
    const A = kind === "arrival" ? ["AimedArrivalTime","aimedArrivalTime","AimedDepartureTime","aimedDepartureTime"]
                                 : ["AimedDepartureTime","aimedDepartureTime","AimedArrivalTime","aimedArrivalTime"];
    const E = kind === "arrival" ? ["ExpectedArrivalTime","expectedArrivalTime","ExpectedDepartureTime","expectedDepartureTime"]
                                 : ["ExpectedDepartureTime","expectedDepartureTime","ExpectedArrivalTime","expectedArrivalTime"];
    const aimed = pick(call, ...A), expected = pick(call, ...E);
    if (!aimed && !expected) continue;

    const no = trainNumber(mvj);
    let matched = no ? SCHEDULE.find(t => t.no === no) : null;
    if (!matched && aimed){
      const field = kind === "arrival" ? "sj" : "pa";
      const k = pacificHHMM(aimed);
      matched = SCHEDULE.find(t => t[field] === k)
             || SCHEDULE.find(t => Math.abs(toMin(t[field]) - toMin(k)) <= 3);
    }
    out.push({
      train: matched ? matched.no : no,
      aimed: aimed || null, expected: expected || aimed || null,
      delayMin: (aimed && expected) ? Math.round((new Date(expected) - new Date(aimed))/60000) : 0,
      destination: (pick(mvj, "DestinationName", "destinationName") || "").toString().trim() || null,
      atStop: Boolean(pick(call, "VehicleAtStop", "vehicleAtStop"))
    });
  }
  return out;
}

function normalizeAlerts(json){
  const txt = node => {
    const t = arr(pick(node || {}, "translation", "Translation"));
    const en = t.find(x => (pick(x,"language","Language") || "en").startsWith("en")) || t[0];
    return en ? String(pick(en,"text","Text") || "").trim() : "";
  };
  return arr(pick(json, "entity", "Entity", "entities", "Entities")).map(e => {
    const a = pick(e, "alert", "Alert") || {};
    const p = arr(pick(a, "active_period", "activePeriod"))[0];
    const start = p ? Number(pick(p, "start", "Start")) : null;
    return {
      id: String(pick(e, "id", "Id") || ""),
      header: txt(pick(a, "header_text", "headerText")),
      body: txt(pick(a, "description_text", "descriptionText")),
      effect: pick(a, "effect", "Effect"), cause: pick(a, "cause", "Cause"),
      startsAt: start ? new Date(start*1000).toISOString() : null
    };
  }).filter(a => a.header || a.body);
}

export default {
  async fetch(request, env, ctx){
    const url = new URL(request.url);
    const origin = env.ALLOW_ORIGIN || "*";
    const headers = {"Content-Type":"application/json; charset=utf-8",
                     "Cache-Control":"no-store",
                     "Access-Control-Allow-Origin": origin};
    const send = (code, obj) => new Response(JSON.stringify(obj, null, 2), {status:code, headers});

    if (request.method === "OPTIONS")
      return new Response(null, {headers:{...headers, "Access-Control-Allow-Methods":"GET,OPTIONS"}});

    const AGENCY = env.AGENCY || "CT";
    const STOP_DEP = env.STOP_DEP || "70172";
    const STOP_ARR = env.STOP_ARR || "70262";

    try{
      if (url.pathname === "/api/health")
        return send(200, {ok: Boolean(env.FIVEONEONE_KEY), tokenConfigured: Boolean(env.FIVEONEONE_KEY),
                          agency: AGENCY, stops:{departure:STOP_DEP, arrival:STOP_ARR},
                          ttlSeconds: TTL, serverTime: new Date().toISOString()});

      if (url.pathname === "/api/alerts"){
        const {json, cached} = await get511(env, "servicealerts", {agency:AGENCY}, TTL.alerts, ctx);
        return send(200, {alerts: normalizeAlerts(json),
                          meta:{cached, attribution:"Service alerts from 511 SF Bay"}});
      }

      if (url.pathname === "/api/departures"){
        const [d, a] = await Promise.all([
          get511(env, "StopMonitoring", {agency:AGENCY, stopCode:STOP_DEP}, TTL.departures, ctx),
          get511(env, "StopMonitoring", {agency:AGENCY, stopCode:STOP_ARR}, TTL.arrivals, ctx)
        ]);
        const byTrain = {};
        for (const x of normalizeStop(d.json, "departure")) if (x.train)
          byTrain[x.train] = {train:x.train, aimedDep:x.aimed, expectedDep:x.expected,
                              depDelayMin:x.delayMin, atStop:x.atStop, destination:x.destination};
        for (const x of normalizeStop(a.json, "arrival")) if (x.train)
          byTrain[x.train] = {train:x.train, ...byTrain[x.train],
                              aimedArr:x.aimed, expectedArr:x.expected, arrDelayMin:x.delayMin};
        return send(200, {stops:{departure:STOP_DEP, arrival:STOP_ARR, agency:AGENCY},
                          trains: Object.values(byTrain),
                          meta:{departures:{cached:d.cached}, arrivals:{cached:a.cached},
                                fetchedAt:new Date().toISOString(),
                                attribution:"Real-time data from 511 SF Bay"}});
      }

      return send(404, {error:"unknown endpoint"});
    }catch(err){
      return send(200, {trains:[], alerts:[], meta:{error: err.message}});
    }
  }
};
