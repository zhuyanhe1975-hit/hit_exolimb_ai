Place AI4AnimationPy-exported human assets here.

Expected starter asset:
- `worker.glb`: humanoid model with one or more animations such as
  `lift_panel`, `handover_support`, `compliance_hold`

The current web runtime will:
- load this GLB into the same Three.js scene as the MuJoCo exolimb
- sync the active animation to the selected human motion clip time
- fall back to a proxy human body if the GLB is not present
