---
name: to-questionnaire-web
description: 将 questionnaire Markdown 暴露为可填写的局域网网页，等待对方提交回答并把结果交回当前 Agent。
disable-model-invocation: true
---

# 网页问卷

把一次 `to-questionnaire` 产出的 Markdown questionnaire 变成一个可以分享给对方填写的局域网页，并在对方最终提交后恢复当前工作。

## 设计前提（踩过的坑）

**不要用一个长时间阻塞的前台命令等提交。** 工具调用可能被中断或超时，一旦中断：

- 进程被杀，等待循环消失；
- 地址只存在于那次调用的输出里，用户根本拿不到；
- 回答者之后提交的数据虽然落到磁盘，但没人知道。

所以这套流程把三件事分开：**地址先开口说出去、状态落盘、等待分段可恢复。**

## 流程

1. 先调用 `to-questionnaire`，完成收件人、需要返回的信息和 questionnaire 内容，确认问卷文件已写入工作目录。

2. **后台启动服务**（不要前台阻塞，不要用单次长等待）：

   ```bash
   node <to-questionnaire-web>/scripts/serve.mjs --file <questionnaire.md> --host 0.0.0.0 --open 2>&1 | tee <questionnaire>.serve.log &
   ```
   ```powershell
   Start-Process -NoNewWindow node -ArgumentList "<to-questionnaire-web>/scripts/serve.mjs","--file","<questionnaire.md>","--host","0.0.0.0"
   ```

   `--open` 可选：在本机弹出默认浏览器，本地用户直接从地址栏拿到 URL。服务启动后 stdout 第一行是 JSON（含 `lanUrls`/`localUrl`/`statusFile`），随后是一段人类可读的地址横幅。

3. **立刻把可用地址写进给用户的回复正文。** 这是硬要求：地址出现在普通消息里，而不是只躺在工具输出中。给多个候选时标出各自对应的网卡，并说明先试哪个（回答者与哪块网卡同网段就用哪个）。`lanUrls[0]` 已按「虚拟网卡降权」排序，但仍要与回答者所在网络核对。

4. **分段等待提交**，每段不超过 60 秒：

   ```bash
   node <to-questionnaire-web>/scripts/poll.mjs --file <questionnaire.md> --timeout 60
   ```

   退出码：`0` 已提交 / `3` 仍在等待 / `2` 没有进行中的会话。输出单行 JSON，含 `nextHint`。每段结束后向用户简短报告状态；被中断也不会丢数据，下一轮继续 poll 即可。

5. 收到 `state: "submitted"` 后，读取 `responseFile` 和 `responseMarkdown`，把回答纳入当前需求上下文，继续后续需求分析。

## 恢复

任何时候都可以重新确认状态，不依赖任何内存中的等待：

- `node <scripts>/poll.mjs --file <questionnaire.md>` —— 立刻返回当前状态（不传 `--timeout` 就不等）；
- 直接读 `<questionnaire>-status.json`：`state` 为 `waiting` / `submitted`，含 `port`、时间戳、结果文件路径；
- 若需要重新发送链接而 token 已丢失：从 `<questionnaire>.serve.log` 的第一行 JSON 里取 `lanUrls`（status 文件刻意不含 token，可随问卷目录一起分享）。

## 网页行为

- questionnaire 中的 `###` 标题被视为问题，问题下方的 `>` 引用块（含多行中的**首行**）作为回答初始值；`#` 标题与第一个问题之间的段落作为背景说明渲染在页面上。
- 网页保留 questionnaire 内容，提供可编辑的回答框。
- 回答者可在浏览器中保存草稿，刷新页面后草稿仍在当前浏览器中。
- 最终提交会把所有答案写入 JSON 和 Markdown 文件、刷新状态文件，**然后立即退出（只接受一次提交）**；需要重填就重启服务（可用 `--port` 固定端口，使地址不变）。
- 页面自带移动端 viewport，不要求回答者安装工具或访问代码仓库。

## 约束

- **地址必须出现在 Agent 的回复正文里**，不能只留在工具输出或日志中；只把 `127.0.0.1` 链接发给远端回答者同样不算交付。
- **不要用单个长时间阻塞的命令等待提交**；等待一律走 `poll.mjs` 分段进行。
- 每次服务启动生成新的访问令牌；不要把令牌写进 questionnaire 文档，也不要写进 status 文件。
- 回答者只能改回答，不能改问题：需要改问题就在本地改 Markdown，再重启服务。
- 结果文件是当前 questionnaire 的最新提交，不替代需求 session、spec 或 tickets。
- 服务启动失败、文件不存在、端口被占用或提交失败时，报告错误并保留上下文，不声称已收到回答。

## 完成标准

- 回答者拿到的地址是局域网可达的（按网卡核对过），且**该地址已在 Agent 给用户的回复正文里出现过**；
- 等待通过 `poll.mjs` 分段进行，且中途被打断不影响恢复；
- 服务成功接收最终提交，`state` 变为 `submitted`；
- JSON、Markdown 与 status 文件均已写入；
- 当前 Agent 已读取结果并说明下一步。
