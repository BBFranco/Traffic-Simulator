/**
 * e.g. results-hatfield-realistic-2026-10-03-2130-794f8bf-dirty.pdf - named for the batch it
 * reports (its start time and code), so two exports can't be mistaken for the same dataset.
 * `suffix` is what follows the base name: 'pdf', or 'conditions.csv'.
 */
export function reportFileName(corridorId, stamp, now, suffix) {
    const at = stamp?.startedAt ? new Date(stamp.startedAt) : now;
    const pad = (n) => String(n).padStart(2, '0');
    const when = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`;
    const treeState = { unchecked: '-dev', unknown: '-unknown', dirty: '-dirty' }[stamp?.treeState] ?? '';
    const code = stamp?.commit ? `-${stamp.commit}${treeState}` : '-unstamped';
    const routing = stamp?.routingMode === 'destination' ? '-destination' : '';
    return `results-${corridorId || 'all-corridors'}-${when}${code}${routing}.${suffix}`;
}
