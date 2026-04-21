import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
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

const toColor = (r: number, g: number, b: number): THREE.Color => new THREE.Color(r, g, b);

const createMenagerieGridTexture = (): THREE.CanvasTexture => {
  const size = 1024;
  const cells = 20;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;

  const context = canvas.getContext("2d");
  if (!context) {
    const fallback = new THREE.CanvasTexture(canvas);
    fallback.colorSpace = THREE.SRGBColorSpace;
    return fallback;
  }

  const primary = "#19334c";
  const secondary = "#334c66";
  const edge = "#47627c";
  const cellSize = size / cells;

  for (let row = 0; row < cells; row += 1) {
    for (let column = 0; column < cells; column += 1) {
      context.fillStyle = (row + column) % 2 === 0 ? primary : secondary;
      context.fillRect(column * cellSize, row * cellSize, cellSize, cellSize);
    }
  }

  context.strokeStyle = edge;
  context.lineWidth = 2;
  for (let index = 0; index <= cells; index += 1) {
    const offset = index * cellSize;
    context.beginPath();
    context.moveTo(offset, 0);
    context.lineTo(offset, size);
    context.stroke();

    context.beginPath();
    context.moveTo(0, offset);
    context.lineTo(size, offset);
    context.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1, 1);
  texture.anisotropy = 8;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
};

const loadMujocoModule = async (): Promise<MujocoModule> => {
  const moduleUrl = "/vendor/mujoco/mujoco.js";
  const source = await fetch(moduleUrl);
  if (!source.ok) {
    throw new Error(`Failed to fetch MuJoCo runtime from ${moduleUrl}`);
  }

  const moduleText = await source.text();
  const blobUrl = URL.createObjectURL(
    new Blob([moduleText], {
      type: "text/javascript",
    }),
  );
  const originalSharedArrayBuffer = globalThis.SharedArrayBuffer;

  try {
    Object.defineProperty(globalThis, "SharedArrayBuffer", {
      configurable: true,
      value: undefined,
    });

    const imported = (await import(/* @vite-ignore */ blobUrl)) as {
      default: (options?: {
        locateFile?: (path: string) => string;
        mainScriptUrlOrBlob?: string | Blob;
      }) => Promise<MujocoModule>;
    };

    return imported.default({
      mainScriptUrlOrBlob: moduleUrl,
      locateFile: (path: string) =>
        path.endsWith(".wasm") ? "/vendor/mujoco/mujoco.wasm" : path,
    });
  } finally {
    Object.defineProperty(globalThis, "SharedArrayBuffer", {
      configurable: true,
      value: originalSharedArrayBuffer,
    });
  }
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

const parseDefaultBodyTransforms = (xmlText: string): Map<string, [number, number, number]> => {
  const parser = new DOMParser();
  const xml = parser.parseFromString(xmlText, "application/xml");
  const transforms = new Map<string, [number, number, number]>();

  const walk = (element: Element, parentPosition: [number, number, number]): void => {
    [...element.children]
      .filter((child) => child.tagName === "body")
      .forEach((body) => {
        const bodyName = body.getAttribute("name");
        if (!bodyName || bodyName === "ikdummy") {
          walk(body, parentPosition);
          return;
        }

        const localPosition = (body.getAttribute("pos") ?? "0 0 0")
          .split(/\s+/)
          .filter(Boolean)
          .map((value) => Number(value)) as number[];
        const worldPosition: [number, number, number] = [
          parentPosition[0] + (localPosition[0] ?? 0),
          parentPosition[1] + (localPosition[1] ?? 0),
          parentPosition[2] + (localPosition[2] ?? 0),
        ];

        transforms.set(bodyName, worldPosition);
        walk(body, worldPosition);
      });
  };

  const worldbody = xml.querySelector("worldbody");
  if (worldbody) {
    walk(worldbody, [0, 0, 0]);
  }

  return transforms;
};

const parseBodyLinks = (xmlText: string): Array<{ from: string; to: string }> => {
  const parser = new DOMParser();
  const xml = parser.parseFromString(xmlText, "application/xml");
  const links: Array<{ from: string; to: string }> = [];

  const walk = (element: Element, parentBody?: string): void => {
    [...element.children]
      .filter((child) => child.tagName === "body")
      .forEach((body) => {
        const bodyName = body.getAttribute("name") ?? undefined;
        if (parentBody && bodyName && bodyName !== "ikdummy") {
          links.push({ from: parentBody, to: bodyName });
        }
        walk(body, bodyName && bodyName !== "ikdummy" ? bodyName : parentBody);
      });
  };

  const worldbody = xml.querySelector("worldbody");
  if (worldbody) {
    walk(worldbody);
  }

  return links;
};

export class BrowserMujocoRuntime {
  private static readonly LINK_DEFS = [
    { bodyName: "Link1", offset: [0, 0, 0] as const, axis: [0, 0, 1] as const },
    { bodyName: "Link2", offset: [0.083, 0, 0.09315] as const, axis: [0, -1, 0] as const },
    { bodyName: "Link3", offset: [0.39094, 0, -0.029583] as const, axis: [0, -1, 0] as const },
    { bodyName: "Link4", offset: [0.33481, 0, 0.029583] as const, axis: [0, 0, -1] as const },
    { bodyName: "Link5", offset: [0.024, 0, 0] as const, axis: [0, -1, 0] as const },
    { bodyName: "Link6", offset: [0.067104, 0, 0] as const, axis: [-1, 0, 0] as const },
  ];

  private readonly canvas: HTMLCanvasElement;

  private readonly onState?: RuntimeOptions["onState"];

  private renderer?: THREE.WebGLRenderer;

  private camera?: THREE.PerspectiveCamera;

  private controls?: OrbitControls;

  private scene?: THREE.Scene;

  private exolimbRoot?: THREE.Group;

  private mirroredExolimbRoot?: THREE.Group;

  private wearableRoot?: THREE.Group;

  private floorShadow?: THREE.Mesh;

  private groundTexture?: THREE.Texture;

  private mujoco?: MujocoModule;

  private model?: any;

  private data?: any;

  private frameHandle = 0;

  private lastTick = 0;

  private running = false;

  private jointTestMode = false;

  private jointTestTime = 0;

  private currentSkill?: SkillCall;

  private currentHuman?: HumanState;

  private mocapTarget: [number, number, number] = [0.6, 0, 0.2];

  private bodyGroups = new Map<string, THREE.Group>();

  private mirroredBodyGroups = new Map<string, THREE.Group>();

  private humanRoot?: THREE.Group;

  private humanMixer?: THREE.AnimationMixer;

  private humanActions = new Map<string, THREE.AnimationAction>();

  private hasHumanMesh = false;

  private proxyLeftHand?: THREE.Mesh;

  private proxyRightHand?: THREE.Mesh;

  private fallbackActive = false;

  private fallbackBodyTransforms = new Map<string, [number, number, number]>();

  private exolimbVisualOffset = new THREE.Vector3();

  private fallbackBodyLinks: Array<{ from: string; to: string }> = [];

  private fallbackGuide?: THREE.Group;

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
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.resizeRenderer();

    this.camera = new THREE.PerspectiveCamera(
      45,
      this.canvas.clientWidth / Math.max(this.canvas.clientHeight, 1),
      0.01,
      100,
    );
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(2.2, -2.4, 1.9);
    this.camera.lookAt(0.52, 0, 0.45);

    this.scene = new THREE.Scene();
    this.scene.background = toColor(0.4, 0.6, 0.8);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 0.7;
    this.controls.maxDistance = 6;
    this.controls.target.set(0.52, 0, 0.45);

    this.wearableRoot = new THREE.Group();
    this.wearableRoot.name = "wearable-root";
    this.wearableRoot.position.set(0, 0, 0);
    this.scene.add(this.wearableRoot);

    this.exolimbRoot = new THREE.Group();
    this.exolimbRoot.name = "exolimb-root-right";
    this.exolimbRoot.position.set(-0.355, -0.19, 1.335);
    this.exolimbRoot.rotation.set(0, 0, 2.36);
    this.wearableRoot.add(this.exolimbRoot);

    this.mirroredExolimbRoot = new THREE.Group();
    this.mirroredExolimbRoot.name = "exolimb-root-left";
    this.mirroredExolimbRoot.position.set(-0.355, 0.19, 1.335);
    this.mirroredExolimbRoot.rotation.copy(this.exolimbRoot.rotation);
    this.mirroredExolimbRoot.scale.set(1, -1, 1);
    this.wearableRoot.add(this.mirroredExolimbRoot);

    this.scene.add(new THREE.AmbientLight(toColor(0.4, 0.4, 0.4), 1));

    const keyLight = new THREE.DirectionalLight(toColor(0.8, 0.8, 0.8), 2.1);
    keyLight.position.set(3.6, -2.8, 5.4);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(2048, 2048);
    keyLight.shadow.bias = -0.0002;
    keyLight.shadow.radius = 3;
    this.scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(toColor(0.55, 0.66, 0.76), 0.9);
    fillLight.position.set(-2.8, 1.8, 3.2);
    this.scene.add(fillLight);

    this.groundTexture = createMenagerieGridTexture();
    const stage = new THREE.Mesh(
      new THREE.PlaneGeometry(10, 10),
      new THREE.MeshStandardMaterial({
        color: "#ffffff",
        map: this.groundTexture,
        roughness: 0.9,
        metalness: 0.04,
      }),
    );
    stage.receiveShadow = true;
    stage.position.z = -0.002;
    this.scene.add(stage);

    this.floorShadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.48, 48),
      new THREE.MeshBasicMaterial({
        color: "#90a4b8",
        transparent: true,
        opacity: 0.18,
        depthWrite: false,
      }),
    );
    this.floorShadow.position.set(0.55, 0, 0.008);
    this.scene.add(this.floorShadow);

    const assets = await prepareMjcfAssets("/assets/mujoco/serial/hitexo.xml");
    this.fallbackBodyTransforms = parseDefaultBodyTransforms(assets.rootXml);
    this.fallbackBodyLinks = parseBodyLinks(assets.rootXml);
    await this.buildExolimbVisuals(assets.rootXml);
    await this.buildHumanVisual();
    this.applyFallbackPose();
    this.buildWearableHarness();
    this.frameScene();

    try {
      this.mujoco = await loadMujocoModule();
      writeAssetsToVfs(this.mujoco, assets);
      this.model = this.mujoco.MjModel.from_xml_path(assets.entryVirtualPath);
      this.data = new this.mujoco.MjData(this.model);
    } catch (error) {
      this.fallbackActive = true;
      this.onState?.({
        endEffector: [0.9, 0, 0.09],
        target: this.mocapTarget,
        mode: "fallback",
        effort: 0,
        trackingError: 0,
        contact: error instanceof Error ? `MuJoCo fallback: ${error.message}` : "MuJoCo fallback active.",
        loaded: false,
      });
    }

    window.addEventListener("resize", this.handleResize);
    this.startLoop();
  }

  dispose(): void {
    cancelAnimationFrame(this.frameHandle);
    window.removeEventListener("resize", this.handleResize);
    this.model?.delete();
    this.data?.delete();
    this.renderer?.dispose();
    this.controls?.dispose();
    this.groundTexture?.dispose();
  }

  setRunning(running: boolean): void {
    this.running = running;
  }

  setJointTestMode(enabled: boolean): void {
    this.jointTestMode = enabled;
    this.jointTestTime = 0;
    if (!enabled && this.fallbackActive) {
      this.applyFallbackPose();
    }
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
      this.exolimbRoot?.add(anchor);

      const mirroredAnchor = new THREE.Group();
      mirroredAnchor.name = `${bodyName}-mirror`;
      this.mirroredBodyGroups.set(bodyName, mirroredAnchor);
      this.mirroredExolimbRoot?.add(mirroredAnchor);

      meshFiles.forEach((meshFile) => {
        promises.push(
          new Promise((resolve, reject) => {
            loader.load(
              `/assets/mujoco/serial/${meshFile}`,
              (geometry) => {
                geometry.computeVertexNormals();
                const material = new THREE.MeshStandardMaterial({
                  color: "#6b7280",
                  metalness: 0.22,
                  roughness: 0.38,
                  side: THREE.DoubleSide,
                });
                const mesh = new THREE.Mesh(geometry, material);
                mesh.castShadow = true;
                mesh.receiveShadow = true;
                anchor.add(mesh);

                const mirroredMesh = mesh.clone();
                mirroredMesh.material = material.clone();
                mirroredAnchor.add(mirroredMesh);
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
    if (!this.scene || !this.wearableRoot) {
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
    root.add(this.wearableRoot);
    this.humanRoot = root;

    try {
      const gltf = await new GLTFLoader().loadAsync(humanVisualAsset.glbPath);
      this.hasHumanMesh = true;
      gltf.scene.rotation.x = Math.PI / 2;
      const visibleHumanMeshNames = new Set(["mesh", "cesium_man", "body_mesh", "head_mesh"]);
      const mannequinMaterial = new THREE.MeshStandardMaterial({
        color: "#eef2f7",
        roughness: 0.78,
        metalness: 0.02,
      });
      gltf.scene.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          const meshName = child.name.toLowerCase();
          if (!visibleHumanMeshNames.has(meshName)) {
            child.visible = false;
            return;
          }
          if (
            meshName.includes("hair") ||
            meshName.includes("shoe") ||
            meshName.includes("teeth") ||
            meshName.includes("tongue") ||
            meshName.includes("eyelash") ||
            meshName.includes("eyeao")
          ) {
            child.visible = false;
            return;
          }
          child.material = mannequinMaterial;
          child.castShadow = true;
          child.receiveShadow = true;
        }
      });
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
      this.hasHumanMesh = false;
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

  private buildWearableHarness(): void {
    if (!this.wearableRoot) {
      return;
    }

    const harness = new THREE.Group();
    harness.name = "wearable-harness";

    const darkMaterial = new THREE.MeshStandardMaterial({
      color: "#1f2937",
      roughness: 0.88,
      metalness: 0.06,
    });
    const ringMaterial = new THREE.MeshStandardMaterial({
      color: "#e5e7eb",
      roughness: 0.32,
      metalness: 0.16,
    });

    const backPlate = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.3, 0.52), darkMaterial);
    backPlate.position.set(-0.39, 0, 0.98);
    harness.add(backPlate);

    const shoulderBar = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.42, 0.06), darkMaterial);
    shoulderBar.position.set(-0.345, 0, 1.31);
    harness.add(shoulderBar);

    [
      [-0.355, -0.19, 1.335],
      [-0.355, 0.19, 1.335],
    ].forEach((position) => {
      const joint = new THREE.Mesh(new THREE.CylinderGeometry(0.095, 0.095, 0.11, 32), ringMaterial);
      joint.rotation.x = Math.PI / 2;
      joint.position.set(position[0], position[1], position[2]);
      harness.add(joint);

      const core = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.15, 24), darkMaterial);
      core.rotation.x = Math.PI / 2;
      core.position.set(position[0], position[1], position[2]);
      harness.add(core);
    });

    [
      [-0.25, -0.125, 0.98, 0.28],
      [-0.25, 0.125, 0.98, -0.28],
    ].forEach((strap) => {
      const shoulderStrap = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.1, 0.62), darkMaterial);
      shoulderStrap.position.set(strap[0], strap[1], strap[2]);
      shoulderStrap.rotation.y = strap[3];
      harness.add(shoulderStrap);
    });

    this.wearableRoot.add(harness);
  }

  private startLoop(): void {
    const tick = (timestamp: number) => {
      if (!this.renderer || !this.scene || !this.camera) {
        return;
      }

      if (this.lastTick === 0) {
        this.lastTick = timestamp;
      }
      const deltaSeconds = Math.min((timestamp - this.lastTick) / 1000, 1 / 30);
      this.lastTick = timestamp;

      if (!this.mujoco || !this.model || !this.data) {
        if (this.jointTestMode) {
          this.jointTestTime += deltaSeconds;
          this.applyProceduralJointPose(this.createJointTestTargets(this.jointTestTime));
        }
        if (this.renderer && this.scene && this.camera) {
          this.syncHumanVisual();
          this.controls?.update();
          this.updatePresentationShadow();
          this.renderer.render(this.scene, this.camera);
          this.frameHandle = requestAnimationFrame(tick);
        }
        return;
      }

      if (this.running || this.jointTestMode) {
        this.applyHumanTarget();
        const stepCount = Math.max(1, Math.round(deltaSeconds / 0.001));
        for (let index = 0; index < stepCount; index += 1) {
          if (this.jointTestMode) {
            this.applyJointTestControl(this.jointTestTime + index * 0.001);
          } else {
            this.applySkillControl();
          }
          this.mujoco.mj_step(this.model, this.data);
        }
        if (this.jointTestMode) {
          this.jointTestTime += deltaSeconds;
        }
      }

      this.humanMixer?.update(0);
      this.syncVisuals();
      this.controls?.update();
      this.updatePresentationShadow();
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

  private applyJointTestControl(time: number): void {
    if (!this.data || !this.model) {
      return;
    }

    const targets = this.createJointTestTargets(time);
    for (let index = 0; index < Math.min(targets.length, this.model.nu); index += 1) {
      this.data.ctrl.set(index, targets[index]);
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
      group.position.set(
        (pos[0] ?? 0) + this.exolimbVisualOffset.x,
        (pos[1] ?? 0) + this.exolimbVisualOffset.y,
        (pos[2] ?? 0) + this.exolimbVisualOffset.z,
      );
      group.quaternion.set(quat[1] ?? 0, quat[2] ?? 0, quat[3] ?? 0, quat[0] ?? 1);
      group.updateMatrixWorld();
    });

    this.mirroredBodyGroups.forEach((group, bodyName) => {
      const body = this.data?.body(bodyName);
      if (!body) {
        return;
      }
      const pos = readVector(body.xpos, 3);
      const quat = readVector(body.xquat, 4);
      group.position.set(
        (pos[0] ?? 0) + this.exolimbVisualOffset.x,
        (pos[1] ?? 0) + this.exolimbVisualOffset.y,
        (pos[2] ?? 0) + this.exolimbVisualOffset.z,
      );
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
      mode: this.jointTestMode ? "joint_test" : this.currentSkill?.skillName ?? "idle",
      effort: Number(this.currentSkill?.args.supportForce ?? this.currentSkill?.args.trackingGain ?? 0.2),
      trackingError: distance,
      contact: this.jointTestMode ? "六轴联调中" : distance < 0.08 ? "协同接触中" : "跟随接近中",
      loaded: true,
    });
  }

  private syncHumanVisual(): void {
    if (!this.currentHuman || !this.humanRoot) {
      return;
    }

    this.humanRoot.visible = true;

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

    const rootX = this.fallbackActive ? 0.12 : -0.9 + (this.currentHuman.root[0] / 100) * 0.16;
    const rootY = this.fallbackActive ? 0.02 : -0.78 + ((100 - this.currentHuman.root[1]) / 100) * 0.12;
    this.humanRoot.position.set(rootX, rootY, 0);
    this.humanRoot.rotation.set(0, 0, this.fallbackActive ? Math.PI / 2 : 0);

    const handX = this.fallbackActive ? 0.28 : -0.72 + (this.currentHuman.hand[0] / 100) * 0.18;
    const handZ = this.fallbackActive ? 0.98 : 0.65 + ((100 - this.currentHuman.hand[1]) / 100) * 0.75;
    if (this.proxyRightHand) {
      this.proxyRightHand.position.set(handX, this.fallbackActive ? -0.08 : -0.18, handZ);
    }
    if (this.proxyLeftHand) {
      this.proxyLeftHand.position.set(
        this.fallbackActive ? 0.18 : handX * 0.88,
        this.fallbackActive ? 0.08 : 0.18,
        this.fallbackActive ? 0.88 : handZ * 0.98,
      );
    }
  }

  private applyFallbackPose(): void {
    if (this.jointTestMode) {
      return;
    }
    this.bodyGroups.forEach((group, bodyName) => {
      const position = this.fallbackBodyTransforms.get(bodyName);
      if (!position) {
        return;
      }
      group.position.set(
        position[0] + this.exolimbVisualOffset.x,
        position[1] + this.exolimbVisualOffset.y,
        position[2] + this.exolimbVisualOffset.z,
      );
      group.quaternion.identity();
      group.updateMatrixWorld();
    });

    this.mirroredBodyGroups.forEach((group, bodyName) => {
      const position = this.fallbackBodyTransforms.get(bodyName);
      if (!position) {
        return;
      }
      group.position.set(
        position[0] + this.exolimbVisualOffset.x,
        position[1] + this.exolimbVisualOffset.y,
        position[2] + this.exolimbVisualOffset.z,
      );
      group.quaternion.identity();
      group.updateMatrixWorld();
    });
  }

  private createJointTestTargets(time: number): number[] {
    const amplitudes = [0.72, 0.82, 0.92, 1.12, 0.74, 0.95];
    const frequencies = [0.55, 0.7, 0.84, 1.0, 1.18, 1.34];
    const phases = [0, 0.8, 1.5, 2.2, 2.9, 3.6];
    return amplitudes.map((amplitude, index) => amplitude * Math.sin(time * frequencies[index] * Math.PI + phases[index]));
  }

  private applyProceduralJointPose(jointTargets: number[]): void {
    const transform = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();

    BrowserMujocoRuntime.LINK_DEFS.forEach((link, index) => {
      const [offsetX, offsetY, offsetZ] = link.offset;
      const rotation = new THREE.Matrix4().makeRotationAxis(
        new THREE.Vector3(...link.axis).normalize(),
        jointTargets[index] ?? 0,
      );

      transform.multiply(new THREE.Matrix4().makeTranslation(offsetX, offsetY, offsetZ));
      transform.multiply(rotation);
      transform.decompose(position, quaternion, scale);

      const group = this.bodyGroups.get(link.bodyName);
      if (group) {
        group.position.copy(position);
        group.quaternion.copy(quaternion);
        group.updateMatrixWorld();
      }

      const mirroredGroup = this.mirroredBodyGroups.get(link.bodyName);
      if (mirroredGroup) {
        mirroredGroup.position.copy(position);
        mirroredGroup.quaternion.copy(quaternion);
        mirroredGroup.updateMatrixWorld();
      }
    });

    const endEffector = new THREE.Vector3();
    this.bodyGroups.get("Link6")?.getWorldPosition(endEffector);
    this.onState?.({
      endEffector: [endEffector.x, endEffector.y, endEffector.z],
      target: this.mocapTarget,
      mode: "joint_test",
      effort: 0.5,
      trackingError: 0,
      contact: "六轴联调中",
      loaded: false,
    });
  }

  private buildFallbackGuide(): void {
    if (!this.scene || this.bodyGroups.size > 0) {
      return;
    }

    this.fallbackGuide?.removeFromParent();

    const guide = new THREE.Group();
    guide.name = "fallback-guide";

    const jointMaterial = new THREE.MeshStandardMaterial({
      color: "#cbd5e1",
      emissive: "#eef2ff",
      roughness: 0.35,
      metalness: 0.25,
      transparent: true,
      opacity: 0.96,
    });

    const linkMaterial = new THREE.MeshStandardMaterial({
      color: "#e5e7eb",
      roughness: 0.22,
      metalness: 0.12,
      transparent: true,
      opacity: 0.94,
    });

    this.fallbackBodyTransforms.forEach((position, bodyName) => {
      if (bodyName === "ikdummy") {
        return;
      }
      const joint = new THREE.Mesh(new THREE.SphereGeometry(0.072, 24, 24), jointMaterial);
      joint.position.set(
        position[0] + this.exolimbVisualOffset.x,
        position[1] + this.exolimbVisualOffset.y,
        position[2] + this.exolimbVisualOffset.z,
      );
      joint.castShadow = true;
      guide.add(joint);
    });

    this.fallbackBodyLinks.forEach(({ from, to }) => {
      const fromPosition = this.fallbackBodyTransforms.get(from);
      const toPosition = this.fallbackBodyTransforms.get(to);
      if (!fromPosition || !toPosition) {
        return;
      }

      const start = new THREE.Vector3(
        fromPosition[0] + this.exolimbVisualOffset.x,
        fromPosition[1] + this.exolimbVisualOffset.y,
        fromPosition[2] + this.exolimbVisualOffset.z,
      );
      const end = new THREE.Vector3(
        toPosition[0] + this.exolimbVisualOffset.x,
        toPosition[1] + this.exolimbVisualOffset.y,
        toPosition[2] + this.exolimbVisualOffset.z,
      );
      const direction = new THREE.Vector3().subVectors(end, start);
      const length = direction.length();
      if (length <= 0.0001) {
        return;
      }

      const link = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, Math.max(length - 0.1, 0.02), 10, 18), linkMaterial);
      link.position.copy(start).add(end).multiplyScalar(0.5);
      link.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.clone().normalize());
      link.castShadow = true;
      guide.add(link);
    });

    this.fallbackGuide = guide;
    this.exolimbRoot?.add(guide);
  }

  private frameScene(): void {
    if (!this.camera || !this.controls) {
      return;
    }
    const center = new THREE.Vector3(-0.08, 0, 1.18);
    this.controls.target.copy(center);
    this.camera.position.set(2.15, -1.45, 1.56);
    this.camera.lookAt(center);
    this.controls.update();
  }

  private updatePresentationShadow(): void {
    if (!this.floorShadow || !this.humanRoot) {
      return;
    }

    const bounds = new THREE.Box3().setFromObject(this.humanRoot);
    if (bounds.isEmpty()) {
      return;
    }

    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    this.floorShadow.position.set(center.x, center.y, 0.008);
    this.floorShadow.scale.setScalar(Math.max(size.x, size.y) * 0.92);
  }
}
