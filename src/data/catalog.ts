import type {
  HumanModelSpec,
  HumanMotionClip,
  HumanVisualAssetSpec,
  SceneSpec,
  TaskRequest,
} from "../types";

export const factoryScene: SceneSpec = {
  id: "factory-cell-a",
  name: "Factory Assist Cell",
  description:
    "Prototype workstation for human and exolimb collaboration around a bench and target area.",
  zones: [
    {
      id: "human_station",
      label: "Human Station",
      position: [12, 70],
      size: [18, 18],
      kind: "human_station",
    },
    {
      id: "robot_station",
      label: "Robot Base",
      position: [70, 72],
      size: [14, 16],
      kind: "robot_station",
    },
    {
      id: "workbench",
      label: "Workbench",
      position: [30, 44],
      size: [42, 18],
      kind: "workbench",
    },
    {
      id: "target_bin",
      label: "Target Bin",
      position: [74, 28],
      size: [16, 14],
      kind: "target",
    },
    {
      id: "obstacle",
      label: "Fixture",
      position: [52, 22],
      size: [10, 12],
      kind: "obstacle",
    },
  ],
};

export const humanModel: HumanModelSpec = {
  id: "worker-upper-body-v1",
  name: "Worker Skeleton",
  skeletonJoints: ["root", "spine", "shoulder_right", "elbow_right", "wrist_right"],
  defaultRoot: [22, 72],
  defaultHand: [34, 60],
};

export const humanVisualAsset: HumanVisualAssetSpec = {
  id: "ai4animation-cranberry",
  name: "AI4Animation Cranberry",
  glbPath: "/assets/human/ai4animation/worker.glb",
  scale: 1.02,
  scenePosition: [0, 0, 0],
  sceneRotationEulerDeg: [0, 0, 0],
  animationMap: {
    lift_assist: "lift_panel",
    position_assist: "handover_support",
    compliance_support: "compliance_hold",
  },
};

const makeClip = (
  id: string,
  name: string,
  tags: string[],
  frames: HumanMotionClip["frames"],
): HumanMotionClip => ({
  id,
  name,
  tags,
  duration: frames.length > 0 ? frames[frames.length - 1].t : 0,
  frames,
});

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const pythonPaeDrive = [
  [0.361084, 0.350076, 0.284738, 0.227372, -1.08893],
  [0.205214, -0.209543, -0.153005, -0.123132, -0.212634],
  [0.307394, 0.278718, -0.30348, -0.136405, 0.304364],
  [0.279288, 0.018358, -0.387009, -0.025239, 0.190966],
  [0.159645, 0.142673, -0.044982, -0.005038, 0.115076],
  [0.201914, -0.239892, 0.534679, 0.001893, 0.046197],
  [0.190615, -0.642355, 0.451202, 0.002794, 0.002523],
  [0.190707, 0.078006, -0.16697, -0.002025, -0.129928],
  [0.224358, 0.440757, -0.512972, 0.015562, -0.197131],
  [0.152169, -0.000182, -0.184129, 0.051556, -0.275148],
  [0.247962, -0.395117, 0.228535, 0.16882, -0.269497],
  [0.273289, -0.404988, 0.433492, 0.386265, 0.050522],
  [0.288264, 0.075016, -0.022058, -0.541497, 1.160028],
  [0.322604, 0.315022, -0.478899, 0.064156, 1.377153],
  [0.191412, 0.277653, -0.181389, 0.095307, 0.375082],
  [0.249681, -0.004731, 0.214625, -0.188331, -1.274734],
  [0.230362, -0.196726, 0.48572, -0.036454, -0.512504],
  [0.099083, -0.064421, 0.232231, -0.015036, 0.024251],
  [0.082331, 0.109676, -0.2493, 0.000787, -0.042798],
  [0.094746, 0.08047, -0.467536, -0.00056, -0.027782],
  [0.044006, -0.02987, -0.197334, 0.000203, -0.001666],
  [0.07218, -0.081132, 0.234932, -0.001371, 0.024394],
  [0.084721, -0.074705, 0.401534, 0.000993, 0.0599],
  [0.137454, 0.020275, 0.015853, 0.016076, 0.195003],
  [0.170238, 0.152588, -0.217529, 0.076593, 0.176736],
  [0.251937, 0.132948, -0.160506, 0.397425, -1.163873],
  [0.217488, -0.071658, 0.049827, -0.049232, -0.632952],
  [0.226451, -0.080803, 0.248667, -0.316001, 0.315255],
  [0.222345, -0.079221, -0.104599, -0.121631, 0.462743],
  [0.259908, 0.120029, -0.304511, -0.007465, 0.341998],
  [0.241327, 0.173048, -0.032481, -0.006047, 0.208393],
  [0.275605, -0.222117, 0.126859, -0.000765, 0.184797],
  [0.163296, -0.201747, 0.124745, 0.00125, 0.233593],
  [0.150339, 0.221783, 0.072168, 0.005768, 0.212776],
  [0.130254, 0.16592, -0.112963, 0.019158, 0.023276],
  [0.166582, 0.034257, -0.210182, -0.011923, -0.235121],
  [0.227329, -0.105461, -0.0592, -0.003954, -0.378122],
  [0.297547, -0.144158, 0.167551, 0.01313, -0.295996],
  [0.37311, 0.130459, 0.517096, 0.011727, -0.280541],
  [0.132928, 0.04831, -0.117814, 0.062619, -0.296476],
] as const;

const buildPythonPaeFrames = (): HumanMotionClip["frames"] => {
  let rootX = 22;
  let rootY = 72;

  return pythonPaeDrive.map(([energy, left, right, up, forward], index) => {
    if (index > 0) {
      rootX += 0.08 + energy * 0.32;
      rootY += clamp((right - left) * 0.22, -0.16, 0.16);
    }

    const armSpread = right - left;
    const shoulder = clamp(26 + energy * 82 + armSpread * 16, 16, 62);
    const elbow = clamp(42 + (Math.abs(left) + Math.abs(right)) * 38 + Math.abs(up) * 20, 30, 88);
    const wrist = clamp(armSpread * 26 + forward * 6, -22, 18);
    const handX = clamp(rootX + 11.5 + energy * 14 + armSpread * 5.5, 34, 60);
    const handY = clamp(59 - energy * 18 - up * 7 + Math.abs(forward) * 1.5, 44, 60);

    let phase: HumanMotionClip["frames"][number]["phase"] = "support";
    if (index < 4) {
      phase = index < 1 ? "idle" : index < 2 ? "approach" : index < 4 ? "reach" : "hold";
    } else if (index < 8) {
      phase = "hold";
    } else if (index > pythonPaeDrive.length - 5) {
      phase = "retreat";
    }

    return {
      t: Number((index * 0.2).toFixed(2)),
      root: [Number(rootX.toFixed(2)), Number(rootY.toFixed(2))],
      hand: [Number(handX.toFixed(2)), Number(handY.toFixed(2))],
      joints: {
        shoulder: Number(shoulder.toFixed(2)),
        elbow: Number(elbow.toFixed(2)),
        wrist: Number(wrist.toFixed(2)),
      },
      targetZoneId: index > 6 && index < pythonPaeDrive.length - 4 ? "target_bin" : "workbench",
      phase,
    };
  });
};

export const humanMotionClips: HumanMotionClip[] = [
  makeClip("lift-assist", "AI4AnimationPy Walk Demo", ["python", "walk", "demo"], buildPythonPaeFrames()),
  makeClip("position-assist", "Position Assist", ["position", "assist"], [
    {
      t: 0,
      root: [22, 72],
      hand: [34, 60],
      joints: { shoulder: 18, elbow: 44, wrist: 0 },
      targetZoneId: "workbench",
      phase: "idle",
    },
    {
      t: 1,
      root: [23, 71],
      hand: [44, 55],
      joints: { shoulder: 30, elbow: 52, wrist: 3 },
      targetZoneId: "workbench",
      phase: "approach",
    },
    {
      t: 2.2,
      root: [24, 70],
      hand: [57, 49],
      joints: { shoulder: 44, elbow: 58, wrist: 8 },
      targetZoneId: "target_bin",
      phase: "reach",
    },
    {
      t: 3.6,
      root: [24, 70],
      hand: [70, 35],
      joints: { shoulder: 52, elbow: 65, wrist: 12 },
      targetZoneId: "target_bin",
      phase: "hold",
    },
    {
      t: 5.2,
      root: [23, 71],
      hand: [68, 37],
      joints: { shoulder: 50, elbow: 61, wrist: 10 },
      targetZoneId: "target_bin",
      phase: "support",
    },
    {
      t: 6.4,
      root: [22, 72],
      hand: [37, 59],
      joints: { shoulder: 22, elbow: 47, wrist: 2 },
      targetZoneId: "workbench",
      phase: "retreat",
    },
  ]),
  makeClip("compliance-support", "Compliance Support", ["compliance", "support"], [
    {
      t: 0,
      root: [22, 72],
      hand: [34, 60],
      joints: { shoulder: 18, elbow: 44, wrist: 0 },
      targetZoneId: "workbench",
      phase: "idle",
    },
    {
      t: 1.1,
      root: [22, 71],
      hand: [43, 58],
      joints: { shoulder: 30, elbow: 48, wrist: 4 },
      targetZoneId: "workbench",
      phase: "approach",
    },
    {
      t: 2.4,
      root: [23, 70],
      hand: [51, 56],
      joints: { shoulder: 37, elbow: 50, wrist: 7 },
      targetZoneId: "workbench",
      phase: "reach",
    },
    {
      t: 4.4,
      root: [23, 70],
      hand: [54, 54],
      joints: { shoulder: 38, elbow: 52, wrist: 8 },
      targetZoneId: "workbench",
      phase: "hold",
    },
    {
      t: 5.7,
      root: [23, 70],
      hand: [56, 53],
      joints: { shoulder: 41, elbow: 54, wrist: 8 },
      targetZoneId: "workbench",
      phase: "support",
    },
    {
      t: 6.8,
      root: [22, 72],
      hand: [35, 60],
      joints: { shoulder: 20, elbow: 45, wrist: 1 },
      targetZoneId: "workbench",
      phase: "retreat",
    },
  ]),
];

export const defaultTasks: TaskRequest[] = [
  {
    id: "task-lift",
    userText: "AI4AnimationPy walk demo",
    taskType: "lift_assist",
    targetZoneId: "target_bin",
    constraints: ["soft_contact", "human_led"],
  },
  {
    id: "task-position",
    userText: "Assist upper-limb positioning",
    taskType: "position_assist",
    targetZoneId: "target_bin",
    constraints: ["precise_tracking", "avoid_fixture"],
  },
  {
    id: "task-compliance",
    userText: "Provide compliant support near the bench",
    taskType: "compliance_support",
    targetZoneId: "workbench",
    constraints: ["force_limited", "human_first"],
  },
];
