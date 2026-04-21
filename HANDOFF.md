# Development Handoff

## Repository

- GitHub remote target: `https://github.com/zhuyanhe1975-hit/hit_exolimb_ai.git`
- Local workspace: `F:\hit_exolimb_ai`

## What We Built

We created a greenfield web prototype for a human-exolimb collaboration workflow.

Current architecture:

- React + TypeScript + Vite frontend
- MuJoCo WASM runtime running the real exolimb model from `hitexo.xml`
- Three.js rendering for the exolimb meshes and the human visual layer
- Rule-based planner and execution state machine
- Human motion clip playback for coordination timing
- Optional Gemini Spatial Understanding entry point from simulation screenshots

## MuJoCo Exolimb Integration

The real exolimb model has been migrated from:

- `F:\myWorks\hitexolimb-vip\mujocoC++\model\serial`

Into this repository:

- `public/assets/mujoco/serial/hitexo.xml`
- `public/assets/mujoco/serial/*.STL`
- `public/assets/mujoco/common/*.xml`

Important implementation note:

- We do not bundle `@mujoco/mujoco` directly through Vite at runtime.
- Instead, `mujoco.js` and `mujoco.wasm` are copied into `public/vendor/mujoco/`.
- The frontend dynamically imports `/vendor/mujoco/mujoco.js` to avoid Vite worker parsing issues.

Main runtime file:

- `src/sim/BrowserMujocoRuntime.ts`

## Human Model Strategy

We agreed on this split:

- `ai4animationpy` will be used offline to prepare human visual assets and motion assets.
- Online runtime will use AI for coordination planning, not full human motion synthesis.

Current implementation status:

- The frontend now supports an optional AI4AnimationPy-exported human GLB:
  - expected path: `public/assets/human/ai4animation/worker.glb`
- If the file does not exist, the system falls back to a proxy human mesh so development is not blocked.
- Human clip timing still comes from the local `HumanMotionClip` data.
- Human hand motion is mapped to the MuJoCo mocap target (`ikdummy`) for exolimb following.

Relevant files:

- `src/data/catalog.ts`
- `src/human/motion.ts`
- `src/sim/BrowserMujocoRuntime.ts`
- `public/assets/human/ai4animation/README.md`

## Gemini / AI Planning

We used the Google browser robotics simulator article as the reference direction.

Current state:

- A Gemini Robotics-ER integration stub exists in `src/ai/gemini.ts`
- It captures a screenshot from the current MuJoCo view
- It sends the image plus task prompt to Gemini
- It expects structured spatial points back

This is currently optional and requires:

- `.env.local`
- `VITE_GEMINI_API_KEY=...`

## Current Demo Scope

Implemented task flow is still a prototype baseline:

- choose a task
- play a human motion clip
- run exolimb following/support logic
- visualize execution state

The more specific target scenario we discussed but have not yet implemented end-to-end is:

1. human lifts an overhead panel into place
2. exolimb raises and takes over support
3. human frees both hands
4. human performs screw-fastening operations

## Recommended Next Steps

1. Export a human asset from AI4AnimationPy
   - ideally `worker.glb`
   - include animation clips like:
     - `lift_panel`
     - `handover_support`
     - `compliance_hold`

2. Replace current placeholder human clips with the overhead panel assembly sequence
   - `lift_panel`
   - `stabilize_panel`
   - `handover_to_exolimb`
   - `dual_hand_screwing`

3. Add a panel object to the Three.js scene
   - attach it to human hands during lift
   - transfer support ownership to exolimb during handover

4. Upgrade the planner/state machine to the exact assembly scenario
   - human phase
   - exolimb takeover trigger
   - support stability condition
   - screw-operation phase

## Conversation Summary

Key decisions made during this session:

- The project should stay focused on AI + visualization + MuJoCo WASM.
- Real exolimb model should be migrated into the repo and used in-browser.
- Human motion is important, but for now should be generated offline.
- AI4AnimationPy is better used as an offline human asset and motion pipeline, not as the browser runtime itself.
- Its human visual quality is desirable, so we prepared the frontend to load its exported GLB assets.
- Online AI should plan coordination between human action phases and exolimb support skills.

## Verification

Verified before handoff:

- `npm run build` passes successfully.

## Notes

- Build output currently warns that the JS bundle is large. This does not block development.
- No remote was configured initially; remote needs to be set to GitHub before first push.
