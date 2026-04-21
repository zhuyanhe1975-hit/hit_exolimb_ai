import type { HumanMotionClip, HumanPoseFrame, HumanState } from "../types";

const interpolate = (a: number, b: number, alpha: number): number =>
  a + (b - a) * alpha;

const lerp2 = (
  a: [number, number],
  b: [number, number],
  alpha: number,
): [number, number] => [interpolate(a[0], b[0], alpha), interpolate(a[1], b[1], alpha)];

const findFrameWindow = (
  clip: HumanMotionClip,
  time: number,
): [HumanPoseFrame, HumanPoseFrame, number] => {
  if (clip.frames.length === 0) {
    throw new Error(`Clip "${clip.id}" has no frames.`);
  }

  if (time <= clip.frames[0].t) {
    return [clip.frames[0], clip.frames[0], 0];
  }

  for (let index = 0; index < clip.frames.length - 1; index += 1) {
    const current = clip.frames[index];
    const next = clip.frames[index + 1];
    if (time >= current.t && time <= next.t) {
      const alpha = (time - current.t) / (next.t - current.t);
      return [current, next, alpha];
    }
  }

  const last = clip.frames[clip.frames.length - 1];
  return [last, last, 0];
};

export const sampleHumanClip = (
  clip: HumanMotionClip,
  time: number,
): HumanState => {
  const clampedTime = Math.max(0, Math.min(time, clip.duration));
  const [from, to, alpha] = findFrameWindow(clip, clampedTime);

  return {
    clipId: clip.id,
    clipName: clip.name,
    time: clampedTime,
    phase: alpha < 0.5 ? from.phase : to.phase,
    root: lerp2(from.root, to.root, alpha),
    hand: lerp2(from.hand, to.hand, alpha),
    joints: {
      shoulder: interpolate(from.joints.shoulder, to.joints.shoulder, alpha),
      elbow: interpolate(from.joints.elbow, to.joints.elbow, alpha),
      wrist: interpolate(from.joints.wrist, to.joints.wrist, alpha)
    },
    targetZoneId: alpha < 0.5 ? from.targetZoneId : to.targetZoneId
  };
};
