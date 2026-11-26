# 部署指南（人读版）

## 三步

```bash
git clone https://github.com/CubicZnS/dsh-plugin-crew.git
cd dsh-plugin-crew
./install.sh          # 装插件 + 补 Agent Teams + 写配置
```

然后重启 DSH（菜单 → Restart Harness），在对话里说「crew_status」。

安装器默认工作区是 `~/crew-work`，想换：

```bash
./install.sh --workspace ~/some/where
```

## 它在背后做了什么

1. 找到 DSH App 与 `dsh` CLI（不依赖 PATH）
2. 找到你所有的 profile（`web` / `desktop`），逐个处理
3. 缺 Agent Teams 就 `dsh plugin add @deepseek-ai/dsh-experimental-agent-team-profile`
4. `dsh plugin add <本仓库>`
5. 用 `dsh --profile <p> --dump-config` 验证组合没问题，失败就报 `E_VERIFY_FAILED`
6. 写 `~/.dsh/crew/config.json`（`enabled: true` + 工作区）与 `deploy.json`

## 参数

| 参数 | 作用 |
| --- | --- |
| `--json` | 结构化输出，给 agent 用 |
| `--dry-run` | 只探测不改动 |
| `--restart` | 装完自动重启 DSH（**DSH 内的 agent 不要用**） |
| `--workspace <path>` | 指定班组的工作区 |
| `--profile <name>` | 只装某一个 profile |
| `--force` | 保留已有配置的前提下仍重写 deploy.json |

## 排障

| 现象 | 原因 | 修法 |
| --- | --- | --- |
| `crew_status` 里 Team 不可用 | Agent Teams bundle 没挂 / 没重启 | `node bin/crew-doctor.mjs` 看哪项红 |
| 提示"没有 live Team lead" | 打开的不是工作区里的会话 | 在 `~/crew-work` 里开一个新会话 |
| 装完什么都没变 | 没重启宿主 | 重启 |
| 想撤销 | — | `dsh plugin remove dsh-plugin-crew`，profile 的 `.bak-crew-*` 可还原 |

## 两台机器

每台各装一次，各用各的 `~/.dsh/crew`。**不要共享同一个账本**：Agent Teams 是单进程的，跨进程一致性的保证不存在。
