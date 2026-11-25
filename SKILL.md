---
name: status-board
description: 给某个人（老板 / 客户 / 需要你定期汇报的人）维护一块本地 HTML 状态板——他打开一个 URL 就能看到「我派的活怎么样了 / 除此之外还要我做什么」，不必翻聊天记录。当用户说「状态板」「给他看进展」「他又问了一遍我上次说过的事」「汇报太长他不看」，或要建 / 改 / 检查这样一块板时使用。含 board.py（建板 · 刷新 · 契约检查 · 排队区现拉 GitHub 卡）、判据正本、本地 http 伺服与两个可选 hook。
---

# 状态板 — 给他看的东西，先落板再发消息

## 为什么存在（一句话）

**聊天窗的长度随时间增长，板的长度随「未决事项数」增长**（后者有上限）。
新消息可以淹没旧消息，**但不能淹没未处理事项**。

⚠ 判据正本在 `rules/status-board.md`，**那份是规矩，这份只讲怎么装怎么用**。
冲突时以 `rules/status-board.md` 为准。
⚠ 规矩正本和脚本的报错里常出现「负责人」和带日期的原话 —— 那是这套东西最初服务的那个人、和每条规矩是怎么来的。
**你照着用时，把「负责人」读成「你要汇报的那个人」**；原话留着是为了让每条规矩有出处，不用改。

---

## 安装后必做（七步，第 1–4 步是硬要求）

装完这个 skill 之后，目录在：

| 你用的是 | 装法 | skill 目录（下面用 `$SK` 指代它） |
|---|---|---|
| Claude Code | `npx skills add Qin-C/status-board -g -a claude-code -s status-board -y` | `~/.claude/skills/status-board/` |
| Codex（含 Windows 桌面版） | `npx skills add Qin-C/status-board -g -a codex -s status-board -y` | `~/.agents/skills/status-board/`（skills CLI 1.7.4 实读：`-a codex -g` 装到这里，Codex 从这里读） |

```bash
SK=~/.claude/skills/status-board          # Codex:SK=~/.agents/skills/status-board
```

⚠ 不管用哪个，**脚本都放 `~/.claude/scripts/`**（Windows 上就是 `%USERPROFILE%\.claude\scripts`），伺服也一样 —— 下面每一步对两者相同，只有第 5 步（hook）Codex 没有，见文末「Codex 用户」。

⚠ **支持的系统**：macOS（最近一次验收 2026-10-01：在一个全新的 HOME 里照下面七步走通，自检全绿）。Linux 没验过。
**Windows：按下面各步里的「Windows」那段装；还没在真 Windows 上验过，装完跑第 7 步自检，把结果发回给负责人。**
Windows 上命令在 **Git Bash** 里跑（Claude Code 桌面版的 shell 就是它；Codex 用户自己开一个 Git Bash 装）。
⚠ Windows 上多半**没有 `python3` 这个命令**，只有 `python`（或 `py -3`）—— 本文和脚本报错里所有 `python3` 都换成它；
先跑 `python --version` 看一眼（本机在 3.14 上验过，更老的没验）。

### 1. 把脚本放到位

```bash
mkdir -p ~/.claude/scripts
cp -R "$SK"/scripts/* ~/.claude/scripts/
```

⚠ `board-kit/` 必须跟着一起过去（板的外壳、样式、前端脚本都在里面）。

### 2. 起本地 http 伺服 —— ⛔ 这一步不能省

板**必须**经 `http://` 打开。
理由：Claude Desktop 的 in-app browser 把 `file://` 渲成 `data:` 静态快照——
**点不动、JS 不跑**，自动刷新 / 已看过 / 自算年龄全部失效，而它看起来完全正常。

macOS：

```bash
mkdir -p ~/.claude/boards-web ~/Library/LaunchAgents
sed "s|__HOME__|$HOME|g; s|/opt/homebrew/bin/python3|$(command -v python3)|" \
  "$SK"/templates/com.status-board.boards-web.plist > ~/Library/LaunchAgents/com.status-board.boards-web.plist
launchctl load ~/Library/LaunchAgents/com.status-board.boards-web.plist
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8777/   # 连得上就行：还没有板时回 404，建完第一块板后是 200
```

⚠ 模板里的 python 路径是 `/opt/homebrew/bin/python3`；上面那条 `sed` 已经把它换成你机器上 `command -v python3` 的结果。
⚠ `mkdir` 那一行别省：伺服的日志写在 `~/.claude/boards-web/` 里，全新的机器上这个目录还不存在。

Windows（Git Bash 里整段粘贴；用「登录时运行」的计划任务起，`pythonw` 无窗口，日志同样写 `~/.claude/boards-web/.server.log`）：

```bash
mkdir -p ~/.claude/boards-web
cp "$SK"/templates/boards-web-windows.pyw ~/.claude/scripts/
PYW="$(command -v pythonw || command -v pyw)"; echo "pythonw = $PYW"   # 空的 ⇒ Python 没装进 PATH,先装好再来
MSYS_NO_PATHCONV=1 schtasks /create /tn StatusBoardWeb /sc onlogon /rl limited /f \
  /tr "\"$(cygpath -w "$PYW")\" -X utf8 \"$(cygpath -w ~/.claude/scripts/boards-web-windows.pyw)\""
MSYS_NO_PATHCONV=1 schtasks /run /tn StatusBoardWeb
sleep 3; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8777/   # 404 或 200 = 起来了；000 = 没起来 ⇒ 看下一行
tail -20 ~/.claude/boards-web/.server.log
```

⚠ `MSYS_NO_PATHCONV=1` 别省：不加的话 Git Bash 会把 `/create`、`/tn` 当成路径改写掉，`schtasks` 报「无效参数」。
⚠ 重启伺服：`MSYS_NO_PATHCONV=1 schtasks /end /tn StatusBoardWeb && MSYS_NO_PATHCONV=1 schtasks /run /tn StatusBoardWeb`；
卸掉：`MSYS_NO_PATHCONV=1 schtasks /delete /tn StatusBoardWeb /f`。
⚠ 第一次起时 Windows 防火墙可能弹窗问「是否允许 Python」—— 伺服只绑 `127.0.0.1`，选「取消」或只勾「专用网络」都不影响本机打开。

Linux（systemd user unit）或端口被占，见下面「配置」。

### 3. 建第一块板

```bash
cd <那个人关心的那个仓>
python3 ~/.claude/scripts/board.py new "<项目>-<线名>"
```

它会打印落点和 URL。**⛔ 之后改板不要再 `open`** —— 板自带自动刷新，
重开只会在他浏览器里堆重复标签页。

⚠ **新板第一次 `touch` 是红的，这是预期**：新板是一副骨架，里面的「（填：…）」、`MM-DD`、板顶那一行都要换成真内容，
报错会逐条说该填什么。这条线不用 GitHub 卡 ⇒ 板顶那行写 `workline:none`。
⚠ **项目不在 `~/work` 底下**（比如放在 `~/Documents`）⇒ `new` 和 `touch` 会直接报「8777 上打不开」，并给出要写进
`~/.status-board/board-config.json` 的那一行 —— 照抄，再 `touch` 一次就好。

### 4. 每次改完板，跑一次 touch

```bash
python3 ~/.claude/scripts/board.py touch <板路径>
```

`touch` 会顺手跑契约检查（`lint`），**不用为 lint 单开一轮**。
⛔ 别自己拼板路径（会拼出第二份板，而他打开的永远是第一份）：
用 `board.py path <线名>` 拿。

### 5.（可选）装两个 hook

```bash
cp "$SK"/hooks/*.js ~/.claude/hooks/
```

- `board-pane-check.js` — 板不在他面板里时提醒你重新打开
- `board-freshness-check.js` — 板太久没更新时提醒

⚠ 装不装都不影响 `board.py` 本身。要生效还得在 `settings.json` 里挂上，
格式见你的 harness 文档。
⚠ 这两个是 Claude Code 的 hook（`node` 跑）；**Codex 没有 hook，跳过这一步**，改按文末「Codex 用户」那段做。

### 6.（可选）排队区现拉 GitHub 卡

板顶 `<div class="eyebrow">` 里写 `workline:<ascii-slug>`，
然后给这条线的卡打上同名 label，跑：

```bash
python3 ~/.claude/scripts/board.py queue <板路径>
```

**这条线不用 GitHub 卡就写 `workline:none`** —— 那样这道检查会明说「按你的声明跳过了」，
而不是假装查过。

### 7. 自检

```bash
python3 ~/.claude/scripts/board.py selftest
```

全绿才算装好。⚠ 它检查的是**脚本自己的行为**，不是你的板。

---

## 升级

版本号在同目录的 `VERSION`(「时间 内容指纹」,打包时机器算的)。
配置了 `skill_source`（`{"repo":"owner/repo","path":"skills/status-board"}`）时，每天第一次用板(`head` / `touch` / `row` / `ask` / `answer` 跑完之后)查一次团队仓,
有新版就自动装上、换脚本(和你装过的 hook)、跑自检;**自检不过就退回原来那版**并说一声;查不到(没网、凭据失效)只说一声,不挡用板。
关掉:环境变量 `BOARD_SKILL_UPDATE=0`。
⭐ 1023:自动升级用的 `npx skills add -a <agent>` 按 skill 装在哪自己判断 —— 在 `~/.agents/skills` / `~/.codex/skills` 下 ⇒ `codex`，
其余 ⇒ `claude-code`；判错了在 `board-config.json` 里写 `"skill_agent": "codex"` 钉死。Windows 上 `npx` 实际是 `npx.cmd`，脚本自己会找。

手动升级：

```bash
npx skills add Qin-C/status-board -g -a claude-code -s status-board -y   # 1. 刷新 skill 本身(Codex:-a codex)
cp -R "$SK"/scripts/* ~/.claude/scripts/               # 2. 刷新脚本 —— ⛔ 只做第 1 步等于没升
cp "$SK"/hooks/*.js ~/.claude/hooks/                   # 3. 装过 hook 才做
python3 ~/.claude/scripts/board.py sync --all          # 4. 已有的板换上新外壳
python3 ~/.claude/scripts/board.py selftest            # 全绿才算升好
```

⚠ GitHub 凭据失效时第 1 步**不报错也不更新**:跑完看 `VERSION` 变没变,没变先 `gh auth status -h github.com`。

---

## 日常动作

| 什么时候 | 跑什么 |
|---|---|
| 他提了一件事 | **立刻**写进板的「你交代的」区（在开始做之前，不是做完才写） |
| 要他拍板 / 动手 | `board.py ask <板> --q "一个他能直接回答的问题" --rec "我的建议"`（可加 `--why 前因后果`、`--deep <方案板网址> --deep-why "点进去能看到什么"`（要给他看方案板时用它，别把网址写进正文——印出来点不动）、`--opt A --opt B`、`--steps "第一步\|第二步"`、要他批一个改动时 `--how "怎么做\|他会看到什么变化"`；带 `--deep` 必须同时写 `--how`，否则拒写）—— 卡自己进「要你的」 |
| 他答了 | `board.py answer <板> --ack <卡的 data-ack> --res "他怎么答的" (--why "对应那一行现在到哪了" \| --done --row <那一行的编号>)` —— 拿掉那张卡，那一行不再等他；行的现状由你写，不再自动填成他的回答。⚠ `--done` = **那一整行的事做完了**，不是「这张卡处理完了」；只想收掉卡用 `--no-row` |
| 他说「先做完 X 再说 Y」 | 给 Y 留一行并写明排在 X 后面：`board.py row <板> --new --title "Y" --status todo --say "…" --after <X 的编号>`（已有那一行就 `row --ack Y --after X`）。X 一做完，Y 还原样挂着会报错：开工，或挂卡问他 |
| 他提了一件新的事 | `board.py row <板> --new --title "…" --say "…" --eta MM-DD` —— 不用手改 HTML |
| 某一行有进展 / 要标成等他 | `board.py row <板> --ack <行的 data-ack> --say "最新一句"`（可加 `--status doing\|todo\|blocked\|watch`、`--eta MM-DD`、`--you decide\|do --act "他要做的一句"`） |
| 一件小修做完了 | `board.py row <板> --ack <行> --review --small --got "现在的结果" --see "…"`,并进今天那张小修卡。什么算小修、什么不许标 `--small`,见 `rules/status-board.md`「R2.7」 |
| 一件做完了 | 交他验收:`board.py row <板> --ack <行> --review --q "哪件事 + 要他干什么" --got "现在的结果" --see "你在哪能看到什么变化"`(可加 `--todo` / `--url … --check …` / `--img`;几行一起 `--ack r1,r2`)。他已在别处点过通过 ⇒ `--covered-by <卡号\|行号> --sum "一句人话"`。卡面怎么写、哪些写法拒写,见 `rules/status-board.md`「R2.7」;`--status done` 一律拒写 |
| 一件不打算做了 | `board.py row <板> --ack <行>[,r2] --drop "为什么不做"`:挂卡让他点,卡标题机器写成「X 不做了,同意吗?」(⛔ 别自己把行标掉) |
| 机器拉进来的重复行 | `board.py row <板> --ack <ntc- 开头的行> --dup-of <同一件的行>`(他交代的 r 开头行用 `--drop`) |
| 在等外部 / 等日子、往后排 | `board.py row <板> --ack <行> --wait-for "等谁 / 等什么"`,等的就是日子写 `--wait-for "日子:<为什么是这天>" --eta MM-DD`;被叫醒追过了 `--chase "追了谁、怎么问的"`(满 7 个工作日还要 `--escalate "换了什么路"`)。判据见 `rules/status-board.md`「R2.7」,参数和计时见 `board.py help row` |
| 要他动手的步骤 | `board.py ask <板> --do --steps "起始界面:…\|怎么做:…\|等多久:…\|结果怎么给我:…"`(四段写法见 `rules/status-board.md`「「要你的」卡怎么写」) |
| lint / touch / row 印的提醒、拒写 | 照报错里给的改法当轮改;规矩全文 `rules/status-board.md` |
| 线结束 / 合并、清机器攒的东西 | `board.py retire <板> --to "<去向>" --dry-run` 预演再真跑;收尾钩子的 state.json 用 `board.py gc --state --dry-run` → `gc --state`;细节 `board.py help retire` |
| 一件事在等外部群里的人回话 | `board.py row <板> --ack <行> --chat oc_…`（群的 chat_id；不知道就 `lark-cli im +chat-search --as user --query "群名"`）—— 之后群里别人再说话，板上那一行亮红、lint 报错，直到你 `row` 重判。拉群的是 `board.py chat-watch --all`：Mac 上装 `templates/com.status-board.board-chat-watch.plist`（`sed "s|__HOME__|$HOME|g"` 后放进 `~/Library/LaunchAgents/` 再 `launchctl bootstrap gui/$(id -u) <plist>`，每 10 分钟一次）；Windows 先手跑。要本机 lark-cli 已登录 |
| 手改了板 | `board.py touch <板>`（顺手 lint；上面三条命令自己会 touch，不用再跑） |
| 要写一份方案给他拍 | 写一份短 Markdown 草稿 → `python3 scripts/plan.py render 草稿.md -o 方案.html`（不合格不出页面：结论在最前、标题是结论句、一节没图不超过 300 字、要他定的题用 ```decision 就地可点）→ 有 ```decision / ```batch 题的先 `plan.py coldread` 冷读(不过不出页)→ `board.py publish 方案.html` 拿网址（同名页是别人的会拒发：换个不重名的文件名，确认要盖才加 `--replace`） → `board.py ask … --deep <网址> --deep-why "…" --how "改前 → 改后的例子"` 挂到板上。格式速查 `scripts/plan-kit/README.md`；只改一节用 `plan.py patch`。他在页面上点的回答，`board.py answers <板>` 读得到 |
| 要给他看 | 把 `http://127.0.0.1:8777/<板文件名>.html` 发给他，⛔ 别发文件路径 |

`board.py help` 列出全部主题；动手时脚本自己会把该知道的打出来。

---

## 配置（别人机器上大概率要改）

环境变量 `BOARD_CONFIG` 指定，否则读 `~/.status-board/board-config.json`。
全部字段可省，省了就用缺省：

```json
{
  "board_roots": ["~/work", "~/.claude"],
  "web_root": "~/.claude/boards-web",
  "state_dir": "~/.status-board",
  "port": 8777,
  "eyebrow_prefixes": ["workline", "track"],
  "team_identity": "~/projects/your-repo/scripts/team_identity.json"
}
```

- **`port`** — 8777 被占就改这里，`plist` 里不用动（脚本自己读配置）
- **`board_roots`** — 找板的根，按序扫。项目不在这些根底下，板就进不了伺服目录（`new` / `touch` 会报「8777 上打不开」，并给出要加的那一行）
- **`eyebrow_prefixes`** — 板顶那个前缀认哪些；**第一个是缺省**
- **`team_identity`** — GitHub login → 人名；没有这个文件就降级印 login，不报错
- **`skill_agent`**（可选）— 自动升级时 `npx skills add -a` 用哪个 agent；不写就按 skill 目录在哪判断（见「升级」）

Windows 上这个文件在 `%USERPROFILE%\.status-board\board-config.json`（Git Bash 里就是 `~/.status-board/board-config.json`）。
⚠ 项目放在 `~/work` 以外（Windows 上常见 `~/Documents`、`D:\code`）⇒ 把那个根加进 `board_roots`，路径用正斜杠写，如 `"D:/code"`。

---

## ⛔ 五个会咬人的坑（都是实际栽过的）

1. **⛔ 给他看 HTML 只能给 `http://` 的 URL。** `file://` 在 in-app browser 里是死的，
   而它看起来完全正常 —— 三种载体摆在一起就像「板坏了」，其实是路径形式坏了。
2. **⛔ 改板别用会重写整个文件的工具**（编辑器的保存、`sed -i`、`perl -pi`）。
   板是硬链接同时存在于仓里和伺服目录里，这些做法**会换掉 inode** ⇒
   伺服出去的还是旧版，而你的每一步都回报成功。原地写（`r+b` + `truncate()`）。
3. **⛔ 别自己拼板路径。** 每个 git worktree 都能解析出一个不同的 `<repo>`，
   照 cwd 拼会长出很多份同名板，而他打开的永远是主仓那一份。
4. **⚠ 空输出先查退出码。** 「它没出声」和「它没运行」在输出上一模一样。
   本套脚本里任何「读不到就跳过」的分支都会把「跳过」说出来 —— 你自己写检查时也该这样。
5. **⚠ 板腐烂比聊天更糟。** 聊天至少是只增不改的事实；板没跟上会**看起来最新、实际是旧的**，
   而他据此拍板。所以规矩是「先落板，再从板里摘一句发给他」，不是反过来。

---

## Codex 用户（没有 hook，靠 AGENTS.md 一句话补）

Claude Code 那边有几样是 **hook 自动做的**；Codex 没有 hook，这几样**不会发生**：

| Claude Code 下自动发生的 | Codex 下 |
|---|---|
| 他在板上点的回答，下一轮自动贴进对话 | ❌ 没有 ⇒ 用下面那句 AGENTS.md 补 |
| 在聊天里问他问题而没上板 ⇒ 提醒你挂到板上（提问框兜底） | ❌ 没有 ⇒ 只能靠 AGENTS.md 里的规矩 |
| 板太久没更新就拦住收工（`board-freshness-check.js`） | ❌ 没有 |
| 板不在右侧面板时提醒重开（`board-pane-check.js`） | ❌ 没有面板 |
| 接班「棒次」闸、`head --baton` 认本会话、右栏 ▶ 打开板（读 Claude 桌面版的会话注册表） | ⏭ 自动跳过，并印一句「不查」—— 不报错、不挡用板 |

**在那个人的仓的 `AGENTS.md` 里加一句**（`<板>` 换成 `board.py path <线名>` 给的那个路径）：

```markdown
- 状态板：每轮开始先跑 `python ~/.claude/scripts/board.py answers <板>`，把他在板上的回答照办；照办完用 `board.py answer` 收卡，方案页的题跑 `board.py answers <板> --mark`。要问他的事一律 `board.py ask` 挂到板上，别只在聊天里问。改完板跑 `board.py touch <板>`。
```

⚠ Codex 在 Windows 上默认的 shell 可能是 PowerShell，不是 Git Bash：PowerShell 里把 `~/.claude/...` 写成 `$HOME\.claude\...`。
看板：用任意浏览器开 `http://127.0.0.1:8777/<板文件名>.html`（⛔ 别开文件路径）。

---

## 维护者注（本机）

`~/.claude/skills/status-board/` 里的脚本是**副本**，正本在 `~/.claude/scripts/`。
改完正本跑：

```bash
python3 ~/.claude/scripts/board.py skill-pack          # 刷新副本
python3 ~/.claude/scripts/board.py skill-pack --check  # 只查漂移
```

⚠ `board.py selftest` 里有一条闸盯着这件事：**副本落后正本就红**。
⭐ 本机 `~/.status-board/board-config.json` 设了 `"skill_publish": true` ⇒ `skill-pack` 发现团队仓和本机不一样,自检全绿就自动推上去(触发式,负责人 10-20);
改了本说明也要跑一次 `skill-pack`,版本号和团队仓才会跟上。推失败(没网)只说一声,下次 `skill-pack` 补推。
⛔ 别把它改成提醒 —— 副本一建就开始腐烂，这是本套工具反复栽过的那一族。
