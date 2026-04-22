import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { Reflector } from "three/examples/jsm/objects/Reflector.js";
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

interface ImportedHumanMotion {
  boneNames: string[];
  frameRate: number;
  positions: number[][][];
  quaternions: number[][][];
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
  const size = 512;
  const tileSize = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;

  const context = canvas.getContext("2d");
  if (!context) {
    const fallback = new THREE.CanvasTexture(canvas);
    fallback.colorSpace = THREE.SRGBColorSpace;
    return fallback;
  }

  for (let row = 0; row < size; row += tileSize) {
    for (let column = 0; column < size; column += tileSize) {
      const isEven = ((column / tileSize) + (row / tileSize)) % 2 === 0;
      context.fillStyle = isEven ? "#4d77a8" : "#345f91";
      context.fillRect(column, row, tileSize, tileSize);
    }
  }

  context.strokeStyle = "rgba(225, 238, 255, 0.64)";
  context.lineWidth = 2.5;
  for (let offset = 0; offset <= size; offset += tileSize) {
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
  texture.repeat.set(18, 18);
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

  private static readonly WEARABLE_MOUNT_BONE = "b_spine3";

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

  private humanBones = new Map<string, THREE.Object3D>();

  private humanRestQuaternions = new Map<string, THREE.Quaternion>();

  private importedHumanMotion?: ImportedHumanMotion;

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
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
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
    this.scene.background = new THREE.Color("#6f95c2");
    this.scene.fog = new THREE.Fog("#80a2cb", 7, 22);

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

    this.scene.add(new THREE.HemisphereLight(0xdbe9ff, 0x46678f, 0.9));

    const keyLight = new THREE.DirectionalLight(0xfff2d8, 2.2);
    keyLight.position.set(4.1, -3.0, 7.2);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(2048, 2048);
    keyLight.shadow.bias = -0.0002;
    keyLight.shadow.normalBias = 0.02;
    keyLight.shadow.camera.near = 0.5;
    keyLight.shadow.camera.far = 20;
    keyLight.shadow.camera.left = -4;
    keyLight.shadow.camera.right = 4;
    keyLight.shadow.camera.top = 4;
    keyLight.shadow.camera.bottom = -4;
    this.scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0x9dcaff, 0.45);
    fillLight.position.set(-4.2, 2.7, 4.0);
    this.scene.add(fillLight);

    const rimLight = new THREE.DirectionalLight(0xffffff, 0.22);
    rimLight.position.set(1.2, 4.5, 3.0);
    this.scene.add(rimLight);

    this.groundTexture = createMenagerieGridTexture();
    const pixelRatio = Math.min(window.devicePixelRatio, 2);
    const floorReflector = new Reflector(new THREE.PlaneGeometry(24, 24), {
      textureWidth: Math.floor(this.canvas.clientWidth * pixelRatio),
      textureHeight: Math.floor(this.canvas.clientHeight * pixelRatio),
      color: 0x5d86b4,
      clipBias: 0.003,
    });
    floorReflector.position.z = -0.003;
    this.scene.add(floorReflector);

    const stage = new THREE.Mesh(
      new THREE.PlaneGeometry(24, 24),
      new THREE.MeshPhysicalMaterial({
        map: this.groundTexture,
        transparent: true,
        opacity: 0.96,
        roughness: 0.1,
        metalness: 0.06,
        clearcoat: 0.72,
        clearcoatRoughness: 0.14,
        reflectivity: 0.7,
      }),
    );
    stage.receiveShadow = true;
    stage.position.z = -0.0015;
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
      gltf.scene.traverse((child) => {
        if (child.name) {
          this.humanBones.set(child.name, child);
          this.humanRestQuaternions.set(child.name, child.quaternion.clone());
        }
      });
      root.add(gltf.scene);
      root.updateMatrixWorld(true);
      const wearableMount = this.humanBones.get(BrowserMujocoRuntime.WEARABLE_MOUNT_BONE);
      if (wearableMount && this.wearableRoot) {
        wearableMount.attach(this.wearableRoot);
      }
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
      const response = await fetch("/assets/human/ai4animation/motions/cranberry_walk_forward_local.json");
      if (response.ok) {
        this.importedHumanMotion = (await response.json()) as ImportedHumanMotion;
      }
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
      this.syncHumanVisual();
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

    const gaitPhase = this.currentHuman.time * 2.4;
    const liveUpperBody = this.currentHuman.liveUpperBody;
    const useLiveUpperBody =
      this.currentHuman.clipId === "camera-live" &&
      liveUpperBody?.enabled &&
      this.humanBones.size > 0;
    const useImportedMotion =
      !useLiveUpperBody &&
      this.currentHuman.clipId === "lift-assist" &&
      Boolean(this.importedHumanMotion) &&
      this.humanBones.size > 0;
    const swayX = Math.sin(gaitPhase) * 0.05;
    const swayY = Math.cos(gaitPhase * 0.5) * 0.04;
    const bobZ = Math.abs(Math.sin(gaitPhase)) * 0.06;
    const rootX = useLiveUpperBody
      ? -0.6
      : useImportedMotion
        ? -0.58
        : -0.82 + (this.currentHuman.root[0] - 22) * 0.24 + swayX;
    const rootY = useImportedMotion
      ? -0.18
      : useLiveUpperBody
        ? -0.16
      : -0.7 + (72 - this.currentHuman.root[1]) * 0.2 + (this.currentHuman.root[0] - 22) * 0.03 + swayY;
    this.humanRoot.position.set(rootX, rootY, useImportedMotion || useLiveUpperBody ? 0 : bobZ);
    this.humanRoot.scale.setScalar(useLiveUpperBody ? liveUpperBody?.bodyScale ?? 1 : 1);

    const handX = -0.64 + (this.currentHuman.hand[0] - 34) * 0.022;
    const handZ = 0.82 + (60 - this.currentHuman.hand[1]) * 0.028;
    const shoulderBias = THREE.MathUtils.clamp((this.currentHuman.joints.shoulder - 30) / 90, -0.35, 0.45);
    const elbowBias = THREE.MathUtils.clamp((this.currentHuman.joints.elbow - 45) / 120, -0.18, 0.3);
    this.humanRoot.rotation.set(
      useImportedMotion || useLiveUpperBody ? 0 : Math.sin(gaitPhase * 0.5) * 0.08,
      useImportedMotion || useLiveUpperBody
        ? liveUpperBody?.torsoYaw ?? 0
        : shoulderBias * 0.28 + Math.cos(gaitPhase * 0.5) * 0.05,
      useImportedMotion || useLiveUpperBody
        ? Math.PI / 2 + (liveUpperBody?.torsoLean ?? 0)
        : shoulderBias * 0.4 + elbowBias * 0.18 + Math.sin(gaitPhase) * 0.09,
    );

    if (useImportedMotion) {
      this.applyImportedHumanMotion(this.currentHuman.time);
    } else if (useLiveUpperBody) {
      this.applyLiveUpperBodyPose();
    }

    const animationName =
      this.currentHuman.clipId === "lift-assist"
        ? humanVisualAsset.animationMap.lift_assist
        : this.currentHuman.clipId === "position-assist"
          ? humanVisualAsset.animationMap.position_assist
          : humanVisualAsset.animationMap.compliance_support;

    if (!useLiveUpperBody && this.humanMixer && this.humanActions.size > 0) {
      const fallbackAction = this.humanActions.values().next().value as
        | THREE.AnimationAction
        | undefined;
      const activeAction =
        (animationName ? this.humanActions.get(animationName) : undefined) ?? fallbackAction;

      this.humanActions.forEach((action, name) => {
        const active = action === activeAction || name === animationName;
        action.enabled = active;
        action.weight = active ? 1 : 0;
        action.paused = true;
      });

      const clipDuration = activeAction?.getClip().duration ?? 1;
      if (activeAction) {
        this.humanMixer.setTime(
          ((this.currentHuman.time % clipDuration) + clipDuration) % clipDuration,
        );
      }
    }

    if (this.proxyRightHand) {
      this.proxyRightHand.position.set(handX, -0.18, handZ);
    }
    if (this.proxyLeftHand) {
      this.proxyLeftHand.position.set(
        handX * 0.88,
        0.18,
        handZ * 0.98,
      );
    }
  }

  private applyImportedHumanMotion(time: number): void {
    if (!this.importedHumanMotion) {
      return;
    }

    const frameCount = this.importedHumanMotion.positions.length;
    if (frameCount === 0) {
      return;
    }

    const frameIndex =
      Math.floor((((time * this.importedHumanMotion.frameRate) % frameCount) + frameCount) % frameCount);
    const positions = this.importedHumanMotion.positions[frameIndex];
    const quaternions = this.importedHumanMotion.quaternions[frameIndex];

    for (let index = 0; index < this.importedHumanMotion.boneNames.length; index += 1) {
      const boneName = this.importedHumanMotion.boneNames[index];
      const bone = this.humanBones.get(boneName);
      const position = positions[index];
      const quaternion = quaternions[index];
      if (!bone || !position || !quaternion) {
        continue;
      }
      bone.position.set(position[0] ?? 0, position[1] ?? 0, position[2] ?? 0);
      bone.quaternion.set(
        quaternion[0] ?? 0,
        quaternion[1] ?? 0,
        quaternion[2] ?? 0,
        quaternion[3] ?? 1,
      );
    }
  }

  private applyLiveUpperBodyPose(): void {
    const liveUpperBody = this.currentHuman?.liveUpperBody;
    if (!liveUpperBody?.enabled) {
      return;
    }

    this.applyTrackedArmPose("left", liveUpperBody.leftArm);
    this.applyTrackedArmPose("right", liveUpperBody.rightArm);
  }

  private applyTrackedArmPose(side: "left" | "right", arm?: NonNullable<HumanState["liveUpperBody"]>["leftArm"]): void {
    const armBone = this.humanBones.get(`b_${side[0]}_arm`);
    const forearmBone = this.humanBones.get(`b_${side[0]}_forearm`);
    const wristTwistBone = this.humanBones.get(`b_${side[0]}_wrist_twist`);
    const wristBone = this.humanBones.get(`b_${side[0]}_wrist`);
    const shoulderBone = this.humanBones.get(`b_${side[0]}_shoulder`);

    if (!arm?.visible || !armBone || !forearmBone || !wristBone) {
      this.restoreTrackedHand(side);
      return;
    }

    this.rotateBoneTowards(
      `b_${side[0]}_arm`,
      this.mapTrackingVector(arm.elbow, arm.shoulder),
      `b_${side[0]}_forearm`,
    );
    this.rotateBoneTowards(
      `b_${side[0]}_forearm`,
      this.mapTrackingVector(arm.wrist, arm.elbow),
      `b_${side[0]}_wrist`,
    );

    if (shoulderBone) {
      const shoulderLift = THREE.MathUtils.clamp((arm.shoulder.y - arm.elbow.y) * -1.6, -0.35, 0.55);
      shoulderBone.rotation.z = side === "left" ? shoulderLift : -shoulderLift;
      shoulderBone.rotation.y = side === "left" ? 0.12 : -0.12;
    }

    if (arm.hand) {
      const handAxis = this.mapTrackingVector(arm.hand.indexMcp, arm.hand.pinkyMcp).normalize();
      const forwardAxis = this.mapTrackingVector(arm.hand.middleMcp, arm.hand.wrist).normalize();
      this.orientWristBone(
        `b_${side[0]}_wrist`,
        handAxis,
        forwardAxis,
        side,
        arm.hand.openness,
        arm.hand.pinch,
        arm.hand.handSize,
      );
      if (wristTwistBone) {
        const twistSign = side === "left" ? -1 : 1;
        wristTwistBone.rotation.x = twistSign * THREE.MathUtils.clamp(handAxis.z * 0.8, -0.5, 0.5);
      }
      this.applyTrackedThumbPose(side, arm.hand.wrist, arm.hand.thumbMcp, arm.hand.thumbIp, arm.hand.thumbTip);
      this.applyTrackedFingerPose(side, "index", arm.hand.indexMcp, arm.hand.indexPip, arm.hand.indexDip, arm.hand.indexTip);
      this.applyTrackedFingerPose(side, "middle", arm.hand.middleMcp, arm.hand.middlePip, arm.hand.middleDip, arm.hand.middleTip);
      this.applyTrackedFingerPose(side, "ring", arm.hand.ringMcp, arm.hand.ringPip, arm.hand.ringDip, arm.hand.ringTip);
      this.applyTrackedFingerPose(side, "pinky", arm.hand.pinkyMcp, arm.hand.pinkyPip, arm.hand.pinkyDip, arm.hand.pinkyTip);
      this.applyFingerCurl(side, arm.hand.openness, arm.hand.pinch, arm.hand.handSize);
    } else {
      this.restoreTrackedHand(side);
    }
  }

  private rotateBoneTowards(boneName: string, desiredDirection: THREE.Vector3, childName: string): void {
    const bone = this.humanBones.get(boneName);
    const child = this.humanBones.get(childName);
    const restQuaternion = this.humanRestQuaternions.get(boneName);
    if (!bone || !child || !bone.parent || !restQuaternion || desiredDirection.lengthSq() < 1e-6) {
      return;
    }

    const restDirection = child.position.clone().normalize();
    if (restDirection.lengthSq() < 1e-6) {
      return;
    }

    const parentWorldQuaternion = new THREE.Quaternion();
    bone.parent.getWorldQuaternion(parentWorldQuaternion);
    const desiredDirectionInParent = desiredDirection
      .clone()
      .normalize()
      .applyQuaternion(parentWorldQuaternion.invert());
    const restDirectionInParent = restDirection.clone().applyQuaternion(restQuaternion);
    const delta = new THREE.Quaternion().setFromUnitVectors(
      restDirectionInParent.normalize(),
      desiredDirectionInParent.normalize(),
    );
    bone.quaternion.copy(delta.multiply(restQuaternion.clone())).normalize();
  }

  private orientWristBone(
    boneName: string,
    lateralAxis: THREE.Vector3,
    forwardAxis: THREE.Vector3,
    side: "left" | "right",
    openness: number,
    pinch: number,
    handSize: number,
  ): void {
    const bone = this.humanBones.get(boneName);
    const restQuaternion = this.humanRestQuaternions.get(boneName);
    if (!bone || !restQuaternion) {
      return;
    }

    bone.quaternion.copy(restQuaternion);
    const gripBias = THREE.MathUtils.clamp(1 - pinch, 0, 1);
    const sizeBias = THREE.MathUtils.clamp((handSize - 0.07) * 4.0, -0.12, 0.18);
    const roll = THREE.MathUtils.clamp((1 - openness) * 0.38 + gripBias * 0.28 + sizeBias, -0.3, 0.68);
    const yaw = THREE.MathUtils.clamp(lateralAxis.y * 1.2 + forwardAxis.y * 0.5, -0.6, 0.6);
    const pitch = THREE.MathUtils.clamp(lateralAxis.z * 1.2 + forwardAxis.z * 1.1, -0.75, 0.75);
    bone.rotateX(side === "left" ? pitch : -pitch);
    bone.rotateY(side === "left" ? yaw : -yaw);
    bone.rotateZ(side === "left" ? -roll : roll);
  }

  private applyFingerCurl(side: "left" | "right", openness: number, pinch: number, handSize: number): void {
    const gripBias = THREE.MathUtils.clamp(1 - pinch, 0, 1);
    const spreadBias = THREE.MathUtils.clamp((handSize - 0.08) * 3.2, -0.12, 0.18);
    const curl = THREE.MathUtils.clamp(1 - openness * 0.72 + gripBias * 0.52 - spreadBias, 0, 1);
    const pinchCurl = THREE.MathUtils.clamp(gripBias + 0.28 - spreadBias, 0, 1);
    const digits = ["index", "middle", "ring", "pinky"] as const;
    digits.forEach((digit) => {
      const base = this.humanBones.get(`b_${side[0]}_${digit}1`);
      const mid = this.humanBones.get(`b_${side[0]}_${digit}2`);
      const tip = this.humanBones.get(`b_${side[0]}_${digit}3`);
      const sign = side === "left" ? -1 : 1;
      if (base) {
        base.rotation.y = sign * curl * 0.82;
      }
      if (mid) {
        mid.rotation.y = sign * curl * 0.96;
      }
      if (tip) {
        tip.rotation.y = sign * curl * 0.7;
      }
    });

    const thumb0 = this.humanBones.get(`b_${side[0]}_thumb0`);
    const thumb1 = this.humanBones.get(`b_${side[0]}_thumb1`);
    const thumb2 = this.humanBones.get(`b_${side[0]}_thumb2`);
    const thumb3 = this.humanBones.get(`b_${side[0]}_thumb3`);
    const thumbSign = side === "left" ? 1 : -1;
    if (thumb0) {
      thumb0.rotation.z = thumbSign * (0.22 + pinchCurl * 0.3);
    }
    if (thumb1) {
      thumb1.rotation.y = thumbSign * pinchCurl * 0.45;
    }
    if (thumb2) {
      thumb2.rotation.y = thumbSign * pinchCurl * 0.55;
    }
    if (thumb3) {
      thumb3.rotation.y = thumbSign * pinchCurl * 0.35;
    }
  }

  private applyTrackedFingerPose(
    side: "left" | "right",
    finger: "thumb" | "index" | "middle" | "ring" | "pinky",
    joint0: { x: number; y: number; z: number },
    joint1: { x: number; y: number; z: number },
    joint2: { x: number; y: number; z: number },
    joint3?: { x: number; y: number; z: number },
  ): void {
    const prefix = `b_${side[0]}_${finger}`;
    const bone1 = this.humanBones.get(`${prefix}1`);
    const bone2 = this.humanBones.get(`${prefix}2`);
    const bone3 = this.humanBones.get(`${prefix}3`);
    if (bone1 && joint0 && joint1) {
      this.rotateBoneTowards(`${prefix}1`, this.mapTrackingVector(joint1, joint0), `${prefix}2`);
    }
    if (bone2 && joint1 && joint2) {
      this.rotateBoneTowards(`${prefix}2`, this.mapTrackingVector(joint2, joint1), `${prefix}3`);
    }
    if (bone3 && joint2 && joint3) {
      const nullName = `${prefix}_null`;
      if (this.humanBones.has(nullName)) {
        this.rotateBoneTowards(`${prefix}3`, this.mapTrackingVector(joint3, joint2), nullName);
      }
    }
  }

  private applyTrackedThumbPose(
    side: "left" | "right",
    wrist: { x: number; y: number; z: number },
    mcp: { x: number; y: number; z: number },
    ip: { x: number; y: number; z: number },
    tip: { x: number; y: number; z: number },
  ): void {
    const prefix = `b_${side[0]}_thumb`;
    if (this.humanBones.get(`${prefix}0`) && this.humanBones.get(`${prefix}1`)) {
      this.rotateBoneTowards(`${prefix}0`, this.mapTrackingVector(mcp, wrist), `${prefix}1`);
    }
    if (this.humanBones.get(`${prefix}1`) && this.humanBones.get(`${prefix}2`)) {
      this.rotateBoneTowards(`${prefix}1`, this.mapTrackingVector(ip, mcp), `${prefix}2`);
    }
    if (this.humanBones.get(`${prefix}2`) && this.humanBones.get(`${prefix}3`)) {
      this.rotateBoneTowards(`${prefix}2`, this.mapTrackingVector(tip, ip), `${prefix}3`);
    }
  }

  private restoreTrackedHand(side: "left" | "right"): void {
    const bonePrefix = `b_${side[0]}_`;
    [
      `${bonePrefix}wrist`,
      `${bonePrefix}wrist_twist`,
      `${bonePrefix}thumb0`,
      `${bonePrefix}thumb1`,
      `${bonePrefix}thumb2`,
      `${bonePrefix}thumb3`,
      `${bonePrefix}index1`,
      `${bonePrefix}index2`,
      `${bonePrefix}index3`,
      `${bonePrefix}middle1`,
      `${bonePrefix}middle2`,
      `${bonePrefix}middle3`,
      `${bonePrefix}ring1`,
      `${bonePrefix}ring2`,
      `${bonePrefix}ring3`,
      `${bonePrefix}pinky1`,
      `${bonePrefix}pinky2`,
      `${bonePrefix}pinky3`,
      `${bonePrefix}shoulder`,
    ].forEach((boneName) => {
      const bone = this.humanBones.get(boneName);
      const restQuaternion = this.humanRestQuaternions.get(boneName);
      if (bone && restQuaternion) {
        bone.quaternion.copy(restQuaternion);
      }
    });
  }

  private mapTrackingVector(
    to: { x: number; y: number; z: number },
    from: { x: number; y: number; z: number },
  ): THREE.Vector3 {
    return new THREE.Vector3(-(to.z - from.z), to.x - from.x, -(to.y - from.y));
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
