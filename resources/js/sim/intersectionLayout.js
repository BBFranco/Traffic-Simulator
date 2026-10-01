/**
 * intersectionLayout.js - one intersection lifted out of a corridor config as
 * a corridor config of its own, for the road editor's test runs: the same
 * arterial (direction, lanes, speed), the same cross street (lanes, one/two-way,
 * median, speed, turning shares), the same lane use and turn lanes, but nothing else - a
 * short run-in and run-out on every side, so traffic arrives straight at this
 * junction instead of via the rest of the network.
 *
 * Node, arterial and connector ids are kept, so lane use edited on the test
 * layout saves straight back to the right places in the real corridor file
 * (CorridorRepository::updateLaneUse()).
 */
import { buildLayout, compassDirection, crossArms } from './corridor.js';

const RUN_IN_M = 170;
const RUN_OUT_M = 120;
const CROSS_STUB_M = 150;
/** A cross street handed over to another road this close past the junction box narrows (or widens) right at the junction. */
const JOINED_AT_JUNCTION_SLACK_M = 6;

/**
 * @param config parsed corridor JSON
 * @param layout buildLayout(config) - for the cross street's resolved heading
 * @param nodeId the intersection to lift out
 * @param demand `{ arterial, cross }` vehicles per lane per minute for the test run
 * @param approachEdits unsaved editor changes to lay over the file's own -
 *   `[{ laneUseKey, laneUse, turnLanes }]` in corridor JSON form (turnLanes null for none)
 */
export function buildIntersectionConfig(config, layout, nodeId, demand, approachEdits = []) {
    const rawArterial = config.arterials.find((a) => a.intersections.some((n) => n.id === nodeId));
    const rawNode = rawArterial.intersections.find((n) => n.id === nodeId);
    const node = layout.nodesById.get(nodeId);
    const arterial = layout.arterials.find((a) => a.id === rawArterial.id);
    const connector = layout.connectors.find((c) => c.id === node.connectorId) ?? null;
    const rawConnector = connector ? config.connectors.find((c) => c.id === connector.id) : null;

    const testConfig = {
        id: `${config.id}:${nodeId}`,
        name: node.name,
        defaults: config.defaults ?? {},
        arterials: [
            {
                id: arterial.id,
                name: arterial.name,
                shortName: arterial.shortName,
                direction: rawArterial.direction,
                oneWay: arterial.oneWay,
                medianWidthM: arterial.medianWidthM,
                lanes: arterial.lanes,
                targetSpeedKph: arterial.targetSpeedKph,
                mode: 'fixed',
                origin: { xM: 0, yM: 0 },
                approachLengthM: RUN_IN_M,
                exitLengthM: RUN_OUT_M,
                demand: { spawnRatePerLanePerMin: demand.arterial, saturationFlowPerLanePerHour: arterial.demand.saturationFlowPerLanePerHour },
                intersections: [
                    {
                        id: nodeId,
                        name: node.name,
                        distanceToNextM: null,
                        crossStreetName: rawNode.crossStreetName,
                        crossStreetLanes: rawNode.crossStreetLanes,
                        laneUse: rawNode.laneUse,
                        turnLanes: rawNode.turnLanes,
                    },
                ],
            },
        ],
        connectors: [],
    };

    if (connector) {
        testConfig.connectors.push({
            id: connector.id,
            name: connector.name,
            lanes: connector.lanes,
            twoWay: connector.twoWay,
            medianWidthM: connector.medianWidthM,
            targetSpeedKph: connector.targetSpeedKph,
            crossChance: connector.crossChance,
            turnChance: connector.turnChance,
            mode: 'fixed',
            demand: { spawnRatePerLanePerMin: demand.cross, saturationFlowPerLanePerHour: connector.demand.saturationFlowPerLanePerHour },
            linksArterialNodes: [nodeId],
            // Same compass direction as the real street, so its lane use keys (northbound, ...) still match.
            direction: compassDirection(node.crossAxis),
            stubLengthM: CROSS_STUB_M,
            laneUse: rawConnector?.laneUse?.[nodeId] ? { [nodeId]: rawConnector.laneUse[nodeId] } : {},
            turnLanes: rawConnector?.turnLanes?.[nodeId] ? { [nodeId]: rawConnector.turnLanes[nodeId] } : {},
        });
        keepTJunction(testConfig.connectors[0], connector, node);
        addJoinedContinuations(testConfig, config, layout, connector, node);
    }

    for (const edit of approachEdits) applyApproachEdit(testConfig, nodeId, edit);

    return testConfig;
}

/**
 * Where the real cross street hands over to another road right at this junction
 * (Duxbury going 2 + 2 to 1 + 1 across Lynnwood, Grosvenor narrowing at Burnett),
 * the test layout does the same on that side: the street's stub stops where the
 * real one does and the other road carries on from there, joined like the real
 * pair - so that arm shows the road that's actually there, and only the lanes it
 * lines up with get arrows (corridor.js's coveredLanes).
 *
 * The test street runs in the compass direction of the real one's heading here,
 * so its start and end sides match the real street's.
 */
function addJoinedContinuations(testConfig, config, layout, connector, node) {
    if (node.crossSplit) {
        addSplitArm(testConfig, config, node);
        return;
    }
    const index = connector.nodeIds.indexOf(node.id);
    const fwdCentreM = connector.stubStartM + connector.nodeOffsetsM[index];
    const maxStubM = node.arterialRoadWidthM / 2 + JOINED_AT_JUNCTION_SLACK_M;
    const plainJoins = (config.joins ?? []).filter((join) => join.toAtM == null && join.fromAtM == null);
    const continuationOf = (ref) => layout.connectors.find((c) => `${c.id}:fwd` === ref) ?? null;

    const sides = [];
    const endJoin = index === connector.nodeIds.length - 1 ? plainJoins.find((join) => join.from === `${connector.id}:fwd`) : null;
    const endRoad = endJoin && continuationOf(endJoin.to);
    if (endRoad && connector.routeLengthM - fwdCentreM <= maxStubM) sides.push({ side: 'end', road: endRoad, stubM: connector.routeLengthM - fwdCentreM });
    const startJoin = index === 0 ? plainJoins.find((join) => join.to === `${connector.id}:fwd`) : null;
    const startRoad = startJoin && continuationOf(startJoin.from);
    if (startRoad && fwdCentreM <= maxStubM) sides.push({ side: 'start', road: startRoad, stubM: fwdCentreM });
    if (!sides.length) return;

    // Where the test junction sits and which way its street runs - before the stubs are cut short (unjoined, they'd read as T-junctions).
    const centre = buildLayout(testConfig).nodesById.get(node.id);
    const heading = centre.crossAxis;
    const street = testConfig.connectors[0];

    testConfig.joins = [];
    for (const { side, road, stubM } of sides) {
        street[side === 'end' ? 'stubEndM' : 'stubStartM'] = stubM;
        // Out from the stub's tip, away from the junction - the continuation's fwd keeps the street's direction of travel.
        const sign = side === 'end' ? 1 : -1;
        const tip = { x: centre.point.x + heading.x * stubM * sign, y: centre.point.y + heading.y * stubM * sign };
        const far = { x: tip.x + heading.x * CROSS_STUB_M * sign, y: tip.y + heading.y * CROSS_STUB_M * sign };
        const [from, to] = side === 'end' ? [tip, far] : [far, tip];
        testConfig.connectors.push({
            id: road.id,
            name: road.name,
            lanes: road.lanes,
            twoWay: road.twoWay,
            medianWidthM: road.medianWidthM,
            targetSpeedKph: road.targetSpeedKph,
            mode: 'fixed',
            demand: street.demand,
            // A straight quadratic: anchor, control halfway, anchor.
            curve: [
                { xM: from.x, yM: from.y },
                { xM: (from.x + to.x) / 2, yM: (from.y + to.y) / 2 },
                { xM: to.x, yM: to.y },
            ],
        });
        testConfig.joins.push(
            ...(side === 'end'
                ? [{ from: `${connector.id}:fwd`, to: `${road.id}:fwd` }, ...(road.twoWay && street.twoWay ? [{ from: `${road.id}:rev`, to: `${connector.id}:rev` }] : [])]
                : [{ from: `${road.id}:fwd`, to: `${connector.id}:fwd` }, ...(road.twoWay && street.twoWay ? [{ from: `${connector.id}:rev`, to: `${road.id}:rev` }] : [])])
        );
    }
}

/**
 * Where the real street stops at this junction (a T), the test street stops
 * there too - a stub of 0 on the missing side - so the junction keeps its T
 * lane use (every lane on the stem turns) instead of gaining an arm it hasn't got.
 */
function keepTJunction(street, connector, node) {
    if (node.crossSplit) return;
    const [fwd, rev] = crossArms(connector, node);
    if (!fwd.hasUpstream) street.stubStartM = 0;
    if (!rev.hasUpstream) street.stubEndM = 0;
}

/**
 * A junction whose cross street is two roads (corridor.js's splitCrossStreet()):
 * the test street ends at the junction and the other road starts there, with its
 * own lanes, arrows and turn lanes, joined straight through like the real pair.
 */
function addSplitArm(testConfig, config, node) {
    const road = node.crossSplit.end.connector;
    const raw = config.connectors.find((c) => c.id === road.id);
    const centre = buildLayout(testConfig).nodesById.get(node.id);
    const heading = centre.crossAxis;
    const street = testConfig.connectors[0];
    street.stubEndM = 0;
    const far = { x: centre.point.x + heading.x * CROSS_STUB_M, y: centre.point.y + heading.y * CROSS_STUB_M };
    testConfig.connectors.push({
        id: road.id,
        name: road.name,
        lanes: road.lanes,
        twoWay: road.twoWay,
        medianWidthM: road.medianWidthM,
        targetSpeedKph: road.targetSpeedKph,
        crossChance: road.crossChance,
        turnChance: road.turnChance,
        mode: 'fixed',
        demand: street.demand,
        linksArterialNodes: [node.id],
        // A straight quadratic out from the junction's centre: anchor, control halfway, anchor.
        curve: [
            { xM: centre.point.x, yM: centre.point.y },
            { xM: (centre.point.x + far.x) / 2, yM: (centre.point.y + far.y) / 2 },
            { xM: far.x, yM: far.y },
        ],
        laneUse: raw?.laneUse?.[node.id] ? { [node.id]: raw.laneUse[node.id] } : {},
        turnLanes: raw?.turnLanes?.[node.id] ? { [node.id]: raw.turnLanes[node.id] } : {},
    });
    testConfig.joins = [
        { from: `${street.id}:fwd`, to: `${road.id}:fwd` },
        ...(road.twoWay && street.twoWay ? [{ from: `${road.id}:rev`, to: `${street.id}:rev` }] : []),
    ];
}

function applyApproachEdit(testConfig, nodeId, { kind, laneUseKey, laneUse, turnLanes, connectorId }) {
    const node = testConfig.arterials[0].intersections[0];
    if (laneUseKey === 'arterial') {
        node.laneUse = laneUse;
        node.turnLanes = turnLanes ?? undefined;
        return;
    }
    // A two-way arterial keys its lane use and turn lanes by direction of travel, like a connector.
    if (kind === 'arterial') {
        node.laneUse = { ...node.laneUse, [laneUseKey]: laneUse };
        node.turnLanes = { ...node.turnLanes, [laneUseKey]: turnLanes ?? undefined };
        return;
    }
    // A split junction's arms are two roads - the edit goes on the one it belongs to.
    const connector = testConfig.connectors.find((c) => c.id === connectorId) ?? testConfig.connectors[0];
    connector.laneUse = { [nodeId]: { ...connector.laneUse[nodeId], [laneUseKey]: laneUse } };
    const byDirection = { ...connector.turnLanes[nodeId], [laneUseKey]: turnLanes ?? undefined };
    connector.turnLanes = { [nodeId]: byDirection };
}

