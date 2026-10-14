#!/usr/bin/env node
/**
 * Confirm the Caltrain stop codes before trusting them.
 *
 *   FIVEONEONE_KEY=your-token node find-stops.js
 *   FIVEONEONE_KEY=your-token node find-stops.js diridon
 *
 * Prints every Caltrain stop whose name matches, with its 511 stop code.
 * Codes ending in 1 are northbound platforms, 2 southbound — this script
 * shows both so you can see which is which. Stop codes change when Caltrain
 * republishes its GTFS, so re-run this if live times stop matching.
 */

const KEY = (process.env.FIVEONEONE_KEY || process.env.API_KEY_511 || "").trim();
const NEEDLE = (process.argv[2] || "palo alto|diridon").toLowerCase();

if (!KEY){
  console.error("Set FIVEONEONE_KEY first. Free token: https://511.org/open-data/token");
  process.exit(1);
}

(async () => {
  const url = new URL("https://api.511.org/transit/stops");
  url.searchParams.set("api_key", KEY);
  url.searchParams.set("operator_id", "CT");
  url.searchParams.set("format", "json");

  const res = await fetch(url);
  const text = (await res.text()).replace(/^\uFEFF/, "");
  if (!res.ok){ console.error("511 returned HTTP " + res.status + ": " + text.slice(0,200)); process.exit(1); }

  const json = JSON.parse(text);
  const stops = json?.Contents?.dataObjects?.ScheduledStopPoint || [];
  const re = new RegExp(NEEDLE, "i");

  const rows = stops
    .filter(s => re.test(String(s.Name || "")))
    .map(s => ({
      code: s.id,
      name: String(s.Name || "").trim(),
      lat: s.Location?.Latitude,
      lon: s.Location?.Longitude
    }))
    .sort((a,b) => String(a.code).localeCompare(String(b.code)));

  if (!rows.length){
    console.log("No Caltrain stops matched /" + NEEDLE + "/. Total stops returned: " + stops.length);
    return;
  }
  console.log("\nCaltrain stops matching /" + NEEDLE + "/\n");
  for (const r of rows) console.log("  " + String(r.code).padEnd(10) + r.name);
  console.log("\nUse the southbound platform code as STOP_DEP (Palo Alto) and STOP_ARR (Diridon).\n");
})().catch(e => { console.error("Failed:", e.message); process.exit(1); });
