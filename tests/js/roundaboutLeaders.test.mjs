// The two ways cars round a roundabout locked each other (camera seed 20270104 at south_hilda, 2026-10-09).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SimulationEngine } from '../../resources/js/sim/engine.js';
import { buildPolylinePath } from '../../resources/js/sim/car.js';

const { _ringLeader: ringLeader, _sameWayLeader: sameWayLeader } = SimulationEngine.prototype;
const rad = (deg) => (deg * Math.PI) / 180;
const ring = (cars) => ({ node: { point: { x: 0, y: 0 }, roundabout: { circulatingRadiusM: 14.5 } }, cars });
/** A turn path parked at `deg` round the island, at `radiusM` from its centre - all _ringLeader() needs of where a car is. */
const pathAt = (deg, radiusM, fields) => {
    const point = { x: Math.cos(rad(deg)) * radiusM, y: Math.sin(rad(deg)) * radiusM };
    return { ...buildPolylinePath([point, point]), ...fields };
};

test('a car out on its exit leg does not follow a ring car just clockwise of it', () => {
    const exiting = { distanceM: 52.3, turnPath: pathAt(85, 21, { ringExitAtM: 48 }) };
    const circulating = { distanceM: 45.8, speedMps: 0, lengthM: 4.5, turnPath: { ringExitAtM: 90 } };
    const cars = [{ car: exiting, angle: rad(85) }, { car: circulating, angle: rad(89) }];

    assert.equal(ringLeader.call(null, exiting, ring(cars)), null);
});

test('a car still on the ring follows the car 4 degrees ahead of it', () => {
    const onRing = { distanceM: 40, turnPath: pathAt(85, 14.5, { ringExitAtM: 48 }) };
    const ahead = { distanceM: 45.8, speedMps: 0, lengthM: 4.5, turnPath: { ringExitAtM: 90 } };
    const cars = [{ car: onRing, angle: rad(85) }, { car: ahead, angle: rad(89) }];

    const leader = ringLeader.call(null, onRing, ring(cars));
    assert.equal(leader.car, ahead);
    assert.ok(Math.abs(leader.distanceM - onRing.distanceM - rad(4) * 14.5) < 1e-9);
});

test('two cars from one entry whose paths split on the ring: the one behind stops following the other', () => {
    const roadA = {};
    const roadB = {};
    const leader = { road: roadA, lane: 0, turnPath: { lengthM: 52.4 } };
    const uTurner = { road: roadB, lane: 0, distanceM: 45.8, turnPath: { ringNodeId: 'south_hilda', ringEntryAtM: 5, lengthM: 94.7 } };

    assert.equal(sameWayLeader.call(null, uTurner, leader), null);
});

test('two cars from one entry on the same path keep following each other round the ring', () => {
    const road = {};
    const leader = { road, lane: 0, turnPath: { lengthM: 52.4 } };
    const follower = { road, lane: 0, distanceM: 30, turnPath: { ringNodeId: 'south_hilda', ringEntryAtM: 5, lengthM: 52.9 } };

    assert.equal(sameWayLeader.call(null, follower, leader), leader);
});

test('on the shared way in, a car follows the one ahead from its entry whatever its exit', () => {
    const leader = { road: {}, lane: 0, turnPath: { lengthM: 52.4 } };
    const follower = { road: {}, lane: 0, distanceM: 3, turnPath: { ringNodeId: 'south_hilda', ringEntryAtM: 5, lengthM: 94.7 } };

    assert.equal(sameWayLeader.call(null, follower, leader), leader);
});
