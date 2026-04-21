import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { humanVisualAsset } from "../data/catalog";
import type { HumanState, SkillCall } from "../types";
import { humanHandToMocap, prepareMjcfAssets, writeAssetsToVfs } from "./mjcfAssetLoader";

interface RuntimeRobotState {
  endEffector: [number, number, number];
  target: [number, number, number];
  mode: string;
  effort: number;
  trackingError: number;
  contact: string;
  loaded: boolean;
}

interface RuntimeOptions {
  canvas: HTMLCanvasElement;
  onState?: (state: RuntimeRobotState) => void;
}

type MujocoModule = {
  FS_createDataFile: (...args: any[]) => void;
  FS_createPath: (...args: any[]) => void;
  MjModel: {
    from_xml_path: (path: string) => any;
  };
  MjData: new (model: any) => any;
  mj_step: (model: any, data: any) => void;
};

const loadMujocoModule = async (): Promise<MujocoModule> => {
  const moduleUrl = "/vendor/mujoco/mujoco.js";
  const imported = (await import(/* @vite-ignore */ moduleUrl)) as {
    default: (options?: { locateFile?: (path: string) => string }) => Promise<MujocoModule>;
  };
  return imported.default({
    locateFile: (path: string) =>
      path.endsWith(".wasm") ? "/vendor/mujoco/mujoco.wasm" : path,
  });
};

const readVector = (source: unknown, length: number, offset = 0): number[] => {
  const vector = source as { get?: (index: number) => number | undefined } | number[] | undefined;
  if (vector && !Array.isArray(vector) && typeof vector.get === "function") {
    const getter = vector.get;
    return Array.from({ length }, (_, index) => Number(getter(offset + index) ?? 0));
  }
  if (Array.isArray(vector)) {
    return vector.slice(offset, offset + length).map((value) => Number(value));
  }
  return Array.from({ length }, () => 0);
};

const parseBodyMeshSpecs = (xmlText: string): Map<string, string[]> => {
  const parser = new DOMParser();
  const xml = parser.parseFromString(xmlText, "application/xml");
  const meshMap = new Map<string, string>();
  xml.querySelectorAll("asset > mesh").forEach((mesh) => {
    const name = mesh.getAttribute("name");
    const file = mesh.getAttribute("file");
    if (name && file) {
      meshMap.set(name, file);
    }
  });

  const bodyMeshes = new Map<string, string[]>();
  xml.querySelectorAll("worldbody body[name]").forEach((body) => {
    const bodyName = body.getAttribute("name");
    if (!bodyName || bodyName === "ikdummy") {
      return;
    }
    const files = [...body.children]
      .filter((child) => child.tagName === "geom")
      .map((geom) => geom.getAttribute("mesh"))
      .filter((mesh): mesh is string => Boolean(mesh))
      .map((mesh) => meshMap.get(mesh))
      .filter((file): file is string => Boolean(file));
    if (files.length > 0) {
      bodyMeshes.set(bodyName, files);
    }
  });

  return bodyMeshes;
};

export class BrowserMujocoRuntime {
  private readonly canvas: HTMLCanvasElement;

  private readonly onState?: RuntimeOptions["onState"];

  private renderer?: THREE.WebGLRenderer;

  private camera?: THREE.PerspectiveCamera;

  private scene?: THREE.Scene;

  private mujoco?: MujocoModule;

  private model?: any;

  private data?: any;

  private frameHandle = 0;

  private lastTick = 0;

  private running = false;

  private currentSkill?: SkillCall;

  private currentHuman?: HumanState;

  private mocapTarget: [number, number, number] = [0.6, 0, 0.2];

  private bodyGroups = new Map<string, THREE.Group>();

  private humanRoot?: THREE.Group;

  private humanMixer?: THREE.AnimationMixer;

  private humanActions = new Map<string, THREE.AnimationAction>();

  private proxyLeftHand?: THREE.Mesh;

  private proxyRightHand?: THREE.Mesh;

  constructor({ canvas, onState }: RuntimeOptions) {
    this.canvas = canvas;
    this.onState = onState;
  }

  async initialize(): Promise<void> {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: true,
    });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.resizeRenderer();

    this.camera = new THREE.PerspectiveCamera(
      42,
      this.canvas.clientWidth / Math.max(this.canvas.clientHeight, 1),
      0.01,
      100,
    );
    this.camera.position.set(1.85, -2.1, 1.2);
    this.camera.lookAt(0.45, 0, 0.2);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color("#efe5d5");
    this.scene.add(new THREE.HemisphereLight(0xfff3e0, 0x5b6675, 1.8));
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
    keyLight.position.set(3, -2, 4);
    this.scene.add(keyLight);

    const grid = new THREE.GridHelper(3, 18, 0x7c6f64, 0xb7aa97);
    grid.rotateX(Math.PI / 2);
    this.scene.add(grid);

    this.mujoco = await loadMujocoModule();

    const assets = await prepareMjcfAssets("/assets/mujoco/serial/hitexo.xml");
    writeAssetsToVfs(this.mujoco, assets);
    this.model = this.mujoco.MjModel.from_xml_path(assets.entryVirtualPath);
    this.data = new this.mujoco.MjData(this.model);

    await this.buildExolimbVisuals(assets.rootXml);
    await this.buildHumanVisual();
    window.addEventListener("resize", this.handleResize);
    this.startLoop();
  }

  dispose(): void {
    cancelAnimationFrame(this.frameHandle);
    window.removeEventListener("resize", this.handleResize);
    this.model?.delete();
    this.data?.delete();
    this.renderer?.dispose();
  }

  setRunning(running: boolean): void {
    this.running = running;
  }

  setHumanControl(human: HumanState, skill?: SkillCall): void {
    this.currentHuman = human;
    this.currentSkill = skill;
    this.mocapTarget = humanHandToMocap(human.hand, skill);
    this.syncHumanVisual();
  }

  async capturePng(): Promise<Blob | null> {
    return new Promise((resolve) => {
      this.canvas.toBlob((blob) => resolve(blob), "image/png");
    });
  }

  private readonly handleResize = (): void => {
    this.resizeRenderer();
    if (!this.camera) {
      return;
    }
    this.camera.aspect = this.canvas.clientWidth / Math.max(this.canvas.clientHeight, 1);
    this.camera.updateProjectionMatrix();
  };

  private resizeRenderer(): void {
    this.renderer?.setSize(this.canvas.clientWidth, this.canvas.clientHeight, false);
  }

  private async buildExolimbVisuals(xmlText: string): Promise<void> {
    if (!this.scene) {
      return;
    }

    const bodyMeshes = parseBodyMeshSpecs(xmlText);
    const loader = new STLLoader();
    const promises: Array<Promise<void>> = [];

    bodyMeshes.forEach((meshFiles, bodyName) => {
      const anchor = new THREE.Group();
      anchor.name = bodyName;
      this.bodyGroups.set(bodyName, anchor);
      this.scene?.add(anchor);

      meshFiles.forEach((meshFile) => {
        promises.push(
          new Promise((resolve, reject) => {
            loader.load(
              `/assets/mujoco/serial/${meshFile}`,
              (geometry) => {
                geometry.center();
                const material = new THREE.MeshStandardMaterial({
                  color: "#c9c4be",
                  metalness: 0.28,
                  roughness: 0.58,
                });
                const mesh = new THREE.Mesh(geometry, material);
                mesh.scale.setScalar(0.001);
                anchor.add(mesh);
                resolve();
              },
              undefined,
              reject,
            );
          }),
        );
      });
    });

    await Promise.all(promises);
  }

  private async buildHumanVisual(): Promise<void> {
    if (!this.scene) {
      return;
    }

    const root = new THREE.Group();
    root.name = "human-visual-root";
    root.position.set(...humanVisualAsset.scenePosition);
    root.rotation.set(
      THREE.MathUtils.degToRad(humanVisualAsset.sceneRotationEulerDeg[0]),
      THREE.MathUtils.degToRad(humanVisualAsset.sceneRotationEulerDeg[1]),
      THREE.MathUtils.degToRad(humanVisualAsset.sceneRotationEulerDeg[2]),
    );
    root.scale.setScalar(humanVisualAsset.scale);
    this.scene.add(root);
    this.humanRoot = root;

    try {
      const gltf = await new GLTFLoader().loadAsync(humanVisualAsset.glbPath);
      root.add(gltf.scene);
      this.humanMixer = new THREE.AnimationMixer(gltf.scene);
      gltf.animations.forEach((clip) => {
        const action = this.humanMixer?.clipAction(clip);
        if (action) {
          action.enabled = true;
          action.paused = true;
          action.play();
          this.humanActions.set(clip.name, action);
        }
      });
    } catch {
      const bodyMaterial = new THREE.MeshStandardMaterial({
        color: "#d5b89b",
        roughness: 0.82,
        metalness: 0.04,
      });

      const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.09, 0.42, 8, 16), bodyMaterial);
      torso.position.set(0, 0, 0.95);
      root.add(torso);

      const head = new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 16), bodyMaterial);
      head.position.set(0, 0, 1.28);
      root.add(head);

      const leftArm = new THREE.Mesh(new THREE.CapsuleGeometry(0.035, 0.4, 6, 12), bodyMaterial);
      leftArm.position.set(0.02, 0.18, 1.02);
      leftArm.rotation.z = Math.PI / 2;
      root.add(leftArm);

      const rightArm = leftArm.clone();
      rightArm.position.y = -0.18;
      root.add(rightArm);

      this.proxyLeftHand = new THREE.Mesh(
        new THREE.SphereGeometry(0.04, 12, 12),
        new THREE.MeshStandardMaterial({ color: "#ea580c" }),
      );
      this.proxyLeftHand.position.set(0.28, 0.22, 1.05);
      root.add(this.proxyLeftHand);

      this.proxyRightHand = this.proxyLeftHand.clone();
      this.proxyRightHand.position.y = -0.22;
      root.add(this.proxyRightHand);
    }
  }

  private startLoop(): void {
    const tick = (timestamp: number) => {
      if (!this.renderer || !this.scene || !this.camera || !this.mujoco || !this.model || !this.data) {
        return;
      }

      if (this.lastTick === 0) {
        this.lastTick = timestamp;
      }
      const deltaSeconds = Math.min((timestamp - this.lastTick) / 1000, 1 / 30);
      this.lastTick = timestamp;

      if (this.running) {
        this.applyHumanTarget();
        const stepCount = Math.max(1, Math.round(deltaSeconds / 0.001));
        for (let index = 0; index < stepCount; index += 1) {
          this.applySkillControl();
          this.mujoco.mj_step(this.model, this.data);
        }
      }

      this.humanMixer?.update(0);
      this.syncVisuals();
      this.renderer.render(this.scene, this.camera);
      this.frameHandle = requestAnimationFrame(tick);
    };

    this.frameHandle = requestAnimationFrame(tick);
  }

  private applyHumanTarget(): void {
    if (!this.data) {
      return;
    }
    this.data.mocap_pos.set(0, this.mocapTarget[0]);
    this.data.mocap_pos.set(1, this.mocapTarget[1]);
    this.data.mocap_pos.set(2, this.mocapTarget[2]);
  }

  private applySkillControl(): void {
    if (!this.data || !this.model) {
      return;
    }

    const ctrl = this.data.ctrl;
    const skill = this.currentSkill?.skillName ?? "move_to_ready_pose";
    const postureMap: Record<string, number[]> = {
      move_to_ready_pose: [0, -0.25, 0.5, 0, 0.1, 0],
      plan_reach_trajectory: [0.08, -0.4, 0.62, 0, 0.16, 0],
      position_tracking: [0.12, -0.52, 0.84, 0, 0.22, 0],
      force_control_hold: [0.1, -0.56, 0.92, 0, 0.28, 0],
      follow_human_arm: [0.06, -0.5, 0.74, 0, 0.18, 0],
      retreat_to_safe_pose: [0, -0.16, 0.3, 0, 0.08, 0],
    };

    const targets = postureMap[skill] ?? postureMap.move_to_ready_pose;
    for (let index = 0; index < Math.min(targets.length, this.model.nu); index += 1) {
      ctrl.set(index, targets[index]);
    }
  }

  private syncVisuals(): void {
    if (!this.data) {
      return;
    }

    this.bodyGroups.forEach((group, bodyName) => {
      const body = this.data?.body(bodyName);
      if (!body) {
        return;
      }
      const pos = readVector(body.xpos, 3);
      const quat = readVector(body.xquat, 4);
      group.position.set(pos[0] ?? 0, pos[1] ?? 0, pos[2] ?? 0);
      group.quaternion.set(quat[1] ?? 0, quat[2] ?? 0, quat[3] ?? 0, quat[0] ?? 1);
      group.updateMatrixWorld();
    });

    const endEffector = readVector(this.data.body("Link6").xpos, 3) as [number, number, number];
    const distance = Math.hypot(
      endEffector[0] - this.mocapTarget[0],
      endEffector[1] - this.mocapTarget[1],
      endEffector[2] - this.mocapTarget[2],
    );

    this.onState?.({
      endEffector,
      target: this.mocapTarget,
      mode: this.currentSkill?.skillName ?? "idle",
      effort: Number(this.currentSkill?.args.supportForce ?? this.currentSkill?.args.trackingGain ?? 0.2),
      trackingError: distance,
      contact: distance < 0.08 ? "协同接触中" : "跟随接近中",
      loaded: true,
    });
  }

  private syncHumanVisual(): void {
    if (!this.currentHuman || !this.humanRoot) {
      return;
    }

    const animationName =
      this.currentHuman.clipId === "lift-assist"
        ? humanVisualAsset.animationMap.lift_assist
        : this.currentHuman.clipId === "position-assist"
          ? humanVisualAsset.animationMap.position_assist
          : humanVisualAsset.animationMap.compliance_support;

    if (this.humanMixer && this.humanActions.size > 0) {
      this.humanActions.forEach((action, name) => {
        const active = name === animationName || (!animationName && this.humanActions.size === 1);
        action.enabled = active;
        action.weight = active ? 1 : 0;
        action.paused = true;
      });

      const activeAction =
        (animationName ? this.humanActions.get(animationName) : undefined) ??
        this.humanActions.values().next().value;
      const clipDuration = activeAction?.getClip().duration ?? 1;
      if (activeAction) {
        activeAction.time = ((this.currentHuman.time % clipDuration) + clipDuration) % clipDuration;
      }
      return;
    }

    const rootX = -0.15 + (this.currentHuman.root[0] / 100) * 0.3;
    const rootY = -0.45 + ((100 - this.currentHuman.root[1]) / 100) * 0.25;
    this.humanRoot.position.set(rootX, rootY, 0);

    const handX = -0.1 + (this.currentHuman.hand[0] / 100) * 0.65;
    const handZ = 0.65 + ((100 - this.currentHuman.hand[1]) / 100) * 0.75;
    if (this.proxyRightHand) {
      this.proxyRightHand.position.set(handX, -0.18, handZ);
    }
    if (this.proxyLeftHand) {
      this.proxyLeftHand.position.set(handX * 0.88, 0.18, handZ * 0.98);
    }
  }
}
