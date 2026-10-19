// Adds the rolling-blackout zones to a corridor config (hatfield-realistic) and writes it back.
//
//   node scripts/add-zones.mjs <config.json> [--out <file>]
//
// A zone is a road property: every horizontal road (an `arterials[]` entry), and every horizontal stub connector and
// slip, gets `"zone": 1|2|3`. A junction takes its horizontal road's zone - the engine derives that at load
// (engine.js's zoneOfNode), so nodes carry no zone of their own. The vertical connectors (Jan Shoba, Hilda, Festival,
// Grosvenor, Dyer Road, Herold Street) get none: their queues count to the zone of the junction they queue at.
//
// Only adds or overwrites `zone` keys - nothing else in the config changes, so it is safe on a user layout too.
import { readFileSync, writeFileSync } from 'node:fs';

/** Zone 1 south, 2 middle, 3 north. */
const ZONES = {
    1: [
        'duxbury', 'duxbury_west', 'lunnon', 'lunnon_west', 'lynnwood', 'dyer_mall',
        'conn_duxbury_east', 'conn_duxbury_south', 'conn_lunnon_w_on', 'conn_lunnon_w_off', 'conn_lunnon_e_off', 'conn_lunnon_e_on',
        'slip_duxbury_janshoba_southbound', 'slip_lynnwood_duxbury_eastbound',
    ],
    2: [
        'arcadia_west', 'arcadia', 'park', 'burnett', 'prospect', 'south', 'south_janshoba_divided',
        'conn_prospect_east', 'conn_prospect_w_on', 'conn_prospect_w_off', 'conn_prospect_e_off', 'conn_prospect_e_on',
        'conn_arcadia_oneway', 'conn_arcadia_east', 'conn_park_east', 'conn_burnett_east', 'conn_south_east',
        'slip_burnett_janshoba_northbound',
    ],
    3: ['stanza', 'pretorius', 'francisbaard'],
};

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const outPath = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : process.argv[2];
const roads = new Map([...config.arterials, ...config.connectors].map((road) => [road.id, road]));

for (const [zone, ids] of Object.entries(ZONES)) {
    for (const id of ids) {
        const road = roads.get(id);
        if (!road) throw new Error(`No road "${id}" in this config.`);
        road.zone = Number(zone);
    }
}
// Every horizontal road needs one: a junction on a road without a zone would never go dark in a rolling blackout.
const missing = config.arterials.filter((arterial) => arterial.zone == null).map((arterial) => arterial.id);
if (missing.length) throw new Error(`Horizontal roads without a zone: ${missing.join(', ')}`);

writeFileSync(outPath, JSON.stringify(config, null, 4) + '\n');
console.log(`Zones written to ${outPath}.`);
