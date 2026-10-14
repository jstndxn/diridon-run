/* Offline test: mocks api.511.org so the parser and endpoints can be verified
   without a token or network. Run: node test.js */

const assert = require("node:assert");

/* --- build a realistic SIRI StopMonitoring payload for today, Pacific --- */
process.env.TZ = "America/Los_Angeles";
process.env.FIVEONEONE_KEY = "test-token";
process.env.PORT = "8599";

function iso(hhmm, plusMin = 0){
  const [h,m] = hhmm.split(":").map(Number);
  const d = new Date(); d.setHours(h, m + plusMin, 0, 0);
  return d.toISOString();                     // 511 returns UTC with Z
}

const depPayload = {
  ServiceDelivery: {
    ResponseTimestamp: new Date().toISOString(),
    StopMonitoringDelivery: {
      version: "1.4",
      MonitoredStopVisit: [
        { MonitoringRef: "70172",
          MonitoredVehicleJourney: {
            LineRef: "L1", DirectionRef: "SOUTH",
            FramedVehicleJourneyRef: {DataFrameRef:"2026-08-14", DatedVehicleJourneyRef:"146"},
            DestinationName: "SAN JOSE DIRIDON", VehicleRef: "146",
            MonitoredCall: {
              StopPointRef: "70172",
              AimedDepartureTime: iso("17:14"), ExpectedDepartureTime: iso("17:14", 9),
              AimedArrivalTime: iso("17:14"),   ExpectedArrivalTime: iso("17:14", 9)
            }}},
        /* express with an unparseable vehicle ref → must match on aimed time */
        { MonitoringRef: "70172",
          MonitoredVehicleJourney: {
            LineRef: "L5", DirectionRef: "SOUTH",
            FramedVehicleJourneyRef: {DatedVehicleJourneyRef:"CT:2026-08-14:xyz"},
            DestinationName: "SAN JOSE DIRIDON", VehicleRef: "",
            MonitoredCall: {
              StopPointRef: "70172",
              AimedDepartureTime: iso("17:59"), ExpectedDepartureTime: iso("17:59", 2)
            }}},
        /* on-time local */
        { MonitoringRef: "70172",
          MonitoredVehicleJourney: {
            VehicleRef: "148", DestinationName: "SAN JOSE DIRIDON",
            MonitoredCall: {
              StopPointRef: "70172",
              AimedDepartureTime: iso("17:44"), ExpectedDepartureTime: iso("17:44"),
              VehicleAtStop: false
            }}}
      ]}}};

const arrPayload = {
  ServiceDelivery: { StopMonitoringDelivery: [{
    MonitoredStopVisit: [
      { MonitoringRef: "70262",
        MonitoredVehicleJourney: {
          VehicleRef: "146",
          MonitoredCall: {StopPointRef:"70262", AimedArrivalTime: iso("17:42"), ExpectedArrivalTime: iso("17:42", 11)}
        }}
    ]}]}};

const alertPayload = {
  header: {gtfs_realtime_version:"2.0"},
  entity: [
    { id: "ct-1",
      alert: {
        active_period: [{start: Math.floor(Date.now()/1000) - 1800}],
        informed_entity: [{agency_id:"CT"}],
        cause: "MEDICAL_EMERGENCY", effect: "SIGNIFICANT_DELAYS",
        header_text: {translation:[{text:"NB and SB trains delayed", language:"en"}]},
        description_text: {translation:[{text:"Expect residual delays of up to 20 minutes.", language:"en"}]}
      }}
  ]};

/* --- mock fetch --- */
const seen = [];
global.fetch = async (url) => {
  const u = String(url); seen.push(u);
  const body = u.includes("stopCode=70172") ? depPayload
             : u.includes("stopCode=70262") ? arrPayload
             : u.includes("servicealerts")  ? alertPayload
             : {};
  /* 511 prefixes JSON with a BOM — include it, the parser must survive it */
  return {ok:true, status:200, text: async () => "\uFEFF" + JSON.stringify(body)};
};

const app = require("./server.js");

(async () => {
  /* ---- unit: train number extraction ---- */
  assert.strictEqual(app.trainNumber({VehicleRef:"146"}), "146");
  assert.strictEqual(app.trainNumber({FramedVehicleJourneyRef:{DatedVehicleJourneyRef:"CT:2026-08-14:xyz"}}), null);
  console.log("ok  train number extraction");

  /* ---- unit: stop normalization, including aimed-time fallback ---- */
  const dep = app.normalizeStop(depPayload, "departure");
  assert.strictEqual(dep.length, 3);
  const t146 = dep.find(d => d.train === "146");
  assert.strictEqual(t146.delayMin, 9, "146 should read 9 min late");
  const t522 = dep.find(d => d.train === "522");
  assert.ok(t522, "express matched to 522 by aimed time 17:59 despite unusable vehicle ref");
  assert.strictEqual(t522.delayMin, 2);
  const t148 = dep.find(d => d.train === "148");
  assert.strictEqual(t148.delayMin, 0, "148 on time");
  console.log("ok  stop normalization + aimed-time fallback + BOM survival");

  /* ---- unit: alert normalization ---- */
  const alerts = app.normalizeAlerts(alertPayload);
  assert.strictEqual(alerts.length, 1);
  assert.match(alerts[0].header, /delayed/i);
  assert.match(alerts[0].body, /20 minutes/);
  console.log("ok  alert normalization");

  /* ---- endpoint: /api/departures ---- */
  await new Promise(r => app.server.listen(8599, r));
  const base = "http://127.0.0.1:8599";
  const realFetch = require("node:http");

  const httpGet = p => new Promise((res, rej) => {
    realFetch.get(base + p, r => { let b = ""; r.on("data", c => b += c); r.on("end", () => res({status:r.statusCode, body:b})); }).on("error", rej);
  });

  const d = JSON.parse((await httpGet("/api/departures")).body);
  const byNo = Object.fromEntries(d.trains.map(t => [t.train, t]));
  assert.strictEqual(byNo["146"].depDelayMin, 9);
  assert.strictEqual(byNo["146"].arrDelayMin, 11, "arrival delay picked up from Diridon board");
  assert.ok(byNo["522"] && byNo["148"]);
  assert.strictEqual(d.stops.departure, "70172");
  console.log("ok  /api/departures merges both stops:", Object.keys(byNo).join(", "));

  /* ---- cache: a second call must not hit upstream again ---- */
  const before = seen.length;
  await httpGet("/api/departures");
  assert.strictEqual(seen.length, before, "second call served from cache");
  console.log("ok  cache prevents duplicate upstream calls");

  /* ---- endpoint: /api/alerts and /api/health ---- */
  const a = JSON.parse((await httpGet("/api/alerts")).body);
  assert.strictEqual(a.alerts.length, 1);
  const h = JSON.parse((await httpGet("/api/health")).body);
  assert.strictEqual(h.tokenConfigured, true);
  assert.ok(h.quotaLeftThisHour <= 55 && h.quotaLeftThisHour >= 50);
  console.log("ok  /api/alerts, /api/health  (upstream calls used:", 55 - h.quotaLeftThisHour + ")");

  /* ---- static serving ---- */
  const page = await httpGet("/");
  assert.strictEqual(page.status, 200);
  assert.match(page.body, /Campus Oval/);
  console.log("ok  dashboard served at /");

  app.server.close();
  console.log("\nall tests passed");
})().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
