# Car sprites

Drop top-down car PNGs in this folder.

Conventions the renderer will assume (build step 15):

- **Single orientation: facing up / north.** The renderer applies a rotation
  transform for the car's current heading, so every sprite must start pointing
  the same way or half the fleet will drive sideways.
- **~32–48 px on the long axis**, and roughly consistent visual scale between
  sprites — a car agent is 4.5 m long in world units, so wildly different sprite
  sizes will read as wildly different cars.
- Transparent background.
- Any filename; sprites are picked at random per car. That pick draws from the
  seeded PRNG (build step 16), not `Math.random()`, or seed determinism breaks.

Empty in Phase 1: there are no cars to draw yet.
