import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { analyzeSceneWithGemini, type GeminiSpatialResult } from "./ai/gemini";
import { WebcamUpperBodyPanel } from "./camera/WebcamUpperBodyPanel";
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
  HumanState,
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
  const [jointTest, setJointTest] = useState(false);
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [spatialResult, setSpatialResult] = useState<GeminiSpatialResult | null>(null);
  const [cameraDriveEnabled, setCameraDriveEnabled] = useState(false);
  const [cameraHuman, setCameraHuman] = useState<HumanState | null>(null);
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
  const displayHuman = cameraDriveEnabled && cameraHuman ? cameraHuman : snapshot.human;
  const activeSkillLabel =
    jointTest
      ? "六轴测试"
      : execution.activeSkill?.skillName ?? currentPlan.skills[execution.activeSkillIndex]?.skillName ?? "待机";
  const runtimeLabel = robotRuntime.loaded
    ? "MuJoCo Live"
    : robotRuntime.mode === "fallback"
      ? "Fallback"
      : "Loading";
  const compactTaskLabel =
    defaultTasks.find((task) => task.id === selectedTaskId)?.userText ?? selectedTask.userText;

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
    setCameraHuman(null);
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
    setJointTest(false);
    setCameraHuman(null);
  };

  const handleToggleJointTest = (): void => {
    setJointTest((previous) => !previous);
  };

  const handleToggleCameraDrive = (): void => {
    setCameraDriveEnabled((previous) => !previous);
    setCameraHuman(null);
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
    <main className="app-shell minimal-shell">
      <section className="hero-stage">
        <MujocoViewport
          ref={viewportRef}
          human={displayHuman}
          activeSkill={execution.activeSkill}
          running={running}
          jointTest={jointTest}
          mode={robotRuntime.mode}
          loaded={robotRuntime.loaded}
          onRobotState={handleRobotState}
        />

        <div className="hud hud-top">
          <div className="hud-brand">
            <span className="eyebrow">HIT ExoLimb AI</span>
            <h1>ExoLimb Viewer</h1>
          </div>
          <div className="hud-pills">
            <span className={`status-pill ${running ? "live" : ""}`}>{running ? "运行中" : "已暂停"}</span>
            <span className={`status-pill ${jointTest ? "live" : ""}`}>{jointTest ? "关节测试" : "任务模式"}</span>
            <span className={`status-pill ${cameraDriveEnabled ? "live" : ""}`}>
              {cameraDriveEnabled ? "Camera Drive" : "Preset Motion"}
            </span>
            <span className="status-pill">{runtimeLabel}</span>
          </div>
        </div>

        <div className="hud hud-left">
          <div className="floating-panel task-switcher">
            {defaultTasks.map((task) => (
              <button
                key={task.id}
                className={`task-tab ${task.id === selectedTaskId ? "active" : ""}`}
                onClick={() => handleTaskSelection(task)}
                type="button"
              >
                {task.userText}
              </button>
            ))}
          </div>
        </div>

        <div className="hud hud-bottom">
          <div className="floating-panel quick-stats">
            <div className="mini-stat">
              <span>任务</span>
              <strong>{compactTaskLabel}</strong>
            </div>
            <div className="mini-stat">
              <span>阶段</span>
              <strong>{prettyPhase(displayHuman.phase)}</strong>
            </div>
            <div className="mini-stat">
              <span>技能</span>
              <strong>{activeSkillLabel}</strong>
            </div>
            <div className="mini-stat">
              <span>时间</span>
              <strong>{snapshot.simTime.toFixed(1)}s</strong>
            </div>
          </div>

          <div className="floating-panel control-dock">
            <button className="control primary" onClick={handleStart} type="button">
              启动
            </button>
            <button className="control" onClick={handlePause} type="button">
              暂停
            </button>
            <button className="control" onClick={handleReset} type="button">
              重置
            </button>
            <button className={`control ${jointTest ? "primary" : ""}`} onClick={handleToggleJointTest} type="button">
              {jointTest ? "停止测试" : "关节测试"}
            </button>
            <button
              className={`control ${cameraDriveEnabled ? "primary" : ""}`}
              onClick={handleToggleCameraDrive}
              type="button"
            >
              {cameraDriveEnabled ? "Close Camera" : "Camera Drive"}
            </button>
            <button className="control accent" onClick={() => void handleAnalyzeScene()} type="button">
              {analysisBusy ? "分析中" : "分析"}
            </button>
          </div>
        </div>

        {cameraDriveEnabled ? (
          <div className="hud hud-right camera-hud">
            <WebcamUpperBodyPanel enabled={cameraDriveEnabled} onHumanState={setCameraHuman} />
          </div>
        ) : null}

        {(analysisError ?? spatialResult) ? (
          <div className="hud hud-right">
            <div className="floating-panel status-note">
              <span className="summary-label">Gemini</span>
              <strong>
                {analysisError
                  ? analysisError
                  : `识别到 ${spatialResult?.points.length ?? 0} 个目标点`}
              </strong>
            </div>
          </div>
        ) : null}
      </section>
    </main>
  );
}
