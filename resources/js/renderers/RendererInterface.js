/**
 * RendererInterface.js - the contract every simulator view implements.
 *
 * A renderer is a pure consumer of `engine.snapshot()`. It never writes to the
 * engine, never calls `tick()`, and never touches the RNG, so swapping views
 * mid-run cannot change a single simulated tick - simulator.js's fixed-timestep
 * accumulator decides how many ticks run, the renderer only decides how the
 * latest state looks.
 *
 * @typedef {object} SimRenderer
 * @property {(layout: object) => void} init       Build/replace everything static for a corridor (buildLayout() output).
 * @property {(snapshot: object, alpha: number) => void} update
 *           Draw one frame. `alpha` is the accumulator's progress towards the next tick
 *           (0-1, `accumulatorS / FIXED_DT_S`) - renderers that interpolate use it, others ignore it.
 * @property {() => void} resize                   Re-sync to the host element's CSS size.
 * @property {(theme: 'light'|'dark') => void} setTheme
 * @property {() => void} fit                      Frame the whole corridor.
 * @property {() => void} dispose                  Release every resource (GPU contexts, listeners, observers).
 */

export const VIEW_2D = '2d';
export const VIEW_3D = '3d';
