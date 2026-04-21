import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { analyzeSceneWithGemini, type GeminiSpatialResult } from "./ai/gemini";
import { advanceExecution, createIdleExecutionState } from "./ai/executor";
import { buildExecutionPlan } from "./ai/planner";
import { defaultTasks, factoryScene, humanMotionClips } from "./data/catalog";
import { sampleHumanClip } from "./human/motion";
import {
  MujocoViewport,
  type MujocoViewportHandle,
  type RuntimeRobotViewState,
} from "./sim/MujocoViewport";
import type {
  ExecutionPlan,
  HumanMotionClip,
  PlanExecutionState,
  SimulationSnapshot,
  TaskRequest,
} from "./types";

const prettyPhase = (phase: string): string =>
  ({
    idle: "待机",
    approach: "接近工位",
    reach: "伸手接近",
    hold: "保持",
    support: "协同支撑",
    retreat: "撤离",
  })[phase] ?? phase;

const humanClipByTask: Record<TaskRequest["taskType"], string> = {
  lift_assist: "lift-assist",
  position_assist: "position-assist",
  compliance_support: "compliance-support",
};

const getClipForTask = (taskType: TaskRequest["taskType"]): HumanMotionClip =>
  humanMotionClips.find((clip) => clip.id === humanClipByTask[taskType]) ?? humanMotionClips[0];

const createBootSnapshot = (): SimulationSnapshot => ({
  scene: factoryScene,
  human: sampleHumanClip(humanMotionClips[0], 0),
  robot: {
    mode: "idle",
    endEffector: [0, 0],
    target: [0, 0],
    effort: 0,
    trackingError: 0,
  },
  contact: {
    engaged: false,
    constraint: "none",
    message: "等待 MuJoCo 运行时初始化。",
  },
  plan: createIdleExecutionState(),
  simTime: 0,
});

export default function App() {
  const viewportRef = useRef<MujocoViewportHandle | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState(defaultTasks[0].id);
  const [taskText, setTaskText] = useState(defaultTasks[0].userText);
  const [currentPlan, setCurrentPlan] = useState<ExecutionPlan>(
    buildExecutionPlan(defaultTasks[0]),
  );
  const [execution, setExecution] = useState<PlanExecutionState>(createIdleExecutionState());
  const [snapshot, setSnapshot] = useState<SimulationSnapshot>(createBootSnapshot());
  const [running, setRunning] = useState(false);
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [spatialResult, setSpatialResult] = useState<GeminiSpatialResult | null>(null);
  const [robotRuntime, setRobotRuntime] = useState<RuntimeRobotViewState>({
    endEffector: [0, 0, 0],
    target: [0, 0, 0],
    mode: "idle",
    effort: 0,
    trackingError: 0,
    contact: "等待 MuJoCo 模型加载。",
    loaded: false,
  });

  const selectedTask = useMemo<TaskRequest>(() => {
    const matched = defaultTasks.find((task) => task.id === selectedTaskId) ?? defaultTasks[0];
    return {
      ...matched,
      userText: taskText,
    };
  }, [selectedTaskId, taskText]);

  const activeClip = useMemo(() => getClipForTask(selectedTask.taskType), [selectedTask.taskType]);

  useEffect(() => {
    const plan = buildExecutionPlan(selectedTask);
    const nextExecution = createIdleExecutionState();
    setCurrentPlan(plan);
    setExecution(nextExecution);
    setSnapshot({
      scene: factoryScene,
      human: sampleHumanClip(activeClip, 0),
      robot: {
        mode: "idle",
        endEffector: [0, 0],
        target: [0, 0],
        effort: 0,
        trackingError: 0,
      },
      contact: {
        engaged: false,
        constraint: "none",
        message: "等待仿真启动。",
      },
      plan: nextExecution,
      simTime: 0,
    });
    setSpatialResult(null);
    setAnalysisError(null);
    setRunning(false);
  }, [activeClip, selectedTask]);

  useEffect(() => {
    if (!running) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      setSnapshot((previousSnapshot) => {
        const nextSimTime = Math.min(previousSnapshot.simTime + 0.12, activeClip.duration);
        const nextHuman = sampleHumanClip(activeClip, nextSimTime);
        const nextExecution = advanceExecution(execution, currentPlan, {
          ...previousSnapshot,
          human: nextHuman,
        });
        setExecution(nextExecution);
        if (nextSimTime >= activeClip.duration) {
          setRunning(false);
        }
        return {
          ...previousSnapshot,
          human: nextHuman,
          plan: nextExecution,
          simTime: nextSimTime,
        };
      });
    }, 120);

    return () => window.clearInterval(timer);
  }, [activeClip, currentPlan, execution, running]);

  const handleRobotState = useCallback((state: RuntimeRobotViewState) => {
    setRobotRuntime(state);
    setSnapshot((previousSnapshot) => ({
      ...previousSnapshot,
      robot: {
        mode: state.mode as SimulationSnapshot["robot"]["mode"],
        endEffector: [state.endEffector[0], state.endEffector[2]],
        target: [state.target[0], state.target[2]],
        effort: state.effort,
        trackingError: state.trackingError,
      },
      contact: {
        engaged: state.contact !== "跟随接近中",
        constraint: state.contact === "协同接触中" ? "soft_support" : "none",
        message: state.contact,
      },
    }));
  }, []);

  const handleTaskSelection = (task: TaskRequest): void => {
    setSelectedTaskId(task.id);
    setTaskText(task.userText);
  };

  const handleStart = (): void => {
    if (execution.status === "completed") {
      return;
    }
    setRunning(true);
  };

  const handlePause = (): void => {
    setRunning(false);
    setExecution((previous) => ({
      ...previous,
      status: previous.status === "idle" ? "idle" : "paused",
      reason: "用户暂停仿真。",
    }));
  };

  const handleReset = (): void => {
    const plan = buildExecutionPlan(selectedTask);
    const nextExecution = createIdleExecutionState();
    setCurrentPlan(plan);
    setExecution(nextExecution);
    setSnapshot({
      scene: factoryScene,
      human: sampleHumanClip(activeClip, 0),
      robot: {
        mode: "idle",
        endEffector: [0, 0],
        target: [0, 0],
        effort: 0,
        trackingError: 0,
      },
      contact: {
        engaged: false,
        constraint: "none",
        message: "仿真已重置。",
      },
      plan: nextExecution,
      simTime: 0,
    });
    setSpatialResult(null);
    setAnalysisError(null);
    setRunning(false);
  };

  const handleAnalyzeScene = async (): Promise<void> => {
    if (!viewportRef.current) {
      setAnalysisError("MuJoCo 视图尚未就绪。");
      return;
    }
    setAnalysisBusy(true);
    setAnalysisError(null);
    try {
      const screenshot = await viewportRef.current.capturePng();
      if (!screenshot) {
        throw new Error("无法从当前视图捕获截图。");
      }
      const result = await analyzeSceneWithGemini(screenshot, taskText);
      setSpatialResult(result);
    } catch (error) {
      setAnalysisError(error instanceof Error ? error.message : "Spatial Understanding 调用失败。");
    } finally {
      setAnalysisBusy(false);
    }
  };

  return (
    <main className="app-shell">
      <section className="panel panel-input">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Task UI</p>
            <h1>HIT ExoLimb AI Prototype</h1>
          </div>
          <span className="badge">MuJoCo WASM + Gemini</span>
        </div>
        <p className="intro">
          使用真实 `hitexo.xml` 外肢体模型在浏览器内进行 MuJoCo WASM 仿真，人体动作负责驱动末端目标，
          同时支持加载 AI4AnimationPy 导出的 GLB 人体资产做同屏显示。
        </p>

        <label className="label" htmlFor="task">
          任务描述
        </label>
        <textarea
          id="task"
          className="task-input"
          value={taskText}
          onChange={(event) => setTaskText(event.target.value)}
          rows={4}
        />

        <div className="task-grid">
          {defaultTasks.map((task) => (
            <button
              key={task.id}
              className={`task-chip ${task.id === selectedTaskId ? "active" : ""}`}
              onClick={() => handleTaskSelection(task)}
              type="button"
            >
              <strong>{task.userText}</strong>
              <span>{task.taskType}</span>
            </button>
          ))}
        </div>

        <div className="control-row">
          <button className="control primary" onClick={handleStart} type="button">
            启动
          </button>
          <button className="control" onClick={handlePause} type="button">
            暂停
          </button>
          <button className="control" onClick={handleReset} type="button">
            重置
          </button>
        </div>

        <div className="control-row">
          <button className="control accent" onClick={() => void handleAnalyzeScene()} type="button">
            {analysisBusy ? "分析中..." : "Gemini 场景分析"}
          </button>
        </div>

        <div className="task-summary">
          <div>
            <span className="summary-label">Planner</span>
            <strong>{currentPlan.summary}</strong>
          </div>
          <div>
            <span className="summary-label">Confidence</span>
            <strong>{Math.round(currentPlan.confidence * 100)}%</strong>
          </div>
        </div>
      </section>

      <section className="panel panel-sim">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Simulation Core</p>
            <h2>{snapshot.scene.name}</h2>
          </div>
          <span className={`status-pill ${running ? "live" : ""}`}>
            {running ? "Running" : "Paused"}
          </span>
        </div>

        <MujocoViewport
          ref={viewportRef}
          human={snapshot.human}
          activeSkill={execution.activeSkill}
          running={running}
          onRobotState={handleRobotState}
        />

        <div className="sim-stats">
          <div className="stat-card">
            <span>Human Phase</span>
            <strong>{prettyPhase(snapshot.human.phase)}</strong>
          </div>
          <div className="stat-card">
            <span>Robot Mode</span>
            <strong>{robotRuntime.mode}</strong>
          </div>
          <div className="stat-card">
            <span>MuJoCo</span>
            <strong>{robotRuntime.loaded ? "Real Model Loaded" : "Loading..."}</strong>
          </div>
          <div className="stat-card">
            <span>Sim Time</span>
            <strong>{snapshot.simTime.toFixed(2)} s</strong>
          </div>
        </div>
      </section>

      <section className="panel panel-state">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Execution View</p>
            <h2>技能计划与状态</h2>
          </div>
          <span className="badge subtle">{execution.status}</span>
        </div>

        <div className="state-block">
          <h3>人体状态</h3>
          <p>{snapshot.human.clipName}</p>
          <ul className="detail-list">
            <li>阶段：{prettyPhase(snapshot.human.phase)}</li>
            <li>目标区：{snapshot.human.targetZoneId}</li>
            <li>
              手部轨迹：({snapshot.human.hand[0].toFixed(1)}, {snapshot.human.hand[1].toFixed(1)})
            </li>
          </ul>
        </div>

        <div className="state-block">
          <h3>计划执行</h3>
          <p>{execution.reason}</p>
          <ul className="plan-list">
            {currentPlan.skills.map((skill, index) => (
              <li
                key={`${skill.skillName}-${index}`}
                className={index === execution.activeSkillIndex ? "active" : ""}
              >
                <strong>{skill.skillName}</strong>
                <span>{skill.description}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="state-block">
          <h3>MuJoCo 外肢体</h3>
          <ul className="detail-list">
            <li>
              末端位置：({robotRuntime.endEffector[0].toFixed(3)}, {robotRuntime.endEffector[1].toFixed(3)},{" "}
              {robotRuntime.endEffector[2].toFixed(3)})
            </li>
            <li>
              mocap 目标：({robotRuntime.target[0].toFixed(3)}, {robotRuntime.target[1].toFixed(3)},{" "}
              {robotRuntime.target[2].toFixed(3)})
            </li>
            <li>跟踪误差：{robotRuntime.trackingError.toFixed(4)}</li>
            <li>{robotRuntime.contact}</li>
          </ul>
        </div>

        <div className="state-block">
          <h3>Gemini Spatial Understanding</h3>
          {analysisError ? <p className="error-text">{analysisError}</p> : null}
          {spatialResult ? (
            <>
              <p>已从当前 MuJoCo 视角返回 {spatialResult.points.length} 个结构化目标点。</p>
              <ul className="detail-list">
                {spatialResult.points.slice(0, 6).map((item, index) => (
                  <li key={`${item.label}-${index}`}>
                    {item.label}: [{item.point[0]}, {item.point[1]}]
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p>点击“Gemini 场景分析”后，会把当前仿真截图发送给 Gemini Robotics-ER。</p>
          )}
        </div>
      </section>
    </main>
  );
}
