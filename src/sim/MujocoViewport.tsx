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
  onRobotState: (state: RuntimeRobotViewState) => void;
}

export const MujocoViewport = forwardRef<MujocoViewportHandle, MujocoViewportProps>(
  ({ human, activeSkill, running, onRobotState }, ref) => {
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
      void runtime.initialize();

      return () => {
        runtime.dispose();
      };
    }, [onRobotState]);

    useEffect(() => {
      runtimeRef.current?.setRunning(running);
    }, [running]);

    useEffect(() => {
      runtimeRef.current?.setHumanControl(human, activeSkill);
    }, [human, activeSkill]);

    return <canvas ref={canvasRef} className="mujoco-canvas" />;
  },
);

MujocoViewport.displayName = "MujocoViewport";
