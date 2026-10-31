/**
 * "Export CSV" for /results - the same live payload the PDF reads, as two flat tables: every condition's
 * means (with their 95% CIs, the zone scopes and the outage segments) and every paired comparison against fixed-time.
 * One row per condition/comparison, one column per field, so it opens straight into a spreadsheet or pandas.
 */
import { reportFileName } from './resultsFileName.js';

/** A CSV cell: quoted when it holds a comma, quote or line break; null/undefined are empty. */
function cell(value) {
    if (value === null || value === undefined) return '';
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Columns in order of first appearance across the rows, so a field only some rows carry still gets a column. */
export function toCsv(rows) {
    const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    const lines = [columns.map(cell).join(',')];
    for (const row of rows) lines.push(columns.map((column) => cell(row[column])).join(','));

    return lines.join('\r\n');
}

function download(fileName, csv) {
    // The BOM makes Excel read it as UTF-8 (the "±" and "—" in labels, not "Â±").
    const url = URL.createObjectURL(new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' }));
    const link = Object.assign(document.createElement('a'), { href: url, download: fileName });
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

/**
 * @param {object} data the results page's live `#results-data` payload
 * @param {{corridorId: string}} corridor
 */
export function exportResultsCsv(data, { corridorId }) {
    const now = new Date();
    const files = {
        'conditions.csv': data.aggregatesBySensor ?? [],
        'comparisons.csv': data.pairedComparisons ?? [],
    };

    for (const [suffix, rows] of Object.entries(files)) {
        if (rows.length) download(reportFileName(corridorId, data.batchStamp, now, suffix), toCsv(rows));
    }
}
