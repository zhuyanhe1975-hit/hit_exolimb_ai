import type { HumanMotionClip, HumanPoseFrame, HumanState } from "../types";

const interpolate = (a: number, b: number, alpha: number): number =>
  a + (b - a) * alpha;

const smoothStep = (alpha: number): number => alpha * alpha * (3 - 2 * alpha);

const catmullRom = (
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  alpha: number,
): number => {
  const alpha2 = alpha * alpha;
  const alpha3 = alpha2 * alpha;
  return (
    0.5 *
    ((2 * p1) +
      (-p0 + p2) * alpha +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * alpha2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * alpha3)
  );
};

const spline2 = (
  p0: [number, number],
  p1: [number, number],
  p2: [number, number],
  p3: [number, number],
  alpha: number,
): [number, number] => [
  catmullRom(p0[0], p1[0], p2[0], p3[0], alpha),
  catmullRom(p0[1], p1[1], p2[1], p3[1], alpha),
];

const getFrame = (frames: HumanPoseFrame[], index: number): HumanPoseFrame =>
  frames[Math.max(0, Math.min(index, frames.length - 1))];

const findFrameWindow = (
  clip: HumanMotionClip,
  time: number
): [number, number, number] => {
  if (clip.frames.length === 0) {
    throw new Error(`Clip "${clip.id}" has no frames.`);
  }

  if (time <= clip.frames[0].t) {
    return [0, 0, 0];
  }

  for (let index = 0; index < clip.frames.length - 1; index += 1) {
    const current = clip.frames[index];
    const next = clip.frames[index + 1];
    if (time >= current.t && time <= next.t) {
      const span = Math.max(next.t - current.t, Number.EPSILON);
      const alpha = (time - current.t) / span;
      return [index, index + 1, smoothStep(alpha)];
    }
  }

  const lastIndex = clip.frames.length - 1;
  return [lastIndex, lastIndex, 0];
};

export const sampleHumanClip = (
  clip: HumanMotionClip,
  time: number,
): HumanState => {
  const clampedTime = Math.max(0, Math.min(time, clip.duration));
  const [fromIndex, toIndex, alpha] = findFrameWindow(clip, clampedTime);
  const from = getFrame(clip.frames, fromIndex);
  const to = getFrame(clip.frames, toIndex);
  const prev = getFrame(clip.frames, fromIndex - 1);
  const next = getFrame(clip.frames, toIndex + 1);

  const root = fromIndex === toIndex ? from.root : spline2(prev.root, from.root, to.root, next.root, alpha);
  const hand = fromIndex === toIndex ? from.hand : spline2(prev.hand, from.hand, to.hand, next.hand, alpha);

  return {
    clipId: clip.id,
    clipName: clip.name,
    time: clampedTime,
    phase: alpha < 0.5 ? from.phase : to.phase,
    root,
    hand,
    joints: {
      shoulder:
        fromIndex === toIndex
          ? from.joints.shoulder
          : catmullRom(
              prev.joints.shoulder,
              from.joints.shoulder,
              to.joints.shoulder,
              next.joints.shoulder,
              alpha,
            ),
      elbow:
        fromIndex === toIndex
          ? from.joints.elbow
          : catmullRom(prev.joints.elbow, from.joints.elbow, to.joints.elbow, next.joints.elbow, alpha),
      wrist:
        fromIndex === toIndex
          ? from.joints.wrist
          : catmullRom(prev.joints.wrist, from.joints.wrist, to.joints.wrist, next.joints.wrist, alpha),
    },
    targetZoneId: alpha < 0.5 ? from.targetZoneId : to.targetZoneId
  };
};
