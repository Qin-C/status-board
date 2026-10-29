# status-board

> 同时让好几条 AI 工作线替你干活时，打开一个网址就能答出两件事：我派的活怎么样了？现在还要我做什么？
>
> A local HTML status board and decision pages for people who run many AI coding sessions in parallel. Docs are in Chinese.

## 这是什么

- **状态板**：每条 AI 工作线维护一块本地网页，只有三块：
  - **大方向**：一句话；
  - **你交代的**：你派的每件事一行，写着进展和预计哪天好；
  - **要你的**：要你拍板或动手的，一件一张卡，带建议。
  你不用翻聊天记录，看板就够。
- **方案页**:AI 需要你拍板时，先写一份 Markdown 草稿，`plan.py` 检查过再出成一页网页。检查的是：字数是否超限、有没有图、每道题有没有建议。你在页上点选项、写补充，答案回到 AI 那边。
- **规则**:AI 怎么维护板，见 [docs/rules.md](docs/rules.md)。
- **设计说明**：为什么这样设计，见 [docs/design.md](docs/design.md)。

## 现在开了哪些(第一步)

| 路径 | 内容 |
|---|---|
| `plan/plan.py` + `plan/plan-kit/` | 方案页生成器，只用 Python 标准库 |
| `docs/rules.md` | AI 维护状态板的规则全文 |
| `docs/design.md` | 设计说明 |

第二步会开 `board.py` 和本地服务。`board.py` 负责建板、写行、挂卡、收卡和检查。这部分还在清理内部内容。

## 试一下

```bash
python3 plan/plan.py selftest
python3 plan/plan.py render plan/plan-kit/examples/board-proposal-redesign.md -o demo.html
```

直接用浏览器打开 `demo.html` 就能看，也能点选项。右下角「生成回复」会把你的选择整理成一段文字，复制后粘回给 AI。要把答案自动存回给 AI,需要本地服务(第二步开源)。

草稿格式和全部检查项见 [plan/plan-kit/README.md](plan/plan-kit/README.md)。

## 许可证

MIT
