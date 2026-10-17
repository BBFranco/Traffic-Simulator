/**
 * buildStampClient.js - the code a /results batch starting now runs (results.js). A built bundle carries its own
 * stamp. On the dev server the code is the working tree, so a fresh stamp is asked of vite.config.js's /__build-stamp;
 * if that fails the baked one (dirty by default, no `fresh`) is used, which the report reads as "tree state not
 * checked" - never as clean.
 */
export async function currentBuildStamp(baked, fetchFresh = () => fetch(new URL('/__build-stamp', import.meta.url))) {
    if (baked?.source !== 'vite-dev') return baked;
    try {
        const response = await fetchFresh();
        if (!response.ok) return baked;
        const fresh = await response.json();
        return fresh?.fresh === true ? fresh : baked;
    } catch {
        return baked;
    }
}
