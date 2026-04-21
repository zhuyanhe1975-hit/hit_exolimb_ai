import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { HumanState, SkillCall } from "../types";
import { BrowserMujocoRuntime } from "./BrowserMujocoRuntime";

export interface RuntimeRobotViewState {
  endEffector: [number, number, number];
  target: [number, number, number];
  mode: string;
  effort: number;
  trackingError: number;
  contact: string;
  loaded: boolean;
}

export interface MujocoViewportHandle {
  capturePng(): Promise<Blob | null>;
}

interface MujocoViewportProps {
  human: HumanState;
  activeSkill?: SkillCall;
  running: boolean;
  jointTest: boolean;
  mode: string;
  loaded: boolean;
  onRobotState: (state: RuntimeRobotViewState) => void;
}

export const MujocoViewport = forwardRef<MujocoViewportHandle, MujocoViewportProps>(
  ({ human, activeSkill, running, jointTest, mode, loaded, onRobotState }, ref) => {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const runtimeRef = useRef<BrowserMujocoRuntime | null>(null);

    useImperativeHandle(ref, () => ({
      capturePng: async () => runtimeRef.current?.capturePng() ?? null,
    }));

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) {
        return;
      }
      const runtime = new BrowserMujocoRuntime({
        canvas,
        onState: onRobotState,
      });
      runtimeRef.current = runtime;
      void runtime.initialize().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "MuJoCo runtime 初始化失败。";
        onRobotState({
          endEffector: [0, 0, 0],
          target: [0, 0, 0],
          mode: "error",
          effort: 0,
          trackingError: 0,
          contact: message,
          loaded: false,
        });
      });

      return () => {
        runtime.dispose();
      };
    }, [onRobotState]);

    useEffect(() => {
      runtimeRef.current?.setRunning(running);
    }, [running]);

    useEffect(() => {
      runtimeRef.current?.setJointTestMode(jointTest);
    }, [jointTest]);

    useEffect(() => {
      runtimeRef.current?.setHumanControl(human, activeSkill);
    }, [human, activeSkill]);

    return (
      <div className="viewport-shell">
        <canvas ref={canvasRef} className="mujoco-canvas" />
      </div>
    );
  },
);

MujocoViewport.displayName = "MujocoViewport";
