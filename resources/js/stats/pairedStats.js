/**
 * stats/pairedStats.js - the seed-paired statistics the dissertation's analysis scripts compute with scipy
 * (dissertation_output/analysis/analyse.py), in plain JS so the results report's appendix (resultsAppendix.js)
 * prints the same numbers: t-based 95% intervals, the paired t test, Shapiro-Wilk (Royston's AS R94, as scipy and R),
 * the Wilcoxon signed-rank test (exact without ties or zeros, else the normal approximation), and Friedman's test with
 * Kendall's W.
 *
 * `paired()` picks the test the scripts pick: the paired t test when Shapiro-Wilk does not reject normality of the
 * differences at .05, otherwise Wilcoxon.
 */

export const mean = (values) => values.reduce((sum, v) => sum + v, 0) / values.length;

export function sd(values) {
    const m = mean(values);
    return Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1));
}

export function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length / 2;
    return sorted.length % 2 ? sorted[Math.floor(mid)] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Half-width of the 95% t interval of the mean. */
export function ci95(values) {
    const n = values.length;
    return n < 2 ? null : tQuantile975(n - 1) * (sd(values) / Math.sqrt(n));
}

/** a = treatment, b = baseline, paired by index. */
export function paired(a, b) {
    const d = a.map((v, i) => v - b[i]);
    const n = d.length;
    const md = mean(d);
    const sdd = sd(d);
    const t = tQuantile975(n - 1);
    const pct = a.map((v, i) => (100 * (v - b[i])) / b[i]);
    const tP = sdd > 0 ? tTwoSidedP(md / (sdd / Math.sqrt(n)), n - 1) : NaN;
    const wP = wilcoxonP(d);
    const swP = sdd > 0 ? shapiroWilkP(d) : NaN;
    const test = swP >= 0.05 ? 'paired t' : 'Wilcoxon';
    return {
        n,
        meanA: mean(a),
        meanB: mean(b),
        diff: md,
        ci: (t * sdd) / Math.sqrt(n),
        pct: mean(pct),
        pctCi: (t * sd(pct)) / Math.sqrt(n),
        dz: sdd > 0 ? md / sdd : NaN,
        tP,
        wP,
        swP,
        test,
        p: test === 'paired t' ? tP : wP,
    };
}

/* ------------------------------------------------------------------ distributions */

function logGamma(x) {
    const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
    let y = x;
    const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
    let ser = 1.000000000190015;
    for (const coefficient of c) ser += coefficient / ++y;
    return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function betaContinuedFraction(a, b, x) {
    const tiny = 1e-300;
    let c = 1;
    let d = 1 - ((a + b) * x) / (a + 1);
    if (Math.abs(d) < tiny) d = tiny;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= 300; m += 1) {
        const m2 = 2 * m;
        let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
        d = 1 + aa * d;
        if (Math.abs(d) < tiny) d = tiny;
        c = 1 + aa / c;
        if (Math.abs(c) < tiny) c = tiny;
        d = 1 / d;
        h *= d * c;
        aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
        d = 1 + aa * d;
        if (Math.abs(d) < tiny) d = tiny;
        c = 1 + aa / c;
        if (Math.abs(c) < tiny) c = tiny;
        d = 1 / d;
        const delta = d * c;
        h *= delta;
        if (Math.abs(delta - 1) < 1e-14) break;
    }
    return h;
}

/** The regularised incomplete beta function I_x(a, b). */
function incompleteBeta(x, a, b) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
    return x < (a + 1) / (a + b + 2) ? (front * betaContinuedFraction(a, b, x)) / a : 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

/** Two-sided p of Student's t with `df` degrees of freedom. */
export function tTwoSidedP(t, df) {
    return incompleteBeta(df / (df + t * t), df / 2, 0.5);
}

/** The t value with 2.5% in the upper tail. */
export function tQuantile975(df) {
    let lo = 0;
    let hi = 100;
    for (let i = 0; i < 200; i += 1) {
        const midT = (lo + hi) / 2;
        if (tTwoSidedP(midT, df) > 0.05) lo = midT;
        else hi = midT;
    }
    return (lo + hi) / 2;
}

/** The regularised upper incomplete gamma Q(a, x). */
function upperIncompleteGamma(a, x) {
    if (x <= 0) return 1;
    const lnFront = -x + a * Math.log(x) - logGamma(a);
    if (x < a + 1) {
        let sum = 1 / a;
        let term = sum;
        for (let n = 1; n < 500; n += 1) {
            term *= x / (a + n);
            sum += term;
            if (Math.abs(term) < Math.abs(sum) * 1e-15) break;
        }
        return 1 - sum * Math.exp(lnFront);
    }
    const tiny = 1e-300;
    let b = x + 1 - a;
    let c = 1 / tiny;
    let d = 1 / b;
    let h = d;
    for (let i = 1; i < 500; i += 1) {
        const an = -i * (i - a);
        b += 2;
        d = an * d + b;
        if (Math.abs(d) < tiny) d = tiny;
        c = b + an / c;
        if (Math.abs(c) < tiny) c = tiny;
        d = 1 / d;
        const delta = d * c;
        h *= delta;
        if (Math.abs(delta - 1) < 1e-15) break;
    }
    return Math.exp(lnFront) * h;
}

export function chiSquareSf(x, df) {
    return upperIncompleteGamma(df / 2, x / 2);
}

/** Standard normal upper tail. */
export function normalSf(z) {
    return z >= 0 ? 0.5 * upperIncompleteGamma(0.5, (z * z) / 2) : 1 - 0.5 * upperIncompleteGamma(0.5, (z * z) / 2);
}

/** Standard normal quantile (Acklam's rational approximation, refined by one Newton step). */
export function normalQuantile(p) {
    const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
    const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
    const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
    const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
    const low = 0.02425;
    let x;
    if (p < low) {
        const q = Math.sqrt(-2 * Math.log(p));
        x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    } else if (p <= 1 - low) {
        const q = p - 0.5;
        const r = q * q;
        x = ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
    } else {
        const q = Math.sqrt(-2 * Math.log(1 - p));
        x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    const e = 1 - normalSf(x) - p;
    const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
    return x - u / (1 + (x * u) / 2);
}

/* ------------------------------------------------------------------------- tests */

const poly = (cc, x) => cc.reduceRight((sum, coefficient) => sum * x + coefficient, 0);

/** Shapiro-Wilk p (Royston 1995, AS R94 - the routine scipy.stats.shapiro wraps), for 12 <= n <= 5000; NaN outside. */
export function shapiroWilkP(values) {
    const n = values.length;
    if (n < 12 || n > 5000) return NaN;
    const x = [...values].sort((p, q) => p - q);
    const half = Math.floor(n / 2);
    const m = Array.from({ length: half }, (_, i) => normalQuantile((i + 1 - 0.375) / (n + 0.25)));
    const summ2 = 2 * m.reduce((sum, v) => sum + v * v, 0);
    const ssumm2 = Math.sqrt(summ2);
    const rsn = 1 / Math.sqrt(n);
    const a1 = poly([0, 0.221157, -0.147981, -2.07119, 4.434685, -2.706056], rsn) - m[0] / ssumm2;
    const a2 = -m[1] / ssumm2 + poly([0, 0.042981, -0.293762, -1.752461, 5.682633, -3.582633], rsn);
    const fac = Math.sqrt((summ2 - 2 * m[0] ** 2 - 2 * m[1] ** 2) / (1 - 2 * a1 ** 2 - 2 * a2 ** 2));
    const coefficients = m.map((v, i) => (i === 0 ? a1 : i === 1 ? a2 : -v / fac));

    const xMean = mean(x);
    const ssq = x.reduce((sum, v) => sum + (v - xMean) ** 2, 0);
    const numerator = coefficients.reduce((sum, a, i) => sum + a * (x[n - 1 - i] - x[i]), 0);
    const w = Math.min(1, (numerator * numerator) / ssq);

    const ln = Math.log(n);
    const mu = poly([-1.5861, -0.31082, -0.083751, 0.0038915], ln);
    const sigma = Math.exp(poly([-0.4803, -0.082676, 0.0030302], ln));
    return normalSf((Math.log(1 - w) - mu) / sigma);
}

/** Average ranks (1-based) of `values`, ties sharing their mean rank - and each tie group's size. */
function rank(values) {
    const order = values.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
    const ranks = new Array(values.length);
    const ties = [];
    for (let i = 0; i < order.length; ) {
        let j = i;
        while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j += 1;
        for (let k = i; k <= j; k += 1) ranks[order[k][1]] = (i + j) / 2 + 1;
        if (j > i) ties.push(j - i + 1);
        i = j + 1;
    }
    return { ranks, ties };
}

/** Two-sided Wilcoxon signed-rank p on paired differences `d` (zeros dropped, scipy's default). */
export function wilcoxonP(d) {
    const nonZero = d.filter((v) => v !== 0);
    const n = nonZero.length;
    if (!n) return NaN;
    const { ranks, ties } = rank(nonZero.map(Math.abs));
    const rPlus = ranks.reduce((sum, r, i) => sum + (nonZero[i] > 0 ? r : 0), 0);
    const total = (n * (n + 1)) / 2;
    const stat = Math.min(rPlus, total - rPlus);

    if (n <= 50 && !ties.length && nonZero.length === d.length) {
        // Exact null distribution of the rank sum: counts[s] = subsets of 1..n summing to s.
        const counts = new Float64Array(total + 1);
        counts[0] = 1;
        for (let k = 1; k <= n; k += 1) for (let s = total; s >= k; s -= 1) counts[s] += counts[s - k];
        let below = 0;
        for (let s = 0; s <= stat; s += 1) below += counts[s];
        return Math.min(1, (2 * below) / 2 ** n);
    }
    const mn = total / 2;
    const se = Math.sqrt((n * (n + 1) * (2 * n + 1)) / 24 - ties.reduce((sum, t) => sum + (t ** 3 - t), 0) / 48);
    return Math.min(1, 2 * normalSf(Math.abs(stat - mn) / se));
}

/** Friedman's test over `columns` (k treatments, each n paired values), with Kendall's W. */
export function friedman(columns) {
    const k = columns.length;
    const n = columns[0].length;
    const rankSums = new Array(k).fill(0);
    let tieSum = 0;
    for (let i = 0; i < n; i += 1) {
        const { ranks, ties } = rank(columns.map((column) => column[i]));
        ranks.forEach((r, j) => (rankSums[j] += r));
        tieSum += ties.reduce((sum, t) => sum + (t ** 3 - t), 0);
    }
    const raw = (12 / (n * k * (k + 1))) * rankSums.reduce((sum, r) => sum + r * r, 0) - 3 * n * (k + 1);
    const chi2 = raw / (1 - tieSum / (n * (k ** 3 - k)));
    return { chi2, p: chiSquareSf(chi2, k - 1), w: chi2 / (n * (k - 1)) };
}
