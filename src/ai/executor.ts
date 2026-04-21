import type {
  ExecutionPlan,
  HumanState,
  PlanExecutionState,
  SimulationSnapshot,
  SkillCall
} from "../types";

const matchesCondition = (
  skill: SkillCall | undefined,
  human: HumanState,
  plan: PlanExecutionState,
): boolean => {
  if (!skill) {
    return false;
  }

  switch (skill.entryCondition.type) {
    case "always":
      return true;
    case "human_phase":
      return human.phase === skill.entryCondition.value;
    case "hand_zone":
      return human.targetZoneId === skill.entryCondition.value;
    case "plan_complete":
      return plan.status === "completed";
    default:
      return false;
  }
};

const isSkillComplete = (skill: SkillCall | undefined, human: HumanState): boolean => {
  if (!skill) {
    return false;
  }

  switch (skill.exitCondition.type) {
    case "human_phase":
      return human.phase === skill.exitCondition.value;
    case "hand_zone":
      return human.targetZoneId === skill.exitCondition.value;
    case "always":
      return true;
    case "plan_complete":
      return false;
    default:
      return false;
  }
};

export const createIdleExecutionState = (): PlanExecutionState => ({
  status: "idle",
  activeSkillIndex: -1,
  reason: "等待任务启动。"
});

export const advanceExecution = (
  current: PlanExecutionState,
  plan: ExecutionPlan,
  snapshot: SimulationSnapshot,
): PlanExecutionState => {
  if (current.status === "paused" || current.status === "failed") {
    return current;
  }

  if (current.status === "completed") {
    return current;
  }

  const nextIndex = current.activeSkillIndex < 0 ? 0 : current.activeSkillIndex;
  const activeSkill =
    current.activeSkillIndex < 0 ? plan.skills[0] : current.activeSkill;

  if (current.activeSkillIndex < 0) {
    if (matchesCondition(plan.skills[0], snapshot.human, current)) {
      return {
        status: "running",
        activeSkillIndex: 0,
        activeSkill: plan.skills[0],
        reason: `激活技能 ${plan.skills[0].skillName}`
      };
    }

    return {
      ...current,
      reason: `等待人体进入 ${plan.skills[0].entryCondition.value} 阶段`
    };
  }

  if (isSkillComplete(activeSkill, snapshot.human)) {
    const candidateIndex = nextIndex + 1;
    const candidateSkill = plan.skills[candidateIndex];
    if (!candidateSkill) {
      return {
        status: "completed",
        activeSkillIndex: current.activeSkillIndex,
        activeSkill,
        reason: "计划执行完成。"
      };
    }

    if (matchesCondition(candidateSkill, snapshot.human, current)) {
      return {
        status: "running",
        activeSkillIndex: candidateIndex,
        activeSkill: candidateSkill,
        reason: `切换到 ${candidateSkill.skillName}`
      };
    }

    return {
      ...current,
      reason: `等待 ${candidateSkill.entryCondition.value} 以进入 ${candidateSkill.skillName}`
    };
  }

  return {
    ...current,
    status: "running",
    activeSkill,
    reason: `执行 ${activeSkill?.skillName ?? "unknown"}`
  };
};
