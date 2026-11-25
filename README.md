# 状态板

用本地 HTML 状态板汇总进展、排队事项和待负责人决定的问题。

截图占位（待补）。

## Claude Code

```sh
npx skills add Qin-C/status-board -g -a claude-code -s status-board -y
```

## Codex

```sh
npx skills add Qin-C/status-board -g -a codex -s status-board -y
```

## 首次使用

1. 按 [SKILL.md](SKILL.md) 把脚本和配套目录拷到 `~/.claude/scripts/`。
2. 启动本地 HTTP 伺服，用 `http://127.0.0.1:8777` 打开板。
3. 在项目仓运行 `python3 ~/.claude/scripts/board.py new "<项目>-<线名>"`。
4. 填好新板占位内容，每次改完运行 `board.py touch <板路径>`。没有 GitHub 卡时把板顶设为 `workline:none`。
5. 运行 `python3 ~/.claude/scripts/board.py selftest` 验证安装。

## 配置

配置文件是 `~/.status-board/board-config.json`，也可用 `BOARD_CONFIG` 指定 JSON 文件。

- `owner_names` 是判据识别的负责人称呼，默认 `["负责人"]`。
- `other_names` 是可选的姓名列表，默认为空。
- `default_repo` 是渲染卡链接时可用的 `owner/repo` 缺省值，默认为空。排队查询仍以当前板的仓为准。
