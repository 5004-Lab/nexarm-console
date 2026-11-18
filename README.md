# NexArm Console

新版 Linux 工作台支持持久操作记录、历史轨迹回看、原生尺寸双相机预览与示教采集。使用说明见 [WORKBENCH.md](WORKBENCH.md)，Linux 部署见 [DEPLOYMENT.md](DEPLOYMENT.md)，独立抓取准备项目见 [Grasp Lab](experiments/grasp-lab/README.md)。

NexArm 六舵机机械臂的浏览器工作台。机械臂和腕部 RGB 相机接到同一台电脑，由该电脑提供串口控制、运动规划、实测反馈和相机画面。浏览器提供数字孪生、XYZ 目标控制、六轴角度输入、反馈曲线和动作组编辑。

## 环境要求

- 主控电脑建议使用 macOS，腕部相机采集程序使用 Swift 和 AVFoundation。安装 Xcode Command Line Tools（`xcode-select --install`），并在系统提示时授权使用相机。
- Python 3.9 或以上，Node.js 20.19+ 或 22.12+，以及支持 WebGL 的现代浏览器。
- 首次构建需访问 npm、PyPI 和 GitHub 原始文件服务。后续构建会复用本地缓存的模型文件。

## 启动

在仓库根目录执行：

```sh
./start.sh
```

脚本创建 Python 虚拟环境、安装缺失的依赖、准备官方模型、构建前端并启动 HTTP 服务。打开 [本机控制台](http://127.0.0.1:8765/)。如果有多个 USB 串口，或相机没有自动识别，显式指定设备：

```sh
./start.sh --device /dev/cu.usbserial-XXXX --camera-device "icSpring"
```

`--port` 可修改主服务端口，默认 `8765`。浏览器显示「USB 已连接」后，点击「启用控制」获得控制权。在前台终端按 Ctrl+C 关闭服务。

## 操作

工作台分为「机械臂控制」「运动遥测」「数据采集」「动作组与调试」四页。可用页签切换，浏览器返回键可回到上一页。

1. **移动到 XYZ**。基座坐标以毫米为单位。可输入 XYZ，也可用「三维选点」拖动 X/Y/Z 箭头或按毫米步长微调，并旋转视角确认深度。「确认目标并检查路径」或「检查路径」会预检可达性和几何碰撞；修改目标后需重新检查，再点击「移动到目标」执行。蓝点表示根据编码器估算的当前工具点，橙点表示目标。
2. **设置关节角度**。手动输入 J1–J6 的目标角度（°），只对修改过的轴下发目标。「动作组与调试」中的单轴点动可按 °/s 设置速度上限。J6 控制夹爪开合。
3. **观察反馈**。数字孪生与腕部彩图并排。收到匹配的视频帧时，双视图按采集时间配对实测姿态。预览满幅显示并可能裁剪边缘，原始数据包保留完整 RGB JPEG。「运动遥测」包含六轴角度、角速度、角加速度、夹爪开度、末端坐标及跟踪误差。速度和加速度从实测编码器按时间差分并滤波。夹爪开度按模型行程换算百分比。科研图表由 Apache ECharts 以 SVG 渲染，曲线使用 [MATLAB 的浅色 gem 配色](https://www.mathworks.com/help/matlab/ref/matlab.graphics.axis.axes-properties.html)。每张图可导出 SVG。工作空间热图显示整个模型可达采样集的 XY 投影，颜色表示每个网格的样本数。
4. **停止运动**。使用页面的「停止」取消后续指令，并请求保持实测位置。板载动作由连接机械臂的本机控制台停止。

XYZ 逆运动学从当前姿态和多组候选初值求解，优先维持工具朝向并保留夹爪开度。规划器先验证关节解及六轴行程，再搜索直达路径或通过碰撞验证的绕行路径。执行时在新的编码器采样上连续下发限幅前瞻位置，轴跟踪持续偏差时从实测姿态重新求解。几何预检通过后仍需实机反馈验收。末端 XYZ 容差 3 mm，执行异常时界面报告对应关节及实测偏差。

「三维选点」保留当前观察视角，显示高度参考平面、可达采样、目标坐标和地面投影。点击平面使用精确坐标，不改选附近采样点；拖动三维箭头可独立修改基座 X/Y/Z。确认后从当前实测姿态预检路径，选点本身不发起运动。修改模型或工位配置后，用 `.venv/bin/python scripts/sample-workspace.py` 更新采样，再构建页面。

「复位」使用 [工位配置](src/workcell.json) 中的 `park_positions`，从当前实测姿态寻找直达或分阶段路径。找不到通过检查的路径时会报错。如果已有动作在运行，先停止并重新启用控制。

动作组支持编辑、电脑在线运行以及 JSON `.d6a` 导入导出。坐标和手动运动使用 LeRobot 桥接协议。桥接时电压显示为切换协议前的测量值。需要板载下载、擦除或校准时，重启服务以恢复板载模式。只有当前服务已记录并检查过的板载动作组可从控制台启动。

## 数据采集与训练

1. 在「动作组与调试」保存至少两帧。首帧是每回合的起始姿态，设备从第二帧开始记录动作。
2. 在「数据采集」输入自然语言任务、采样率和回合数。准备好场景，检查相机和 USB 状态，再点击「开始重复采集」。系统自动回到首帧并执行下一回合。实际物体和场景布置需要满足重复运行条件。运行期间保持控制页面在前台，控制心跳中断时机械臂会停止。
3. 平台使用主机单调时钟对齐腕部 RGB、六轴编码器和串口实际下发指令。帧间同步容差为 65 ms，出现缺帧或跟踪失败的回合不进入训练包。界面显示回合进度、采样数量、丢帧和时差。
4. 在采集记录中下载原始 ZIP。内含 `manifest.json`、每回合的 `frames.jsonl` 与 RGB JPEG。日志保留相机、反馈、动作三个时间戳，动作字段为采集时刻前最后一次下发的六轴绝对角度。该文件可用于逐帧复核。

本机可选安装 LeRobot 导出环境（Python 3.12），支持生成 [LeRobotDataset v3](https://huggingface.co/docs/lerobot/v0.4.4/lerobot-dataset-v3) 的 MP4、Parquet 和元数据。

```sh
python3.12 -m venv .lerobot
.lerobot/bin/python -m pip install 'lerobot==0.4.4'
./start.sh
```

检测到该环境后，平台默认采集结束自动生成 LeRobot v3，也支持手动导出。解压下载文件后可使用 `LeRobotDataset(repo_id, root=dataset_dir, video_backend="pyav")` 读取。训练策略应将 `observation.images.wrist`、`observation.state`、`action` 和任务指令映射到策略输入。采集与导出路径位于本机 `.data/captures/`，不会自动上传。

## 局域网

在可信局域网中使用。两个 LAN 入口使用 HTTP Basic 登录，用户名为 `nexarm`，分别使用至少 12 个字符的密码。先在相应的终端为变量设置本机密码，再运行命令。下面的 IP 是示例，请换成本机和获授权电脑的实际局域网 IPv4。

| 入口 | 默认端口 | 用途 |
| --- | --- | --- |
| `127.0.0.1` | `8765` | 主控电脑，含板载维护 |
| 主控电脑局域网 IPv4 | `8765` | 登录后查看相机和实测反馈 |
| 主控电脑局域网 IPv4 | `8766` | 授权电脑可控制 XYZ、关节和在线动作组 |

**开启局域网查看**。在设置了 `NEXARM_LAN_PASSWORD` 的终端启动主服务：

```sh
./start.sh --lan-host 192.168.1.10
```

**开启局域网控制**。保持主服务运行，在另一个设置了 `NEXARM_CONTROL_PASSWORD` 的终端启动网关：

```sh
.venv/bin/python -m nexarm.lan_control --host 192.168.1.10 --peer 192.168.1.20
```

从 `--peer` 指定的电脑访问 `http://192.168.1.10:8766/`，登录后点击「启用控制」。网关与本机控制台共享同一控制会话，同一时间只允许一个操作者。若主服务使用了自定义端口，为网关加 `--upstream-port` 指定主服务端口。

## 工位与模型

- [六轴参数](src/joints.json) 定义关节名称、常规编码器范围、模型零位、方向和比例。参数来自厂商 URDF 和[舵机配置](https://github.com/Hiwonder/NexArm/blob/0eb4fb8d806454fa1ff753f6a5ad305c63acceb4/src/driver/servo_controller/config/servo_controller.yaml)。起点已在常规范围外时，规划允许保持或往范围内退回。
- [工位配置](src/workcell.json) 定义工具点偏移、工作台高度、连杆包围盒、自碰撞检查对和静态障碍。可以在 `obstacles` 中添加 `{"name":"挡板","min_mm":[100,-50,0],"max_mm":[125,40,90]}`。修改 JSON 后重新构建并启动，让后端规划和前端显示同时加载新配置。
- 障碍位置和工具点需根据现场标定。碰撞检测使用近似几何，覆盖已配置的静态物体，RGB 相机负责预览。执行前请确认机械臂附近人员和物体的位置。
- 三维网格和模型来自 [Hiwonder NexArm](https://github.com/Hiwonder/NexArm/tree/0eb4fb8d806454fa1ff753f6a5ad305c63acceb4/src/simulations/nexarm_description)。上游的模型包未填写明确的许可证，项目在构建时从该提交下载原文件并校验 SHA-256，再生成浏览器可用的 URDF。模型文件保存在被 Git 忽略的 `public/model/`。

| 舵机 | 关节 | 常规模型角度 |
| --- | --- | --- |
| J1 | 底座旋转 | −119.7° 至 119.7° |
| J2 | 肩部俯仰 | −89.9° 至 57.2° |
| J3 | 肘部俯仰 | −179.9° 至 17.2° |
| J4 | 腕部俯仰 | −37.8° 至 89.9° |
| J5 | 腕部旋转 | −119.7° 至 119.7° |
| J6 | 夹爪开合 | 0.0° 至 28.6° |

控制页并排显示当前反馈与常规行程，运动遥测页提供六轴区间图。

## 工程结构

| 路径 | 职责 |
| --- | --- |
| `src/` | Vite、Three.js 前端，含控制台、数字孪生、相机视图、曲线和共享工位参数 |
| `nexarm/server.py` | 串口通信、运动执行、控制会话、HTTP 接口 |
| `nexarm/kinematics.py` | 正逆运动学、关节约束、路径和碰撞检查 |
| `nexarm/lan_control.py` | 局域网操作入口，校验指定来源并转发操作 |
| `nexarm/camera_feed.py`、`camera/` | 宿主端相机帧读取和 macOS RGB 采集助手 |
| `scripts/fetch-model.py` | 下载、校验并转换官方模型 |
| `start.sh` | 初始化依赖、构建并启动 |

## 分步构建与诊断

只构建网页和模型时，执行 `npm ci` 和 `npm run build`，产物在 `dist/`。从源码手动启动主服务：

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
npm ci
npm run build
camera/build.sh  # macOS，需要相机时运行
.venv/bin/python -m nexarm.server
```

运行 `.venv/bin/python -m unittest discover -s tests -v` 可复测截图中的目标和舵机滞后保护，无需连接硬件。

- **USB 未连接**。确认串口设备名，关闭占用该串口的厂商软件，再检查服务是否收到六轴反馈。
- **相机无画面**。确认腕部相机已接入、编译了采集助手、macOS 已授予相机权限，并用 `--camera-device` 指定设备名称。
- **远端显示「仅查看」**。查看使用 `8765`。确认控制网关已启动，从授权电脑使用 `8766` 并点击「启用控制」。
