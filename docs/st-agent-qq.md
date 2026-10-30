# ST Agent Gateway 与 QQ 官方机器人

Agent 由 ST 服务端网关运行。QQ 消息、主会话、提示词组装、模型请求、摘要和任务均不需要浏览器。网关直接读取角色卡、模型连接和世界书；main 直接使用日常角色聊天的原生窗口与 JSONL 记录，网页通过 WebSocket 同步消息。

## 启动

仅启动网关和 HTTP API：

```bash
npm run start:gateway
# 指定实例
npm run start:gateway -- --port 8000 --dataRoot ./data
```

沿用 ST 的配置、账户、密钥库和数据目录。此模式跳过前端编译、网页静态资源与自动打开浏览器，根路径返回网关元信息。需要完整 ST 页面时使用 `npm start`；同一个网关也会挂载到普通 ST 服务中。

处理链：QQ 官方 WebSocket → ST 网关 → 持久队列 / main → 服务端提示词 → ST 模型接口 → QQ 回复。网页不在处理链中。

## 不打开网页配置

以下示例使用本机默认单用户实例。HTTP API 保留 ST 的认证、CSRF、Basic Auth 和来源限制。多账户实例先通过 `/api/users/login` 使用 `handle` 和 `password` 登录并保存 Cookie。

先取得 Cookie 和 CSRF token：

```bash
ST_URL=http://127.0.0.1:8000
curl -sS -c st.cookies "$ST_URL/csrf-token" > st-csrf.json
ST_CSRF=$(node -p 'JSON.parse(require("fs").readFileSync("st-csrf.json", "utf8")).token')
```

`GET /api/agent/catalog` 返回角色文件名和预设名。配置网关只需文件引用，不需要从网页生成提示词：

```bash
curl -sS -b st.cookies -H "X-CSRF-Token: $ST_CSRF" \
  -H 'Content-Type: application/json' \
  --data '{"character":"Seraphina.png","preset":"","chat":{"avatar":"Seraphina.png","file":"已有角色聊天的文件名（不含 .jsonl）"}}' \
  "$ST_URL/api/agent/bind"
```

`chat` 指向账户已有的角色聊天；绑定后这段历史就是 main。`avatar` 必须与 `character` 相同，`file` 不含 `.jsonl`。省略 `chat` 的旧 API 仍可继续运行，之后可在 ST 中将角色聊天绑定为 main。`character` 留空使用通用助手；`preset` 留空跟随 ST 已保存的当前聊天补全设置。指定预设时，每轮读取 `OpenAI Settings/<预设>.json`。角色读取 `characters/<文件名>`，支持 ST PNG 卡和 JSON 角色数据。

也可以直接提供模型连接，把下面的 JSON 保存为本地文件，用 `curl --data-binary @文件名` POST 到 `/api/agent/bind`：

```json
{
  "character": "",
  "connection": {
    "chat_completion_source": "custom",
    "model": "your-model",
    "custom_url": "http://127.0.0.1:1234/v1",
    "max_tokens": 512
  }
}
```

这些覆盖值存入账户密钥库，不会在状态响应中返回。模型 API 密钥继续使用 ST 密钥库，可通过已有的 `/api/secrets/write` 设置对应键，例如 `api_key_custom`、`api_key_openai`。

启用后台并发送消息：

```bash
curl -sS -b st.cookies -H "X-CSRF-Token: $ST_CSRF" \
  -H 'Content-Type: application/json' --data '{"enabled":true}' \
  "$ST_URL/api/agent/config"

curl -sS -b st.cookies -H "X-CSRF-Token: $ST_CSRF" \
  -H 'Content-Type: application/json' \
  --data '{"session":"main","text":"你好，记住我的项目。"}' \
  "$ST_URL/api/agent/message"
```

`/config` 保存完整后台配置。修改已有 QQ、心跳或任务时，先读取 `/api/agent/status` 的 `config`，修改目标字段后提交，避免默认值覆盖其他设置。发送返回 `202` 表示已持久化排队；回复可从 `GET /api/agent/session` 读取，生产客户端建议使用 WebSocket 推送。

## WebSocket 网关

通过已认证的 ST 会话和 CSRF token，POST `{}` 到 `/api/agent/gateway-ticket`。使用返回的单次 ticket 连接：

```text
ws://主机:端口/api/agent/gateway?ticket=...
```

HTTPS 使用 `wss://`。ticket 仅可使用一次，有效期 30 秒；浏览器连接还会校验 Origin。断开后取得新 ticket 重连。

```json
{"id":"1","method":"subscribe","params":{"session":"main"}}
{"id":"2","method":"message","params":{"session":"main","text":"继续我们的计划"}}
{"id":"3","method":"status","params":{}}
{"id":"4","method":"session","params":{"session":"main"}}
{"id":"5","method":"retry","params":{}}
```

命令响应为 `{"type":"response","id":"...","ok":true,"result":...}`；失败使用 `ok:false` 和 `error`。会话或状态发生变化时，主动推送 `type:"snapshot"`，包含 `config`、`status` 和订阅的 `session`。默认订阅 main。每个连接只能访问自己的 ST 账户。

网页已改用此连接，不再通过 1.5 秒或 5 秒轮询刷新。队列中的下一条可执行消息立即继续处理。客户端断开不会停止后台或 QQ 连接。

## 服务端角色与提示词

普通 ST 页面中，先打开日常使用的角色聊天，再在 **扩展 → 常驻 Agent / QQ** 选择预设，点击 **将当前角色聊天设为 main**，启用后台并保存。随后回到原来的角色聊天继续对话。main 使用原生消息列表、Markdown、角色头像、输入框、消息编辑/删除、已有回复切换、重新生成与续写，没有独立的聊天页面、弹窗或侧栏入口。其他角色聊天与同一角色的其他聊天不受绑定影响。

这段聊天中发送的消息通过网关排队生成；QQ 主人的私聊、任务与可见心跳回复也写入同一份原生聊天记录，通过 WebSocket 自动显示。切换到其他聊天或关闭所有网页不会停止后台，重新打开时仍从普通聊天历史读取。网页刷新保留磁盘记录，实时同步保留正在输入的草稿。并发保存会检查版本，旧标签页不能覆盖新到的后台消息；发生冲突时保留本地修改并提示重新载入后重试。

网关每轮读取保存的模型设置、角色卡、预设和世界书，文件缓存随磁盘修改失效。支持角色描述、性格、场景、对话示例、用户角色描述、预设顺序、禁用提示、历史后指令、深度注入及常用的角色/用户/描述/日期时间宏。

世界书按当前会话匹配，支持常驻条目、普通关键词、大小写选项、辅助关键词逻辑、角色绑定及嵌入的世界书、深度注入。目前不执行 STscript、浏览器扩展工具、任意脚本宏、世界书正则/递归/向量匹配或 sticky/cooldown 等高级状态，不保证与浏览器完整提示词引擎逐字相同。支持文本聊天补全模型，不提供任意系统命令执行。

上下文预算按字符计算，应为输出留空间。长对话摘要后继续，完整历史仍在磁盘。长期记忆仅供 main 使用。绑定时沿用所选角色聊天的完整历史；旧版独立 main 的历史会一次性追加保留，不再使用独立界面。消息编辑、删除和回复切换会同步到后续模型上下文。重命名聊天会更新绑定；删除这段聊天会停用后台。旧版提示快照与历史保留；重新应用网关配置后切换为读取文件。

## QQ 官方机器人

在 <https://q.qq.com/> 创建机器人，取得 AppID 和 AppSecret。通过普通 ST 页面的 QQ 设置，或 POST 到 `/api/agent/config`：

```json
{
  "enabled": true,
  "qq": {
    "enabled": true,
    "appId": "YOUR_APP_ID",
    "ownerOpenId": "YOUR_USER_OPENID",
    "sandbox": false,
    "allowedGroups": []
  },
  "qqSecret": "YOUR_APP_SECRET"
}
```

真实凭据在部署主机填写。AppSecret 存入账户密钥库，后续可省略 `qqSecret` 保留原值。OpenID 是此机器人下的身份标识，不是 QQ 号码。

首次可留空 ownerOpenId，启动后私聊机器人，在 `status.observedSender` 查看发现的身份，保存允许的 OpenID 后才会回复。沙箱需在开放平台添加测试成员与群。

主人的私聊进入 main。允许群内的成员通过 @ 机器人触发回复，每群使用独立会话，不读取 main 历史、摘要或私人长期记忆。绑定的角色提示仍供这些群使用。

QQ 使用官方 token API、WebSocket Gateway 和 v2 消息接口，无需公网 Webhook。主机需能访问 `bots.qq.com`、`api.sgroup.qq.com`（沙箱为 `sandbox.api.sgroup.qq.com`）、QQ 返回的 WSS 地址与模型 API。当前接入文本私聊及群 @ 消息；图片、语音、视频、文件尚不送入后台模型。

## 心跳、任务与持久化

心跳按分钟检查 main，返回精确的 `HEARTBEAT_OK` 时不推送无事消息。任务支持首次时间和重复间隔，间隔 0 为一次性，结果保存到 main，可额外发给主人 QQ。停机错过的周期合并为一次检查；主动消息仍受 QQ 平台权限与交互时间等规则限制。

绑定的 main 完整历史使用原生 `data/<账户>/chats/<角色>/<聊天名>.jsonl`；每个账户在 `data/<账户>/agent/` 保存配置、摘要、队列和群会话。启用的 Agent 随网关启动恢复。消息先保存再处理，回复先保存再发送；连续失败三次后保留队列，修正配置后调用 HTTP `/api/agent/retry` 或网关 `retry`。

停用需将 `enabled` 设为 false；关闭网页不会停用后台。24/7 需要主机和网关进程持续在线，可由系统服务或进程管理器维护。备份账户的 `chats/`、`agent/` 和密钥库。

## 验证

在 `tests/` 下运行 `npm run test:unit -- --runInBand agent`。测试包含真正启动纯网关、不加载前端、通过 WebSocket 生成回复、读取磁盘变更和重启恢复的集成检查。真实 QQ 连通性仍需自己的机器人凭据验证。
