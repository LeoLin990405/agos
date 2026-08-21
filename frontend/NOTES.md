# TASK-2026-08-21-010 多模态 NOTES(实现侧)

## W1 fold(地基)

- `pickBlocks(content)` 为纯增量:只保留非 text 块的 `{type, mediaType?, url?, path?, name?, attachment?}`
  引用元信息,**不搬运二进制**;附件经 `attachmentId` 走既有 `session.attachment` RPC 取原件。
- `ToolItem.resultBlocks` / `UserItem.blocks` 均为**新增可选字段**;无块时字段缺省(快照形状不变)。
- `resultText` 行为零变化,实证:392 会话 / 114,949 事件 replay 输出逐字相同(金标 G1 通过),
  且全语料 4317 条 resultText/user text 的 SHA-256 前后零差异(/tmp 对账,未入库)。
- 回放新增不变量 **I6**:原始事件里含非 text 块的工具结果,fold 后必须有 `resultBlocks`
  (独立从原始 JSONL 重数对账,不共用 fold 内部逻辑)。通过时静默,不改变 replay 正常输出。
- 语料实测形态:多模态块全部走 `attachment: { attachmentId: 'sha256:…', mediaType, bytes, width, height, name }`
  (tool-result 内 6 处、user/message 内 14 处),没有 path/url 形态——path 形态由 W2 的
  speak/generate_image 文本解析覆盖。

## W2 输出侧

- **没有改任何工具的 render 返回格式**(宿主约定不动);`speak`/`generate_image` 的**落盘目录**
  从 `os.tmpdir()` 迁到 `~/.dsh/attachments/cn-media/` —— 因为 /api/cn/media 的第一道闸就是
  「realpath 后在 attachments 根之下」,产物必须落在根内才可播可下;顺带从临时文件变持久产物
  (与 cn-vision 落盘约定一致)。render 文本格式逐字不变。
- `GET /api/cn/media?path=` 三道闸全部实现并有插件测试(7/7):realpath 根内(含软链绕行拒绝)、
  扩展名白名单(图 png/jpg/jpeg/webp/gif + 音 wav/mp3/m4a/ogg/flac)、Range/206/416。
  GET/HEAD 纯读,零模型成本。
- 历史会话里 tmpdir 旧产物不在根内 → 路由 403,前端显示错误条(不静默);新产物全部可播。
- 图片点击放大为前端 lightbox;不 base64 进 JSON(附件 RPC 的 data 是既有契约通道,媒体路由不走 JSON)。

## W3 输入侧(NOTES 声明,任务书要求)

- **这不是语义判停。** 业界做法是双层:轻量 VAD(Silero)判「有没有人声」+ 独立语义判停模型
  (Pipecat Smart Turn v3,8MB int8 ONNX,纯 CPU 10-65ms,看韵律不看转写文本)判「说完没有」。
  本轮只做了能量层(AnalyserNode 时域 RMS):**检测到过人声后**,静音持续 1.5s(可调 prop)
  自动停止并提交;没说过话永不自动停。
- **升级路径**:引入 Smart Turn v3 ONNX 模型需要放宽零依赖红线,由 Leo 决定。
- 电平条:transform scaleX 直写(无颜色过渡),`prefers-reduced-motion` 下采样率 66ms→500ms;
  手动「停止」保留;重复停止有 stoppingRef 幂等闸。

## W4 分歧视图与台账

- 分歧高亮 = 纯前端逐行对照:归一化(去全部空白+拉丁小写)后,一行出现在**严格多数**家
  (>n/2)= 共识,否则标 amber;<2 家有效文本时不标(没有对照面,不猜);<6 字符的行不参与
  (客套/标点行是噪音)。对话流卡片与控制台台账共用同一把尺(vision-diff.ts)。
- 「读图台账」挂在控制台导航末位,取 `/api/cn/council-records` 中 kind==='vision' 的记录
  (评审记录 kind 缺省,另有其主,不混入)。

## W5 图片输入

- 粘贴/拖拽/文件选择三条入口同一套 mime 白名单(IMAGE_ATTACHMENT_MEDIA_TYPES,已一致)。
- 新增 `clipboardImageFiles`:files 优先,items 逐项 getAsFile 兜底(Safari 截图粘贴 files 为空)。
- 历史图片:fold W1 后 user/message 的 attachment 块进 `UserItem.blocks`,对话流经
  session.attachment 真渲染;有真图时展示层收起 `[图片 ×N]` 占位(占位文本仍持久保存,
  附件取不回时它是最后的现场说明)。

## 未做(按任务书)

全双工语音 / WS 流式 ASR(需服务端改造,另立任务);ONNX 模型(零依赖红线);
OpenTars 移植(正解是 MCP 桥);/api/cn/vision 仲裁逻辑(它是对的,没碰)。

## 遗留风险(交 Claude live 冒烟)

- `/api/*` 网关对**二进制响应**是否放行(Get 无 body 不带 content-type,实测待 Claude 起栈后验证
  音频拖放/图片加载);若网关强制 JSON 响应,路由需改到非 /api 命名空间或协商。
- `session.attachment` 对 audio 附件的读取语义按契约是「durable image」;当前 audio 产物全走
  path+媒体路由,不依赖该 RPC,无风险敞口。
