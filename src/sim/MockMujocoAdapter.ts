import { sampleHumanClip } from "../human/motion";
import type {
  ContactState,
  ControlInput,
  ExecutionPlan,
  HumanModelSpec,
  HumanMotionClip,
  PlanExecutionState,
  RobotState,
  SceneSpec,
  SimulationSnapshot,
  TaskRequest
} from "../types";
import type { SimulationAdapter } from "./SimulationAdapter";

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const lerp = (from: number, to: number, alpha: number): number =>
  from + (to - from) * alpha;

const lerpPoint = (
  from: [number, number],
  to: [number, number],
  alpha: number,
): [number, number] => [lerp(from[0], to[0], alpha), lerp(from[1], to[1], alpha)];

const initialRobotState = (): RobotState => ({
  mode: "idle",
  endEffector: [72, 68],
  target: [72, 68],
  effort: 0,
  trackingError: 0
});

const initialContactState = (): ContactState => ({
  engaged: false,
  constraint: "none",
  message: "待命中。"
});

export class MockMujocoAdapter implements SimulationAdapter {
  private scene?: SceneSpec;

  private humanSpec?: HumanModelSpec;

  private motionClips: HumanMotionClip[] = [];

  private activeClip?: HumanMotionClip;

  private task?: TaskRequest;

  private plan?: ExecutionPlan;

  private simTime = 0;

  private snapshot: SimulationSnapshot = {
    scene: {
      id: "unloaded",
      name: "Unloaded",
      description: "",
      zones: []
    },
    human: {
      clipId: "none",
      clipName: "none",
      time: 0,
      phase: "idle",
      root: [0, 0],
      hand: [0, 0],
      joints: {
        shoulder: 0,
        elbow: 0,
        wrist: 0
      },
      targetZoneId: ""
    },
    robot: initialRobotState(),
    contact: initialContactState(),
    plan: {
      status: "idle",
      activeSkillIndex: -1,
      reason: "尚未开始。"
    },
    simTime: 0
  };

  loadScene(sceneSpec: SceneSpec): void {
    this.scene = sceneSpec;
    this.snapshot.scene = sceneSpec;
  }

  loadHuman(humanSpec: HumanModelSpec, motionClips: HumanMotionClip[]): void {
    this.humanSpec = humanSpec;
    this.motionClips = motionClips;
    this.activeClip = motionClips[0];
    this.snapshot.human = {
      clipId: this.activeClip.id,
      clipName: this.activeClip.name,
      time: 0,
      phase: "idle",
      root: humanSpec.defaultRoot,
      hand: humanSpec.defaultHand,
      joints: {
        shoulder: 0,
        elbow: 0,
        wrist: 0
      },
      targetZoneId: "workbench"
    };
  }

  loadRobot(_robotSpec: { id: string; name: string }): void {
    this.snapshot.robot = initialRobotState();
  }

  reset(task: TaskRequest, plan: ExecutionPlan): void {
    if (!this.humanSpec || !this.scene) {
      throw new Error("Scene and human must be loaded before reset.");
    }

    this.task = task;
    this.plan = plan;
    this.activeClip = this.resolveClip(task.taskType);
    this.simTime = 0;
    this.snapshot = {
      scene: this.scene,
      human: sampleHumanClip(this.activeClip, 0),
      robot: initialRobotState(),
      contact: initialContactState(),
      plan: {
        status: "idle",
        activeSkillIndex: -1,
        reason: `任务 ${task.id} 已就绪。`
      },
      simTime: 0
    };
  }

  getState(): SimulationSnapshot {
    return this.snapshot;
  }

  step(input: ControlInput): SimulationSnapshot {
    if (!this.activeClip || !this.plan || !this.task) {
      return this.snapshot;
    }

    if (!input.running) {
      return {
        ...this.snapshot,
        plan: {
          ...this.snapshot.plan,
          status: this.snapshot.plan.status === "idle" ? "idle" : "paused",
          reason: "仿真已暂停。"
        }
      };
    }

    this.simTime = clamp(this.simTime + input.dt, 0, this.activeClip.duration);
    const human = sampleHumanClip(this.activeClip, this.simTime);
    const robot = this.updateRobotState(human, input);
    const contact = this.deriveContactState(human, robot, input);

    this.snapshot = {
      ...this.snapshot,
      human,
      robot,
      contact,
      simTime: this.simTime
    };

    return this.snapshot;
  }

  setPlanState(planState: PlanExecutionState): void {
    this.snapshot = {
      ...this.snapshot,
      plan: planState
    };
  }

  private resolveClip(taskType: TaskRequest["taskType"]): HumanMotionClip {
    const resolved =
      this.motionClips.find((clip) => clip.id.includes(taskType.split("_")[0])) ??
      this.motionClips[0];
    return resolved;
  }

  private updateRobotState(
    human: SimulationSnapshot["human"],
    input: ControlInput,
  ): RobotState {
    const current = this.snapshot.robot;
    const skill = input.activeSkill;
    const baseTarget: [number, number] = human.hand;

    let target: [number, number] = current.target;
    let mode: RobotState["mode"] = "idle";
    let effort = current.effort;

    switch (skill?.skillName) {
      case "move_to_ready_pose":
        target = [human.hand[0] + 10, human.hand[1] - 8];
        mode = "position";
        effort = 0.2;
        break;
      case "plan_reach_trajectory":
        target = [baseTarget[0] + 6, baseTarget[1] - 4];
        mode = "trajectory";
        effort = 0.36;
        break;
      case "position_tracking":
        target = [
          baseTarget[0] + Number(skill.args.targetBiasX ?? 4),
          baseTarget[1] + Number(skill.args.targetBiasY ?? -4)
        ];
        mode = "position";
        effort = 0.45;
        break;
      case "force_control_hold":
        target = [baseTarget[0] + 2, baseTarget[1] - 2];
        mode = "force";
        effort = Number(skill.args.supportForce ?? 8) / 20;
        break;
      case "follow_human_arm":
        target = [
          baseTarget[0] + Number(skill.args.offsetX ?? 4),
          baseTarget[1] + Number(skill.args.offsetY ?? -2)
        ];
        mode = "follow";
        effort = 0.42;
        break;
      case "retreat_to_safe_pose":
        target = [74, 66 - Number(skill.args.safeHeight ?? 12) / 3];
        mode = "safe";
        effort = 0.18;
        break;
      default:
        target = current.target;
        mode = "idle";
        effort = 0.08;
        break;
    }

    const alpha = mode === "force" ? 0.18 : 0.12;
    const nextEndEffector = lerpPoint(current.endEffector, target, alpha);
    const trackingError = Math.hypot(
      nextEndEffector[0] - target[0],
      nextEndEffector[1] - target[1],
    );

    return {
      mode,
      endEffector: nextEndEffector,
      target,
      effort,
      trackingError
    };
  }

  private deriveContactState(
    human: SimulationSnapshot["human"],
    robot: RobotState,
    input: ControlInput,
  ): ContactState {
    const distance = Math.hypot(
      robot.endEffector[0] - human.hand[0],
      robot.endEffector[1] - human.hand[1],
    );

    if (!input.activeSkill) {
      return initialContactState();
    }

    if (input.activeSkill.skillName === "force_control_hold" && distance < 6) {
      return {
        engaged: true,
        constraint: "force_hold",
        message: "外肢体正在提供力控托举支撑。"
      };
    }

    if (input.activeSkill.skillName === "follow_human_arm" && distance < 10) {
      return {
        engaged: true,
        constraint: "soft_support",
        message: "外肢体与人体上肢保持柔顺协同。"
      };
    }

    return {
      engaged: false,
      constraint: "none",
      message: "未建立接触，保持协同待命。"
    };
  }
}
