import type { SkillCall } from "../types";

export interface AssetFileRecord {
  publicPath: string;
  virtualPath: string;
  type: "text" | "binary";
  text?: string;
  bytes?: Uint8Array;
}

export interface PreparedMjcfAssets {
  entryVirtualPath: string;
  rootXml: string;
  files: AssetFileRecord[];
}

const PUBLIC_ROOT = "/assets/mujoco";

const toVirtualPath = (publicPath: string): string => {
  const relative = publicPath.replace(`${PUBLIC_ROOT}/`, "");
  return `/working/${relative}`;
};

const ensureDirectory = (mujoco: { FS_createPath: (...args: any[]) => void }, path: string): void => {
  const parts = path.split("/").filter(Boolean);
  let current = "/";
  for (const part of parts) {
    try {
      mujoco.FS_createPath(current, part, true, true);
    } catch {
      // Directory exists already.
    }
    current = `${current}${part}/`;
  }
};

const discoverDependencies = (basePath: string, xmlText: string): string[] => {
  const parser = new DOMParser();
  const xml = parser.parseFromString(xmlText, "application/xml");
  const dependencies = new Set<string>();

  xml.querySelectorAll("[file]").forEach((element) => {
    const file = element.getAttribute("file");
    if (!file) {
      return;
    }
    const resolved = new URL(file, `https://local${basePath}`).pathname;
    if (resolved.startsWith(PUBLIC_ROOT)) {
      dependencies.add(resolved);
    }
  });

  return [...dependencies];
};

export const prepareMjcfAssets = async (
  entryPublicPath: string,
): Promise<PreparedMjcfAssets> => {
  const queue = [entryPublicPath];
  const visited = new Set<string>();
  const files = new Map<string, AssetFileRecord>();
  let rootXml = "";

  while (queue.length > 0) {
    const publicPath = queue.shift();
    if (!publicPath || visited.has(publicPath)) {
      continue;
    }
    visited.add(publicPath);

    const response = await fetch(publicPath);
    if (!response.ok) {
      throw new Error(`Failed to fetch asset: ${publicPath}`);
    }

    const virtualPath = toVirtualPath(publicPath);
    if (publicPath.endsWith(".xml")) {
      const text = await response.text();
      files.set(publicPath, {
        publicPath,
        virtualPath,
        type: "text",
        text,
      });
      if (publicPath === entryPublicPath) {
        rootXml = text;
      }
      discoverDependencies(publicPath, text).forEach((dependency) => {
        if (!visited.has(dependency)) {
          queue.push(dependency);
        }
      });
    } else {
      const bytes = new Uint8Array(await response.arrayBuffer());
      files.set(publicPath, {
        publicPath,
        virtualPath,
        type: "binary",
        bytes,
      });
    }
  }

  return {
    entryVirtualPath: toVirtualPath(entryPublicPath),
    rootXml,
    files: [...files.values()],
  };
};

export const writeAssetsToVfs = (
  mujoco: { FS_createDataFile: (...args: any[]) => void; FS_createPath: (...args: any[]) => void },
  assets: PreparedMjcfAssets,
): void => {
  ensureDirectory(mujoco, "/working");

  for (const file of assets.files) {
    const segments = file.virtualPath.split("/").filter(Boolean);
    const directory = `/${segments.slice(0, -1).join("/")}`;
    const filename = segments[segments.length - 1];
    ensureDirectory(mujoco, directory);
    try {
      mujoco.FS_createDataFile(
        directory,
        filename,
        file.type === "text" ? new TextEncoder().encode(file.text ?? "") : file.bytes,
        true,
        true,
        true,
      );
    } catch {
      // Ignore duplicate VFS writes across hot reloads.
    }
  }
};

export const humanHandToMocap = (
  hand: [number, number],
  activeSkill?: SkillCall,
): [number, number, number] => {
  const x = 0.18 + (hand[0] / 100) * 0.92;
  const y = activeSkill?.skillName === "force_control_hold" ? 0.0 : -0.02;
  const z = 0.02 + ((100 - hand[1]) / 100) * 0.45;
  return [x, y, z];
};
