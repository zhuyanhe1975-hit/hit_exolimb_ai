import { useEffect, useRef, useState } from "react";
import {
  FilesetResolver,
  HandLandmarker,
  type HandLandmarkerResult,
  PoseLandmarker,
  type PoseLandmarkerResult,
} from "@mediapipe/tasks-vision";
import type {
  HumanPhase,
  HumanState,
  LiveUpperBodyState,
  TrackedArmState,
  TrackedHandState,
  TrackedVector3,
} from "../types";

interface WebcamUpperBodyPanelProps {
  enabled: boolean;
  onHumanState: (state: HumanState | null) => void;
}

type ArmSide = "left" | "right";

const POSE_MODEL_PATH =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task";
const HAND_MODEL_PATH =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task";
const WASM_ROOT = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/wasm";

const SHOULDER_INDEX: Record<ArmSide, number> = { left: 11, right: 12 };
const ELBOW_INDEX: Record<ArmSide, number> = { left: 13, right: 14 };
const WRIST_INDEX: Record<ArmSide, number> = { left: 15, right: 16 };
const HIP_INDEX: Record<ArmSide, number> = { left: 23, right: 24 };

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const lerp = (from: number, to: number, alpha: number): number => from + (to - from) * alpha;

const lerpVec = (from: TrackedVector3, to: TrackedVector3, alpha: number): TrackedVector3 => ({
  x: lerp(from.x, to.x, alpha),
  y: lerp(from.y, to.y, alpha),
  z: lerp(from.z, to.z, alpha),
});

const distance3 = (a: TrackedVector3, b: TrackedVector3): number =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

const subtract = (a: TrackedVector3, b: TrackedVector3): TrackedVector3 => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z,
});

const dot = (a: TrackedVector3, b: TrackedVector3): number => a.x * b.x + a.y * b.y + a.z * b.z;

const magnitude = (value: TrackedVector3): number => Math.hypot(value.x, value.y, value.z);

const angleBetween = (a: TrackedVector3, b: TrackedVector3): number => {
  const denominator = magnitude(a) * magnitude(b);
  if (denominator < 1e-5) {
    return 0;
  }
  const cosine = clamp(dot(a, b) / denominator, -1, 1);
  return (Math.acos(cosine) * 180) / Math.PI;
};

const toTracked = (point: { x: number; y: number; z: number }): TrackedVector3 => ({
  x: point.x,
  y: point.y,
  z: point.z,
});

const smoothArm = (previous: TrackedArmState | undefined, next: TrackedArmState): TrackedArmState => {
  if (!previous || !previous.visible) {
    return next;
  }

  return {
    ...next,
    shoulder: lerpVec(previous.shoulder, next.shoulder, 0.35),
    elbow: lerpVec(previous.elbow, next.elbow, 0.35),
    wrist: lerpVec(previous.wrist, next.wrist, 0.35),
    hand:
      next.hand && previous.hand
        ? {
            wrist: lerpVec(previous.hand.wrist, next.hand.wrist, 0.45),
            indexMcp: lerpVec(previous.hand.indexMcp, next.hand.indexMcp, 0.45),
            pinkyMcp: lerpVec(previous.hand.pinkyMcp, next.hand.pinkyMcp, 0.45),
            middleMcp: lerpVec(previous.hand.middleMcp, next.hand.middleMcp, 0.45),
            ringMcp: lerpVec(previous.hand.ringMcp, next.hand.ringMcp, 0.45),
            thumbMcp: lerpVec(previous.hand.thumbMcp, next.hand.thumbMcp, 0.45),
            thumbIp: lerpVec(previous.hand.thumbIp, next.hand.thumbIp, 0.45),
            indexTip: lerpVec(previous.hand.indexTip, next.hand.indexTip, 0.45),
            indexPip: lerpVec(previous.hand.indexPip, next.hand.indexPip, 0.45),
            indexDip: lerpVec(previous.hand.indexDip, next.hand.indexDip, 0.45),
            thumbTip: lerpVec(previous.hand.thumbTip, next.hand.thumbTip, 0.45),
            middlePip: lerpVec(previous.hand.middlePip, next.hand.middlePip, 0.45),
            middleDip: lerpVec(previous.hand.middleDip, next.hand.middleDip, 0.45),
            middleTip: lerpVec(previous.hand.middleTip, next.hand.middleTip, 0.45),
            ringPip: lerpVec(previous.hand.ringPip, next.hand.ringPip, 0.45),
            ringDip: lerpVec(previous.hand.ringDip, next.hand.ringDip, 0.45),
            ringTip: lerpVec(previous.hand.ringTip, next.hand.ringTip, 0.45),
            pinkyPip: lerpVec(previous.hand.pinkyPip, next.hand.pinkyPip, 0.45),
            pinkyDip: lerpVec(previous.hand.pinkyDip, next.hand.pinkyDip, 0.45),
            pinkyTip: lerpVec(previous.hand.pinkyTip, next.hand.pinkyTip, 0.45),
            handSize: lerp(previous.hand.handSize, next.hand.handSize, 0.35),
            openness: lerp(previous.hand.openness, next.hand.openness, 0.35),
            pinch: lerp(previous.hand.pinch, next.hand.pinch, 0.35),
          }
        : next.hand,
  };
};

const buildHandState = (
  handResult: HandLandmarkerResult,
  side: ArmSide,
): TrackedHandState | undefined => {
  const hands = handResult.worldLandmarks ?? [];
  const normalizedHands = handResult.landmarks ?? [];
  const handedness = handResult.handedness ?? [];
  const matchIndex = handedness.findIndex((candidate) => {
    const label = candidate?.[0]?.categoryName?.toLowerCase();
    return label === side;
  });

  if (matchIndex < 0 || !hands[matchIndex] || !normalizedHands[matchIndex]) {
    return undefined;
  }

  const landmarks = hands[matchIndex];
  const normalized = normalizedHands[matchIndex];
  const wrist = toTracked(landmarks[0]);
  const thumbMcp = toTracked(landmarks[2]);
  const thumbIp = toTracked(landmarks[3]);
  const indexMcp = toTracked(landmarks[5]);
  const indexPip = toTracked(landmarks[6]);
  const indexDip = toTracked(landmarks[7]);
  const middleMcp = toTracked(landmarks[9]);
  const middlePip = toTracked(landmarks[10]);
  const middleDip = toTracked(landmarks[11]);
  const ringMcp = toTracked(landmarks[13]);
  const pinkyMcp = toTracked(landmarks[17]);
  const pinkyPip = toTracked(landmarks[18]);
  const pinkyDip = toTracked(landmarks[19]);
  const thumbTip = toTracked(landmarks[4]);
  const indexTip = toTracked(landmarks[8]);
  const middleTip = toTracked(landmarks[12]);
  const ringPip = toTracked(landmarks[14]);
  const ringDip = toTracked(landmarks[15]);
  const ringTip = toTracked(landmarks[16]);
  const pinkyTip = toTracked(landmarks[20]);

  const normWrist = normalized[0];
  const normMiddleMcp = normalized[9];
  const handSize = Math.max(
    Math.hypot((normWrist?.x ?? 0) - (normMiddleMcp?.x ?? 0), (normWrist?.y ?? 0) - (normMiddleMcp?.y ?? 0)),
    0.03,
  );
  const palmScale = Math.max(distance3(indexMcp, pinkyMcp), 0.03);
  const openness = clamp(
    (distance3(wrist, indexTip) +
      distance3(wrist, middleTip) +
      distance3(wrist, ringTip) +
      distance3(wrist, pinkyTip)) /
      (4 * palmScale * 2.1),
    0,
    1,
  );
  const pinch = clamp(distance3(thumbTip, indexTip) / Math.max(handSize * 0.85, 0.02), 0, 1);

  return {
    wrist,
    indexMcp,
    pinkyMcp,
    middleMcp,
    ringMcp,
    thumbMcp,
    thumbIp,
    indexTip,
    indexPip,
    indexDip,
    thumbTip,
    middlePip,
    middleDip,
    middleTip,
    ringPip,
    ringDip,
    ringTip,
    pinkyPip,
    pinkyDip,
    pinkyTip,
    handSize,
    openness,
    pinch,
  };
};

const buildArmState = (
  poseResult: PoseLandmarkerResult,
  handResult: HandLandmarkerResult,
  side: ArmSide,
): TrackedArmState | undefined => {
  const world = poseResult.worldLandmarks?.[0];
  const normalized = poseResult.landmarks?.[0];
  if (!world || !normalized) {
    return undefined;
  }

  const shoulderVisibility = normalized[SHOULDER_INDEX[side]]?.visibility ?? 0;
  const elbowVisibility = normalized[ELBOW_INDEX[side]]?.visibility ?? 0;
  const wristVisibility = normalized[WRIST_INDEX[side]]?.visibility ?? 0;
  if (Math.min(shoulderVisibility, elbowVisibility, wristVisibility) < 0.35) {
    return undefined;
  }

  return {
    visible: true,
    shoulder: toTracked(world[SHOULDER_INDEX[side]]),
    elbow: toTracked(world[ELBOW_INDEX[side]]),
    wrist: toTracked(world[WRIST_INDEX[side]]),
    hand: buildHandState(handResult, side),
  };
};

const derivePhase = (rightArm?: TrackedArmState): HumanPhase => {
  if (!rightArm?.visible) {
    return "idle";
  }
  const span = rightArm.wrist.x - rightArm.shoulder.x;
  const lift = rightArm.shoulder.y - rightArm.wrist.y;
  if (lift > 0.18) {
    return "reach";
  }
  if (span > 0.18) {
    return "support";
  }
  if (span > 0.05) {
    return "hold";
  }
  return "approach";
};

const drawPoint = (
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: string,
): void => {
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fillStyle = color;
  context.fill();
};

const drawLink = (
  context: CanvasRenderingContext2D,
  from: { x: number; y: number },
  to: { x: number; y: number },
  color: string,
): void => {
  context.beginPath();
  context.moveTo(from.x, from.y);
  context.lineTo(to.x, to.y);
  context.strokeStyle = color;
  context.lineWidth = 3;
  context.stroke();
};

const drawHandWireframe = (
  context: CanvasRenderingContext2D,
  landmarks: Array<{ x: number; y: number }>,
  color: string,
): void => {
  const chains = [
    [0, 1, 2, 3, 4],
    [0, 5, 6, 7, 8],
    [0, 9, 10, 11, 12],
    [0, 13, 14, 15, 16],
    [0, 17, 18, 19, 20],
    [0, 5, 9, 13, 17, 0],
  ];
  context.strokeStyle = color;
  context.lineWidth = 2;
  chains.forEach((chain) => {
    context.beginPath();
    context.moveTo(landmarks[chain[0]].x, landmarks[chain[0]].y);
    for (let index = 1; index < chain.length; index += 1) {
      context.lineTo(landmarks[chain[index]].x, landmarks[chain[index]].y);
    }
    context.stroke();
  });
  landmarks.forEach((point, index) => {
    drawPoint(context, point.x, point.y, index === 0 ? 5 : 3.5, color);
  });
};

export function WebcamUpperBodyPanel({ enabled, onHumanState }: WebcamUpperBodyPanelProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const poseRef = useRef<PoseLandmarker | null>(null);
  const handRef = useRef<HandLandmarker | null>(null);
  const frameRef = useRef<number | null>(null);
  const lastVideoTimeRef = useRef(-1);
  const smoothedUpperBodyRef = useRef<LiveUpperBodyState | undefined>(undefined);
  const [status, setStatus] = useState("Camera idle");
  const [handDebug, setHandDebug] = useState("Hands: 0");

  useEffect(() => {
    if (!enabled) {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
      setStatus("Camera idle");
      setHandDebug("Hands: 0");
      onHumanState(null);
      return undefined;
    }

    let cancelled = false;

    const start = async (): Promise<void> => {
      try {
        setStatus("Loading trackers");
        const vision = await FilesetResolver.forVisionTasks(WASM_ROOT);
        if (cancelled) {
          return;
        }
        poseRef.current = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: POSE_MODEL_PATH,
            delegate: "GPU",
          },
          runningMode: "VIDEO",
          numPoses: 1,
          minPoseDetectionConfidence: 0.55,
          minPosePresenceConfidence: 0.55,
          minTrackingConfidence: 0.55,
          outputSegmentationMasks: false,
        });
        handRef.current = await HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: HAND_MODEL_PATH,
            delegate: "GPU",
          },
          runningMode: "VIDEO",
          numHands: 2,
          minHandDetectionConfidence: 0.45,
          minHandPresenceConfidence: 0.45,
          minTrackingConfidence: 0.45,
        });
        if (cancelled) {
          return;
        }

        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 960 },
            height: { ideal: 540 },
            facingMode: "user",
          },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) {
          return;
        }
        video.srcObject = stream;
        await video.play();
        setStatus("Camera live");

        const renderLoop = (): void => {
          if (cancelled || !videoRef.current || !canvasRef.current || !poseRef.current || !handRef.current) {
            return;
          }

          const videoElement = videoRef.current;
          const canvas = canvasRef.current;
          const context = canvas.getContext("2d");
          if (!context) {
            frameRef.current = window.requestAnimationFrame(renderLoop);
            return;
          }

          const width = videoElement.videoWidth || 960;
          const height = videoElement.videoHeight || 540;
          canvas.width = width;
          canvas.height = height;
          context.save();
          context.clearRect(0, 0, width, height);
          context.scale(-1, 1);
          context.drawImage(videoElement, -width, 0, width, height);
          context.restore();

          if (videoElement.currentTime !== lastVideoTimeRef.current) {
            lastVideoTimeRef.current = videoElement.currentTime;
            const timestamp = performance.now();
            const poseResult = poseRef.current.detectForVideo(videoElement, timestamp);
            const handResult = handRef.current.detectForVideo(videoElement, timestamp);
            const handCount = handResult.landmarks?.length ?? 0;

            const nextUpperBody: LiveUpperBodyState = {
              enabled: true,
              source: "camera",
              leftArm: buildArmState(poseResult, handResult, "left"),
              rightArm: buildArmState(poseResult, handResult, "right"),
            };

            const smoothed: LiveUpperBodyState = {
              enabled: true,
              source: "camera",
              leftArm: nextUpperBody.leftArm
                ? smoothArm(smoothedUpperBodyRef.current?.leftArm, nextUpperBody.leftArm)
                : undefined,
              rightArm: nextUpperBody.rightArm
                ? smoothArm(smoothedUpperBodyRef.current?.rightArm, nextUpperBody.rightArm)
                : undefined,
            };
            smoothedUpperBodyRef.current = smoothed;
            const leftPinch = smoothed.leftArm?.hand?.pinch;
            const rightPinch = smoothed.rightArm?.hand?.pinch;
            const leftOpen = smoothed.leftArm?.hand?.openness;
            const rightOpen = smoothed.rightArm?.hand?.openness;
            setHandDebug(
              [
                `Hands: ${handCount}`,
                leftPinch !== undefined ? `L pinch ${(1 - leftPinch).toFixed(2)}` : "L pinch --",
                rightPinch !== undefined ? `R pinch ${(1 - rightPinch).toFixed(2)}` : "R pinch --",
                leftOpen !== undefined ? `L open ${leftOpen.toFixed(2)}` : "L open --",
                rightOpen !== undefined ? `R open ${rightOpen.toFixed(2)}` : "R open --",
              ].join(" | "),
            );

            const pose = poseResult.landmarks?.[0];
            if (pose) {
              const points = [11, 13, 15, 12, 14, 16].map((index) => ({
                x: (1 - (pose[index]?.x ?? 0.5)) * width,
                y: (pose[index]?.y ?? 0.5) * height,
              }));
              drawLink(context, points[0], points[1], "#38bdf8");
              drawLink(context, points[1], points[2], "#38bdf8");
              drawLink(context, points[3], points[4], "#f59e0b");
              drawLink(context, points[4], points[5], "#f59e0b");
              points.forEach((point, index) => {
                drawPoint(context, point.x, point.y, 6, index < 3 ? "#0ea5e9" : "#f97316");
              });
            }

            (handResult.landmarks ?? []).forEach((landmarks, index) => {
              const handedness = handResult.handedness?.[index]?.[0]?.categoryName?.toLowerCase();
              const color = handedness === "left" ? "#22c55e" : "#f97316";
              drawHandWireframe(
                context,
                landmarks.map((point) => ({
                  x: (1 - point.x) * width,
                  y: point.y * height,
                })),
                color,
              );
            });

            const world = poseResult.worldLandmarks?.[0];
            const pose2d = poseResult.landmarks?.[0];
            const hipsCenter =
              world && world[23] && world[24]
                ? {
                    x: (world[23].x + world[24].x) / 2,
                    y: (world[23].y + world[24].y) / 2,
                    z: (world[23].z + world[24].z) / 2,
                  }
                : { x: 0, y: 0, z: 0 };
            const shouldersCenter =
              world && world[11] && world[12]
                ? {
                    x: (world[11].x + world[12].x) / 2,
                    y: (world[11].y + world[12].y) / 2,
                    z: (world[11].z + world[12].z) / 2,
                  }
                : { x: 0, y: 0, z: 0 };
            const shoulderWidth2d =
              pose2d && pose2d[11] && pose2d[12]
                ? Math.hypot((pose2d[11].x ?? 0) - (pose2d[12].x ?? 0), (pose2d[11].y ?? 0) - (pose2d[12].y ?? 0))
                : 0.24;
            const torso = subtract(shouldersCenter, hipsCenter);
            const torsoYaw = clamp((world?.[11]?.z ?? 0) - (world?.[12]?.z ?? 0), -0.45, 0.45);
            const torsoLean = clamp((shouldersCenter.x - hipsCenter.x) * 1.5, -0.25, 0.25);
            const bodyScale = clamp(shoulderWidth2d / 0.24, 0.82, 1.24);
            const rightArm = smoothed.rightArm;
            const wrist2d = pose?.[WRIST_INDEX.right];
            const rightHand2d = handResult.landmarks?.[
              (handResult.handedness ?? []).findIndex(
                (candidate) => candidate?.[0]?.categoryName?.toLowerCase() === "right",
              )
            ]?.[0];
            const rightUpperArm =
              rightArm && subtract(rightArm.elbow, rightArm.shoulder);
            const rightForearm =
              rightArm && subtract(rightArm.wrist, rightArm.elbow);

            const shoulderAngle =
              rightArm && magnitude(torso) > 1e-5 && rightUpperArm
                ? angleBetween(
                    { x: torso.x, y: -torso.y, z: torso.z },
                    { x: rightUpperArm.x, y: -rightUpperArm.y, z: rightUpperArm.z },
                  )
                : 18;
            const elbowAngle =
              rightArm && rightUpperArm && rightForearm
                ? angleBetween(
                    { x: -rightUpperArm.x, y: -rightUpperArm.y, z: -rightUpperArm.z },
                    rightForearm,
                  )
                : 45;
            const wristAngle = rightArm?.hand
              ? clamp((rightArm.hand.openness - (1 - rightArm.hand.pinch)) * 46 - 6, -40, 40)
              : 0;

            onHumanState({
              clipId: "camera-live",
              clipName: "Camera Upper Limb",
              time: timestamp / 1000,
              phase: derivePhase(rightArm),
              root: [
                clamp(22 + shouldersCenter.x * 28, 15, 29),
                clamp(72 + shouldersCenter.z * 28, 62, 82),
              ],
              hand: [
                clamp(34 + (((rightHand2d?.x ?? wrist2d?.x) ?? 0.5) - 0.5) * 40, 20, 78),
                clamp(58 + (((rightHand2d?.y ?? wrist2d?.y) ?? 0.55) - 0.55) * 40, 28, 84),
              ],
              joints: {
                shoulder: clamp(shoulderAngle, 8, 170),
                elbow: clamp(elbowAngle, 8, 170),
                wrist: wristAngle,
              },
              targetZoneId: "workbench",
              liveUpperBody: {
                ...smoothed,
                bodyScale,
                torsoYaw,
                torsoLean,
              },
            });
          }

          frameRef.current = window.requestAnimationFrame(renderLoop);
        };

        renderLoop();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Camera initialization failed";
        setStatus(message);
        setHandDebug("Hands: 0");
        onHumanState(null);
      }
    };

    void start();

    return () => {
      cancelled = true;
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      poseRef.current = null;
      handRef.current = null;
      setHandDebug("Hands: 0");
    };
  }, [enabled, onHumanState]);

  return (
    <div className="floating-panel camera-panel">
      <div className="camera-panel-header">
        <div>
          <span className="summary-label">Camera Drive</span>
          <strong>Upper arm and hand tracking</strong>
        </div>
        <span className={`status-pill ${enabled ? "live" : ""}`}>{status}</span>
      </div>
      <div className="camera-debug">{handDebug}</div>
      <canvas ref={canvasRef} className="camera-preview" />
      <video ref={videoRef} playsInline muted className="camera-video-hidden" />
    </div>
  );
}
