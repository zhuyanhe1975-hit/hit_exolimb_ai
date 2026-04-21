import type {
  ControlInput,
  ExecutionPlan,
  HumanModelSpec,
  HumanMotionClip,
  SceneSpec,
  SimulationSnapshot,
  TaskRequest
} from "../types";

export interface SimulationAdapter {
  loadScene(sceneSpec: SceneSpec): void;
  loadHuman(humanSpec: HumanModelSpec, motionClips: HumanMotionClip[]): void;
  loadRobot(robotSpec: { id: string; name: string }): void;
  reset(task: TaskRequest, plan: ExecutionPlan): void;
  step(input: ControlInput): SimulationSnapshot;
  getState(): SimulationSnapshot;
}
