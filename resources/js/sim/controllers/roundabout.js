/**
 * controllers/roundabout.js - a junction with no signals where drivers give way
 * to traffic already in the roundabout.
 *
 * Like the all-way stop, entry is decided by the engine per car, not by a phase
 * timer (engine.js#_updateRoundaboutReleases): a car nearing its yield line is
 * let in unless a car already in the roundabout will pass in front of its
 * entry on the way round - traffic circulates clockwise (left-hand traffic), so
 * that's traffic from the right. A left turn passes no other entry, straight on
 * one, a right turn two. Once a driver has waited ROUNDABOUT_MAX_YIELD_S, only
 * their approach goes until they're in - the gap a steady stream eventually
 * leaves. Once in, a car drives round the island to its exit
 * (engine.js#_roundaboutPath()); the circle's size is corridor.js's
 * shapeRoundabout().
 */

/** Speed a car slows to entering the roundabout, and drives round it at (km/h). */
export const ROUNDABOUT_SPEED_KPH = 25;
/** A car this close to its yield line is let in when it has nobody to give way to (m). */
export const ROUNDABOUT_ENTRY_WINDOW_M = 12;
/** A driver kept waiting this long gets the next gap - everyone else holds until they're in (s). */
export const ROUNDABOUT_MAX_YIELD_S = 6;
/** A car let in that still hasn't reached the roundabout after this long stops holding everyone else out (s). */
export const ROUNDABOUT_OCCUPANT_TIMEOUT_S = 20;

export class RoundaboutController {
    // Never green in the signal sense - like AllWayStopController, the engine
    // checks each car's own release (car.releasedNodeIds) instead.
    isArterialGreen() {
        return false;
    }

    isCrossGreen() {
        return false;
    }

    tick() {}
}
