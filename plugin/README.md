# Codex 本地桥接：DeepSeek Harness 插件

版本 **0.3.1**，2026-10-21。适配 Windows 的 DeepSeek Harness **0.2.1-rc.2**。面板可自动创建并启动桥接，检查 GitHub 仓库并更新插件。

在侧边栏增加 **Codex 桥接**，在 **插件 → 已安装插件 → Codex 本地桥接** 中提供相同的配置面板。按钮包括自动发现、连接并记住、启动并连接和忘记此连接；支持模型、思考强度、启动时自动连接、桥接离线时自动启动，以及设为新会话默认模型。

## 安装

在这个文件夹打开 PowerShell，运行：

```powershell
./install.ps1
```

安装器使用已安装 Harness 自带的插件管理命令，安装本目录的本地链接；保留此文件夹。自定义安装位置可传 `-HarnessPath '完整路径\DeepSeek Harness.exe'`。安装前将桌面 profile 的配置文件备份到本机插件存储目录，保留其他服务商和插件。通常支持动态加载；入口未出现时重启 Harness。

也可在 Harness 的“添加插件”中填写这个插件文件夹的完整路径，并启用该插件包。

## 连接

首次使用直接点击 **自动初始化并连接**：没有目录时自动创建桥接和随机密钥、检测 Codex、启动并获取模型；有已记住的桥接时直接复用。无需另装 Node.js；可用 Harness 的内置 Electron/Node 运行服务。请先在 Codex 完成 ChatGPT 登录。

自动目录为 `$DSH_HOME/storages/codex-local-bridge/runtime`，位于可写的用户存储，独立于 Git 插件缓存。已有密钥、配置和未知文件不会被覆盖。端口从 17654 起选择空闲端口。当前自动初始化支持 Windows。

手动连接可展开 **高级设置**：

1. 打开侧边栏“Codex 桥接”，点击“自动发现”。
2. 选中桥接目录，或手动填写包含 `server.mjs`、`settings.json`、`Start-Bridge.ps1` 和 `state/local-key` 的目录。
3. 点击“连接并记住”。离线时可点击“启动并连接”。首次会自动读取本机密钥和模型列表，不需要复制密钥。
4. 选择模型和思考强度，再次点击“连接并记住”。已有会话在输入框模型菜单中手动切换，新会话按默认模型设置使用。

Git 安装包包含用于初始化的桥接源码，也可管理**已有的 Harness Codex 桥接**。要求 `/health` 返回 `service: dsh-codex-bridge`，并支持 `/v1/models` 和 Harness 所需的对话、流式输出与工具调用接口。学习通的 `17653` 桥接不能替代 Harness 桥接。

## 发现与记忆

面板下方有 **检查仓库更新 / 更新插件**：比较固定仓库 main 分支的版本和提交，安装检查到的确定提交，保留运行中的桥接和配置。更新完成后任务结束时重启 Harness。GitHub API 限流时使用 Git 回退；同版本的新提交也可更新。需本机 Git；开发用的本地链接不会被覆盖。更新器和日志位于用户存储，不随插件包替换而中断。

- 优先记住的目录及 `DSH_CODEX_BRIDGE_ROOT` 指定的目录；再查找用户 `Documents/Codex/日期/任务/outputs/codex-harness-bridge`。最多查最近 20 个日期、160 个任务目录，不扫描全盘或局域网。
- 连接地址仅接受 `http://127.0.0.1:端口/v1`；请求不跟随重定向，不将本地密钥发给远程地址。
- 记忆保存在 `$DSH_HOME/storages/codex-local-bridge/connection.json`（默认 `~/.dsh`），只保存路径、脚本指纹、模型和连接选项，不保存密钥正文。每次连接从桥接目录读取当前密钥，浏览器面板不显示或接收密钥。
- Harness 客户端启动后自动连接，每 30 秒检查一次，失败重试至少间隔 60 秒（窗口在后台时检查可能受浏览器节流延后）；仅对已记住且脚本指纹未变化的目录自动启动。脚本更新后点击一次“连接并记住”确认新版本。重连通过正常 Remote 调用配置模型，避免在插件热加载事务中嵌套写配置。
- 本地连接密钥按现有 Harness 提供方的 `headers.Authorization` 方式配置到 `codex-local` 路由；不是 Codex OAuth 凭据。Codex 的账户登录和订阅验证仍由桥接负责。
- 模型和思考档位来自真实桥接目录；仅提供当前 Harness 支持的档位。保留原模型容量等设置，不覆盖其他提供方，不发送聊天消息或恢复旧任务。
- “忘记此连接”关闭记忆和自动重连，但保留 Harness 已配置的模型；停用/卸载插件不会结束独立运行的桥接。

## 验证与卸载

```powershell
node --test test/*.test.mjs
./install.ps1 -Uninstall
```

测试覆盖发现边界、记忆恢复、离线启动、脚本变更保护、模型/档位校验、错误与密钥隐藏，以及客户端入口与动作绑定。自动连接仅获取模型目录，不运行模型推理或消耗测试题额度。

本机验证：38 项自动测试通过；真实仓库检查已验证 API 限流回退；真实空目录初始化使用 Harness 内置 Electron 运行时启动服务、读取 7 个模型，重复执行保留目录和密钥；真实 HTTP 已验证进程与工具会话续接。

实现使用 Harness 的 Cordis Service、公开 Remote 装饰器、客户端 Remote 挂载和 UI Slots，不修改安装目录或 `app.asar`。参考：[官方插件入门](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/index.md)、[客户端模块](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/client-modules.md)、[插件配置面板](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-plugin-manager/README.md)。
