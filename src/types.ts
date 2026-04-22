export type HumanPhase =
  | "idle"
  | "approach"
  | "reach"
  | "hold"
  | "support"
  | "retreat";

export type TaskType = "lift_assist" | "position_assist" | "compliance_support";

export type SkillName =
  | "move_to_ready_pose"
  | "plan_reach_trajectory"
  | "position_tracking"
  | "force_control_hold"
  | "follow_human_arm"
  | "retreat_to_safe_pose";

export interface SceneZone {
  id: string;
  label: string;
  position: [number, number];
  size: [number, number];
  kind: "workbench" | "target" | "obstacle" | "human_station" | "robot_station";
}

export interface SceneSpec {
  id: string;
  name: string;
  description: string;
  zones: SceneZone[];
}

export interface HumanJointState {
  shoulder: number;
  elbow: number;
  wrist: number;
}

export interface TrackedVector3 {
  x: number;
  y: number;
  z: number;
}

export interface TrackedHandState {
  wrist: TrackedVector3;
  indexMcp: TrackedVector3;
  pinkyMcp: TrackedVector3;
  middleMcp: TrackedVector3;
  ringMcp: TrackedVector3;
  thumbMcp: TrackedVector3;
  thumbIp: TrackedVector3;
  indexTip: TrackedVector3;
  indexPip: TrackedVector3;
  indexDip: TrackedVector3;
  thumbTip: TrackedVector3;
  middlePip: TrackedVector3;
  middleDip: TrackedVector3;
  middleTip: TrackedVector3;
  ringPip: TrackedVector3;
  ringDip: TrackedVector3;
  ringTip: TrackedVector3;
  pinkyPip: TrackedVector3;
  pinkyDip: TrackedVector3;
  pinkyTip: TrackedVector3;
  handSize: number;
  openness: number;
  pinch: number;
}

export interface TrackedArmState {
  visible: boolean;
  shoulder: TrackedVector3;
  elbow: TrackedVector3;
  wrist: TrackedVector3;
  hand?: TrackedHandState;
}

export interface LiveUpperBodyState {
  enabled: boolean;
  source: "camera";
  bodyScale?: number;
  torsoYaw?: number;
  torsoLean?: number;
  leftArm?: TrackedArmState;
  rightArm?: TrackedArmState;
}

export interface HumanPoseFrame {
  t: number;
  root: [number, number];
  hand: [number, number];
  joints: HumanJointState;
  targetZoneId: string;
  phase: HumanPhase;
}

export interface HumanMotionClip {
  id: string;
  name: string;
  duration: number;
  tags: string[];
  frames: HumanPoseFrame[];
}

export interface HumanModelSpec {
  id: string;
  name: string;
  skeletonJoints: string[];
  defaultRoot: [number, number];
  defaultHand: [number, number];
}

export interface HumanVisualAssetSpec {
  id: string;
  name: string;
  glbPath: string;
  scale: number;
  scenePosition: [number, number, number];
  sceneRotationEulerDeg: [number, number, number];
  animationMap: Partial<Record<TaskType, string>>;
}

export interface HumanState {
  clipId: string;
  clipName: string;
  time: number;
  phase: HumanPhase;
  root: [number, number];
  hand: [number, number];
  joints: HumanJointState;
  targetZoneId: string;
  liveUpperBody?: LiveUpperBodyState;
}

export interface RobotState {
  mode: "idle" | "position" | "trajectory" | "force" | "follow" | "safe";
  endEffector: [number, number];
  target: [number, number];
  effort: number;
  trackingError: number;
}

export interface ContactState {
  engaged: boolean;
  constraint: "none" | "soft_support" | "force_hold";
  message: string;
}

export interface SkillCondition {
  type: "human_phase" | "hand_zone" | "plan_complete" | "always";
  value: string;
}

export interface SkillCall {
  skillName: SkillName;
  description: string;
  args: Record<string, number | string | boolean>;
  entryCondition: SkillCondition;
  exitCondition: SkillCondition;
  failureCondition: SkillCondition;
}

export interface ExecutionPlan {
  id: string;
  summary: string;
  taskType: TaskType;
  confidence: number;
  fallbackSkill: SkillName;
  skills: SkillCall[];
}

export interface TaskRequest {
  id: string;
  userText: string;
  taskType: TaskType;
  targetZoneId: string;
  constraints: string[];
}

export interface PlanExecutionState {
  status: "idle" | "running" | "paused" | "completed" | "failed";
  activeSkillIndex: number;
  activeSkill?: SkillCall;
  reason: string;
}

export interface SimulationSnapshot {
  scene: SceneSpec;
  human: HumanState;
  robot: RobotState;
  contact: ContactState;
  plan: PlanExecutionState;
  simTime: number;
}

export interface ControlInput {
  activeSkill?: SkillCall;
  running: boolean;
  dt: number;
}
