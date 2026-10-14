// One-off (2026-10-07): Lunnon & Dyer becomes a 3-way stop (all arms stop), and Herold & Lunnon gets its 4th arm -
// Lunnon carries on west of the roundabout into the university (an arm that spawns/absorbs cars, like South and
// Prospect at their roundabouts).
//
//   node scripts/fix-dyer-herold.mjs <config.json> [--out <file>]
import { readFileSync, writeFileSync } from 'node:fs';
import { buildLayout } from '../resources/js/sim/corridor.js';
import { SimulationEngine } from '../resources/js/sim/engine.js';

const WEST_ARM_M = 150;
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const outPath = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : process.argv[2];

const dyerNode = config.arterials.find((a) => a.id === 'lunnon').intersections.find((n) => n.id === 'lunnon_dyer');
dyerNode.control = 'allWayStop';

const west = config.arterials.find((a) => a.id === 'lunnon_west');
if (west.approachLengthM === 0) {
    west.approachLengthM = WEST_ARM_M;
    config.routing.blocks.push({ id: 'LNW-0', from: 'lunnon_west:start', to: 'herold_lunnon', tier: 2 });
}

new SimulationEngine(buildLayout(config));
writeFileSync(outPath, JSON.stringify(config, null, 4) + '\n');
console.log(`wrote ${outPath}`);
