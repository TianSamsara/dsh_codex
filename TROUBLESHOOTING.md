# 工具与联网故障排查

适用于插件 0.3.3、桥接 1.1.4。先在“Codex 桥接”面板检查桥接版本与联网状态；通过“检查仓库更新 → 更新插件和桥接”安装，完成后在当前任务结束时重启 Harness 载入新版面板。

## `Tool results do not match pending calls` / `PI_AI_ERROR`

**触发：** 刚完成文件写入或读图，下一步模型调用失败；后台任务完成后也可能出现。

**原因：** Harness 会在工具结果后追加后台通知、用户补充或图片消息。特别是 pi-ai 的 OpenAI completions 适配层，会把工具图片拆为“文本工具结果 + 附图片的用户消息”。旧桥接要求续接请求中只能有工具结果，拒绝了这些正常消息。`PI_AI_ERROR` 是上层对底层错误的包装，不表示文件写入已回滚。

**修复：** 先独立核对工具结果数量、唯一调用 ID 与会话归属，再通过原生 `turn/steer` 加入补充消息，最后按原 RPC ID 回传工具结果。继续原线程和轮次；不自动重复执行已经完成的写文件或命令。非法、重复、缺失或其他会话的结果仍被拒绝。

升级后在原会话继续，并让模型先检查已有文件和任务结果。旧错误消息会保留。客户端提示“仅可从已完成轮次的最后一条消息分支”时，应在原会话继续，或选择之前已完成的轮次分支；这条客户端限制没有被插件修改。

## `DeepSeek search has no API key for DEEPSEEK_API_KEY`

**原因：** Harness 的 DeepSeek 搜索服务与 Codex 的 ChatGPT 登录使用不同凭据。连接 Codex 模型不会自动配置 DeepSeek 搜索服务。

**修复：** 桥接默认启用 Codex 托管实时联网搜索，模型优先通过现有 Codex 登录研究公开网页并提供普通 Markdown 来源链接，无需另行填写 DeepSeek 搜索密钥。文件与命令仍由 Harness 执行。原来的 Harness 搜索服务没有被改写；如果明确调用该服务，仍需要它自己的凭据。

在运行桥接目录的 `settings.json` 中可选择：

```json
{
  "webSearch": "live"
}
```

上面是一个配置字段示例，请合并进现有对象，保留 `port`、`node`、`codex` 等原字段。`live` 为默认实时模式，`cached` 使用缓存检索，`disabled` 关闭；修改后重启桥接。更新时保留明确设置的模式。调用方指定 `tool_choice: "none"` 时，本次请求也会关闭原生搜索。

## GitHub 被判定为非公网地址

**示例：** `URL hostname "github.com" resolves to a non-public IP address`。

**原因：** 本机代理的 Fake-IP DNS 可能把公开域名解析到 `198.18.x.x` 或类似虚拟地址，触发 Harness 网页抓取工具的非公网地址检查。这与文件权限、模型登录和工具结果续接是不同问题。

**处理：** 使用桥接提供的 Codex 托管联网检索公开 GitHub 资料。插件不关闭 Harness 的地址检查，不修改系统 DNS、代理或网络防护。直接使用 Harness 的抓取工具时，仍受其网络与地址校验约束；提高本地文件权限不会解决 DNS 问题。

## GitHub API `403 rate limit exceeded`

这是 GitHub API 限流，不能等同于所有 GitHub 页面都无法访问。插件的仓库更新检查会回退到 Git 读取确定提交；需要本机可执行 Git。网页研究可继续尝试可用的公开仓库页面，不能把未访问成功的源码说成已经核验。

## 验证范围

- 56 项自动测试：工具结果混合图片／通知、并行乱序、拒绝非法结果、原生搜索模式、禁用工具、安装与更新、密钥及配置保留、Windows 服务切换与失败回滚。
- 真实 Codex 及本机 HTTP：工具读写测试文件后续接图片和后台通知，确认原线程继续、未重复调用工具；使用现有登录联网核验公开 GitHub 仓库，返回可点击来源。
- 搜索可用性仍取决于账号能力、联网服务与来源网站；原生搜索与文件命令是两类能力。

协议与配置依据：[Codex App Server](https://learn.chatgpt.com/docs/app-server)、[Codex 联网搜索](https://learn.chatgpt.com/docs/web-search)。
