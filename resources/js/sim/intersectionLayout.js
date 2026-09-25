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
import { compassDirection } from './corridor.js';

const RUN_IN_M = 170;
const RUN_OUT_M = 120;
const CROSS_STUB_M = 150;

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
    }

    for (const edit of approachEdits) applyApproachEdit(testConfig, nodeId, edit);

    return testConfig;
}

function applyApproachEdit(testConfig, nodeId, { kind, laneUseKey, laneUse, turnLanes }) {
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
    const connector = testConfig.connectors[0];
    connector.laneUse = { [nodeId]: { ...connector.laneUse[nodeId], [laneUseKey]: laneUse } };
    const byDirection = { ...connector.turnLanes[nodeId], [laneUseKey]: turnLanes ?? undefined };
    connector.turnLanes = { [nodeId]: byDirection };
}

