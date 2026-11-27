# AGENTS.md — 部署本项目的操作手册

> 你是被叫来"把这个项目部署下来"的 agent。**照做，不要即兴发挥。**

## 目标

让 `dsh-plugin-crew` 在这台 Mac 的 DSH 上可用：插件注册好、Agent Teams 挂上、配置写好。
剩下唯一的动作是重启宿主。

## 一条命令

```bash
cd <repo> && ./install.sh --json
```

幂等，跑几遍都安全。**只解析它的 JSON 输出，不要解析中文提示。**

## 判断结果

| `code` | 含义 | 你要做的 |
| --- | --- | --- |
| `OK` | 装好了 | 进入"重启"一节 |
| `OK_DRY_RUN` | 只探测没改动 | 去掉 `--json` 外的 `--dry-run` 重跑 |
| `E_NO_DSH` | 这台机器没有 DSH | **停止**，告诉用户先装 DSH，别自己去找别的办法 |
| `E_NO_PROFILES` | 没有 profile | 让用户先启动一次 DSH，再重跑 |
| `E_INSTALL_FAILED` | 依赖装不上 | 把 `message` 原文交给用户；**不要手改 profile 文件** |
| `E_VERIFY_FAILED` | 组合失败 | 同上；提示可以用 `.bak-crew-*` 备份回滚 |
| `E_RISK_REQUIRED` | 已废弃：0.4.0 起不再安装实验性 Agent Teams bundle，正常不会出现 | 如果出现，说明用的是旧版本，升级 |

## 重启（先判断你在哪）

**先看你自己的运行环境：**

- **你不在 DSH 里**（你在终端里的 claude / codex / dsh CLI）→ 加 `--restart` 再跑一次，或者手动：
  ```bash
  osascript -e 'tell application "DeepSeek Harness" to quit'; sleep 2; open -a "DeepSeek Harness"
  ```
- **你在 DSH 里**（你能看到 crew_* 工具、或者你的对话就发生在这个 App 内）→ **绝对不要重启**，
  那会杀掉你自己。直接告诉用户：

  > 装好了，请重启一次 DSH（菜单 → Restart Harness），然后说「crew_status」。

## 验证

**注意：班组默认关闭。** 重启后先让用户打开「班组」面板点「启用班组」，再验证。

启用后在 DSH 里调用 `crew_status`，确认这三行：

- `部署：已部署 <版本>` —— 部署记录读到了
- `Team：就绪，N 名成员` —— Agent Teams 真的挂上了
- `家：<路径>` —— 班组认对了会话

任何一条不对，跑 `node bin/crew-doctor.mjs`，把输出给用户。

## 不要做的事

- 不要改 `~/.dsh/profiles/*/package.json`（ installer 会做，而且有备份）
- 不要为了让检查通过而 `--force` 覆盖别人的配置
- 不要在两台机器上共享同一个 `~/.dsh/crew`（Agent Teams 是单进程的）
