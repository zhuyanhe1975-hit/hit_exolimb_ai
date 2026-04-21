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
  description: "典型工厂协作工位，包含工作台、目标区、障碍区和人机站位。",
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
  id: "ai4animation-worker",
  name: "AI4Animation Worker",
  glbPath: "/assets/human/ai4animation/worker.glb",
  scale: 1,
  scenePosition: [0.15, -0.5, 0],
  sceneRotationEulerDeg: [0, 0, 90],
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

export const humanMotionClips: HumanMotionClip[] = [
  makeClip("lift-assist", "托举保持动作", ["lift", "support"], [
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
      root: [23, 72],
      hand: [42, 56],
      joints: { shoulder: 28, elbow: 56, wrist: 6 },
      targetZoneId: "workbench",
      phase: "approach",
    },
    {
      t: 2,
      root: [24, 71],
      hand: [51, 51],
      joints: { shoulder: 40, elbow: 62, wrist: 10 },
      targetZoneId: "workbench",
      phase: "reach",
    },
    {
      t: 3.5,
      root: [24, 71],
      hand: [58, 44],
      joints: { shoulder: 54, elbow: 70, wrist: 10 },
      targetZoneId: "target_bin",
      phase: "hold",
    },
    {
      t: 5,
      root: [23, 72],
      hand: [56, 46],
      joints: { shoulder: 48, elbow: 67, wrist: 8 },
      targetZoneId: "target_bin",
      phase: "support",
    },
    {
      t: 6.2,
      root: [22, 72],
      hand: [38, 59],
      joints: { shoulder: 22, elbow: 48, wrist: 2 },
      targetZoneId: "workbench",
      phase: "retreat",
    },
  ]),
  makeClip("position-assist", "目标点辅助到位动作", ["position", "assist"], [
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
  makeClip("compliance-support", "柔顺支撑动作", ["compliance", "support"], [
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
    userText: "辅助工人托举并保持工件稳定",
    taskType: "lift_assist",
    targetZoneId: "target_bin",
    constraints: ["soft_contact", "human_led"],
  },
  {
    id: "task-position",
    userText: "帮助上肢把工件稳定送到目标区",
    taskType: "position_assist",
    targetZoneId: "target_bin",
    constraints: ["precise_tracking", "avoid_fixture"],
  },
  {
    id: "task-compliance",
    userText: "在工作台附近提供柔顺支撑",
    taskType: "compliance_support",
    targetZoneId: "workbench",
    constraints: ["force_limited", "human_first"],
  },
];
