import type { ExecutionPlan, SkillCall, TaskRequest } from "../types";

const createSkill = (
  skillName: SkillCall["skillName"],
  description: string,
  entryPhase: string,
  exitPhase: string,
  args: SkillCall["args"],
): SkillCall => ({
  skillName,
  description,
  args,
  entryCondition: {
    type: entryPhase === "always" ? "always" : "human_phase",
    value: entryPhase
  },
  exitCondition: {
    type: exitPhase === "target_bin" || exitPhase === "workbench" ? "hand_zone" : "human_phase",
    value: exitPhase
  },
  failureCondition: {
    type: "plan_complete",
    value: "manual_stop"
  }
});

export const buildExecutionPlan = (task: TaskRequest): ExecutionPlan => {
  const commonPrefix = [
    createSkill(
      "move_to_ready_pose",
      "将外肢体移动到人体附近的预备支援位。",
      "approach",
      "reach",
      { stiffness: 0.45, clearance: 0.12 },
    ),
    createSkill(
      "plan_reach_trajectory",
      "根据人体手部轨迹规划辅助接近路径。",
      "reach",
      task.targetZoneId,
      { smoothing: 0.78, anticipation: 0.25 },
    )
  ];

  const plans: Record<TaskRequest["taskType"], SkillCall[]> = {
    lift_assist: [
      ...commonPrefix,
      createSkill(
        "force_control_hold",
        "在目标区提供托举与稳定支撑。",
        "hold",
        "support",
        { supportForce: 16, compliance: 0.62 },
      ),
      createSkill(
        "follow_human_arm",
        "在支撑阶段跟随人体上肢运动。",
        "support",
        "retreat",
        { trackingGain: 0.72, offsetX: 6, offsetY: -2 },
      ),
      createSkill(
        "retreat_to_safe_pose",
        "人体撤离后回到安全姿态。",
        "retreat",
        "retreat",
        { safeHeight: 12 },
      )
    ],
    position_assist: [
      ...commonPrefix,
      createSkill(
        "position_tracking",
        "沿目标区执行精确位置跟踪。",
        "hold",
        "support",
        { trackingGain: 0.84, targetBiasX: 4, targetBiasY: -4 },
      ),
      createSkill(
        "follow_human_arm",
        "在对位完成后维持与人体手臂的协同移动。",
        "support",
        "retreat",
        { trackingGain: 0.7, offsetX: 4, offsetY: -4 },
      ),
      createSkill(
        "retreat_to_safe_pose",
        "完成目标点辅助后退出。",
        "retreat",
        "retreat",
        { safeHeight: 12 },
      )
    ],
    compliance_support: [
      createSkill(
        "move_to_ready_pose",
        "从待命位进入工作台旁预备支撑位。",
        "approach",
        "reach",
        { stiffness: 0.32, clearance: 0.08 },
      ),
      createSkill(
        "follow_human_arm",
        "根据人体靠近工位的动作进行顺应跟随。",
        "reach",
        "hold",
        { trackingGain: 0.6, offsetX: 3, offsetY: -3 },
      ),
      createSkill(
        "force_control_hold",
        "在工作台附近提供柔顺力控支撑。",
        "hold",
        "support",
        { supportForce: 8, compliance: 0.84 },
      ),
      createSkill(
        "retreat_to_safe_pose",
        "支撑任务结束后回到安全区。",
        "retreat",
        "retreat",
        { safeHeight: 12 },
      )
    ]
  };

  return {
    id: `plan-${task.id}`,
    summary: `${task.userText} -> ${plans[task.taskType].length} 个技能步骤`,
    taskType: task.taskType,
    confidence: 0.81,
    fallbackSkill: "retreat_to_safe_pose",
    skills: plans[task.taskType]
  };
};
