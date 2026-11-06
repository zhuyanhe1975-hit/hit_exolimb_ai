# HIT ExoLimb AI Prototype

一个聚焦于上肢外肢体协同控制的 Web 前端原型。

**在线演示：[https://zhuyanhe1975-hit.github.io/hit_exolimb_ai/](https://zhuyanhe1975-hit.github.io/hit_exolimb_ai/)**

推送到 `main` 后，GitHub Actions（`.github/workflows/pages.yml`）会构建静态前端并发布到 GitHub Pages，站点路径为 `/hit_exolimb_ai/`。也可以在 Actions 里手动运行 **Deploy to GitHub Pages**。公网页面不读取仓库中的密钥：没有 Gemini API Key 时，仿真、任务和动作演示仍然可以打开，页面会提示场景分析是可选项。

### 一次性开启 GitHub Pages

仓库管理员若尚未把 Pages 源设为 GitHub Actions，需要做一次设置，否则工作流无法发布站点：

1. 打开本仓库 **Settings → Pages**。
2. 在 **Build and deployment** 中把 **Source** 选为 **GitHub Actions**。
3. 将包含该工作流的变更合并到 `main`。首次启用后，后续推送到 `main` 会自动部署。

不要提交 `.env`、`.env.local` 或 API Key。本地可选密钥只放在被 git 忽略的 `.env.local` 中。

当前版本围绕以下闭环构建：

- 文本任务输入与预设任务选择
- 规则式 AI Planner 生成技能序列
- 人体动作 clip 回放
- 可选加载 AI4AnimationPy 导出的 `worker.glb` 人体外观与动画
- 真实 `hitexo.xml` 外肢体模型在 MuJoCo WASM 中加载和仿真
- Gemini Spatial Understanding 对当前仿真视角做结构化场景理解

## Tech Stack

- React
- TypeScript
- Vite
- MuJoCo WASM (`@mujoco/mujoco`)
- Three.js

## Current Prototype Notes

- 当前通过 VFS 方式把 `public/assets/mujoco/serial/hitexo.xml` 及其 STL/common XML 依赖写入 MuJoCo WASM
- 人体动作系统通过 hand pose 驱动 MuJoCo 模型中的 `ikdummy` mocap 目标
- 如果 `public/assets/human/ai4animation/worker.glb` 存在，会在同一 Three.js 视图中加载 AI4AnimationPy 风格人体；否则退回代理人体
- Three.js 负责同步 MuJoCo body 姿态并显示 STL 可视模型
- Planner 当前为规则模板实现，Gemini Robotics-ER 通过截图分析方式接入空间理解链路

## Development

```bash
npm install
npm run dev
```

本地开发服务器与生产构建都使用 Pages 项目路径，打开 [http://localhost:5173/hit_exolimb_ai/](http://localhost:5173/hit_exolimb_ai/)。

如需启用 Gemini Spatial Understanding，请在项目根目录创建 `.env.local`（不要提交）：

```bash
VITE_GEMINI_API_KEY=your_api_key_here
```

## Build

```bash
npm run build
```

## Key Directories

- `src/ai`: 任务到技能计划与执行状态推进
- `src/human`: 人体动作采样与状态生成
- `src/sim`: MuJoCo VFS 加载、Three.js 渲染和运行时控制
- `src/data`: 固定场景、人体模型、动作 clip 和任务样例
- `public/assets/human/ai4animation`: 放置 AI4AnimationPy 导出的 GLB 人体资产
