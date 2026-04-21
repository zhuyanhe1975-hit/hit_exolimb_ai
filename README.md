# HIT ExoLimb AI Prototype

一个聚焦于上肢外肢体协同控制的 Web 前端原型。

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

如需启用 Gemini Spatial Understanding，请在项目根目录创建 `.env.local`：

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
