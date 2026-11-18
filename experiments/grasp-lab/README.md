# NexArm Grasp Lab — 采集与离线实验

独立实验项目，当前阶段按用户选择聚焦界面、双视角采集与数据准备；不连接执行器、不发起抓取。
服务器部署目录为 `~/nexarm-grasp-lab`；源代码随 nexarm-console 的 `experiments/grasp-lab/` 版本管理。

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m unittest discover -s tests -v
.venv/bin/python -m grasp_lab snapshot --output .runs/scene-001
.venv/bin/python -m grasp_lab audit /path/to/observation.zip
.venv/bin/python -m grasp_lab analyze --image scene.jpg --background empty-table.jpg --output .runs/proposal.json
```

固定第三人称相机记录全局桌面、物体初始状态、遮挡、抓取后结果与放置目标；腕部相机记录局部接近与夹取。
两台 RGB 相机没有自动提供深度；未做同步与双目标定时，不能将两幅图当成已标定的立体视觉。
采集时保留任务文本、目标物体、所用工具、场景布置、相机内外参版本、两路原尺寸图像、六轴状态、实际指令和阶段/成功失败标注。

## 目前能运行的算法

OpenCV 背景差分、形态学和旋转包围框生成几何候选区域，可用于固定桌面离线基线。它不理解工具语义，阴影、机械臂和背景变化都可能产生候选。
没有经实测验证的像素到基座标定时，输出明确要求标定，不能生成可执行机械臂坐标。
提供经过验证的平面单应矩阵后，只输出桌面候选点，仍需工具中心、物体高度、抓取朝向、IK 和路径检查。
不能把合成测试结果当成真实抓取成功率。

## 后续算法路线

| 路线 | 用途 | 当前设备上的条件 |
| --- | --- | --- |
| [LeRobot / ACT](https://github.com/huggingface/lerobot) | 从双视角示教学习动作序列 | 先采集可重复成功的示教；配置相机键、动作单位、归一化，再在 GPU 机器训练 |
| [CLIPort](https://github.com/cliport/cliport) | 语言条件的抓取与放置 | 官方环境/观测与本机不同；需要感知、标定和 NexArm 控制接口适配 |
| [Code as Policies](https://github.com/google-research/google-research/tree/master/code_as_policies) | 从指令和感知生成机器人技能调用程序 | 先提供检测结果、几何与经验证的技能 API；生成程序应先离线审查 |
| [VoxPoser](https://github.com/huangwl18/VoxPoser) | 根据场景与语言组合空间价值图并规划 | 官方仓库以 RLBench 演示为主，真实感知管线需自行实现 |
| [openpi](https://github.com/Physical-Intelligence/openpi) | 视觉—语言—动作策略与远程推理 | 官方要求 NVIDIA GPU；本机 ARM 主控承担观测和控制，推理服务放 GPU 机器 |

“观察场景→理解任务→生成执行代码”有公开研究实现，但不是把相机接上就能直接适配 NexArm。
本项目阶段二会使用受限技能计划（观察、选物、预检、接近、夹取、验证、搬运、放置），由现有运动规划器验证后执行；不直接运行模型生成的任意 Python。
本阶段未下载或部署大型 VLA 权重，未声称完成自主抓取。配置和结果目录 `.runs/` 应保留在本地。
