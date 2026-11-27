# 部署指南（人读版）

## 三步

```bash
git clone https://github.com/CubicZnS/dsh-plugin-crew.git
cd dsh-plugin-crew
./install.sh          # 装插件 + 写配置
```

然后重启 DSH（菜单 → Restart Harness），在对话里说「crew_status」。

## 它在背后做了什么

1. 找到 DSH App 与 `dsh` CLI（不依赖 PATH）
2. 找到你所有的 profile（`web` / `desktop`），逐个处理
3. `dsh plugin add <本仓库>`，然后**读文件**校验 bundle 是否真的登记了
   （`dsh` CLI 每次运行都会重写 `dsh.profile.bundles`，会把刚加的条目丢掉）
4. 写 `~/.dsh/crew/config.json`（`enabled: true`）与 `deploy.json`

**不安装任何 experimental 包**，因此不需要版本豁免。

## 参数

| 参数 | 作用 |
| --- | --- |
| `--json` | 结构化输出，给 agent 用 |
| `--dry-run` | 只探测不改动 |
| `--restart` | 装完自动重启 DSH（**DSH 内的 agent 不要用**） |
| `--profile <name>` | 只装某一个 profile |

## 排障

| 现象 | 原因 | 修法 |
| --- | --- | --- |
| `crew_status` 不存在 | 没重启宿主 / 装错了 profile | `node bin/crew-doctor.mjs` 看哪项红 |
| 说“没可领的活” | 任务被依赖挡住，或不在谷时窗口 | `crew_tasks` 看状态；急活加 `priority: 100` |
| 任务卡在 `review` | 没人领评审作业 | 让 Lead 再 `crew_pull` 一次 |
| 想撤销 | — | `dsh plugin remove dsh-plugin-crew`，profile 的 `.bak-crew-*` 可还原 |

## 两台机器

每台各装一次，各用各的 `~/.dsh/crew`。**不要共享同一个账本**——单进程、单账本。
