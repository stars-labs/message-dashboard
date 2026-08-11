# Handoff: 短信验证码管理系统 — UI/UX 重设计

## Overview

这是对现有 SMS Dashboard（Hono.js + Svelte + Drizzle，95 张 SIM 卡 / EC20 模块）前端的重设计。核心问题是：用户唯一高频需要的东西 —— 验证码 —— 在现有界面里是一个 12px 的绿色小药丸，藏在灰色元信息行里，字号和对比度都低于没人会读的短信正文，且无法复制。

重设计把验证码变成消息列表的主体列（等宽、带底色、点击即复制），把「卡号」确立为全站第一标识（SIM ↔ EC20 一一锁定），删掉了六个统计数字、95 格设备网格、卡详情栏等不驱动任何动作的元素，并把手机端从「桌面布局压小」改成拇指可达的底部标签栏 + push 页。

覆盖范围：消息管理（桌面窄屏/宽屏、iOS）、ICCID 映射（表格 + 映射面板）、关键词高亮、垃圾过滤、用户管理、登录/空/错误态。桌面 + iOS 共 19 帧。

## About the Design Files

这个包里的 `.dc.html` 文件是**用 HTML 做的设计稿** —— 展示预期的外观与行为，不是可以直接拷进项目的生产代码。

任务是**在现有 Svelte 代码库里重建这些设计**，沿用现有的 Svelte 5 + Tailwind + `api.js` 模式。文件里的内联样式是为了在设计工具里能逐帧渲染，实现时应转成 Tailwind class（项目已有 `tailwind.config.js` 和 `app.css` 里的 `@layer` 定义）。

两个文件：
- `Redesign v1.dc.html` — 新设计，19 帧
- `Current UI.dc.html` — 现状复刻（改之前的样子），用于对照

## Fidelity

**High-fidelity。** 颜色、字号、间距、圆角都是最终值，可以照着实现。但注意：

- 所有帧都是**静态状态**，没有交互实现。hover / focus / 动画需要按下面「Interactions」一节补。
- 示意数据是编的（号码、ICCID、发送方、命中数），实现时全部走真实 API。
- 卡号 `05 / 06 / 08 / 11 / 12 / 14 / 17 / 22 / 31 / 43 / 71` 是我为了让各帧互相对得上而编的一组编号，对应关系见下方「卡号」一节。

## ⚠️ 实现前必须先定的两件事

这两件不是前端能单方面决定的，会影响数据模型：

### 1. 卡号（`sim_index`）是否稳定

整套设计以「05」作为第一标识，前提是它**稳定且和物理槽位锁死**。现在的代码里 `sim_index` 是映射表单里一个可手填的数字输入框（`create-sim-index` / `edit-sim-index`），这意味着它可能被填错或与实际槽位不一致。

设计里我把它改成了**只读**（由守护进程读出的槽位推导）。落地前需要确认：

- `sim_index` 是否由 `M{modem}/S{sim}` 唯一决定？
- 换卡后卡号是否跟着卡走，还是跟着槽位走？（设计假设跟着槽位 —— 「05」指那个物理位置）
- 现有数据里有没有 `sim_index` 冲突或为空的记录？

如果卡号实际上不稳定，那消息列表右侧就不能只写「05」，得退回显示号码。

### 2. 状态词需要统一

现在三个组件各有一套状态词，同一张卡在不同页面显示不同状态：

| 来源 | 状态集合 |
|---|---|
| `PhoneList.svelte` | 11 种（含 `searching` / `registered` / `denied` 等 modem 原始态） |
| `IccidMappings.svelte` | 另一套 6 种 |
| `PhoneDetails.svelte` | 又一套 |

设计里统一成五种，需要服务端一并收敛：

| 状态 | 颜色 | 含义 | 用户该做什么 |
|---|---|---|---|
| 在线 | `#10b981` | 卡在读、已注册网络 | 无 |
| 离线 | `#d6d3d1` | 卡在读、未注册网络（含搜索中） | 等，或查天线 |
| 读卡失败 | `#ef4444` | 读不到 ICCID | 重插卡 |
| ICCID 不符 | `#f59e0b` | 槽位里的卡与映射记录不一致 | 编辑映射 |
| 待映射 | `#f59e0b` | 读到 ICCID，无对应号码 | 设置映射 |

`searching` / `registering` 这类 modem 原始态归入「离线」，明细留给排障视图，不进主界面。

## Screens / Views

### 一、消息管理 · 桌面窄屏（1440 × 900）

**Purpose** — 主工作界面。看最新验证码、按卡筛选、偶尔发短信。

**Layout** — 纵向 flex：
```
header        52px   固定
health strip  40px   固定
body          flex   padding 16px 20px, gap 16px
  ├ aside 288px  号码栏（flex-shrink:0）
  └ main  flex   消息列表
发送抽屉：position absolute，遮罩 rgba(28,25,23,.28) + 右侧 400px 面板
```

**Header**（`#fff`，下边框 `#e7e5e4`，`padding 0 20px`，`gap 24px`）
- 产品标记：`assets/favicon.svg` 22×22，圆角 6px（现有 `public/favicon.svg`）
- 标题「验证码中心」14px / 600 / `letter-spacing -.005em`
- 导航四项 14px，`padding 6px 12px`，圆角 7px；选中态 `bg #f5f5f4` + 600，未选 `#78716c`
  - 消息 / 设备与卡 / 规则 / 用户
  - **注意**：这是把现有五个 tab 收成四个 —— 关键词高亮 + 垃圾过滤合并为「规则」（一页两 tab），ICCID 映射并入「设备与卡」
- 守护进程状态：`bg #fafaf9`，边框 `#e7e5e4`，圆角 7px，`padding 5px 10px`；6px 绿点 + 12px「守护进程在线」+ 「· 3秒前」`#a8a29e`
- 「发送短信」按钮：`bg #f97316`，白字 14px/500，圆角 8px，`padding 7px 14px`（宽屏版没有这个按钮）
- 头像 26px 圆 `#e7e5e4`，姓氏 11px/600

**Health strip**（`#fff`，下边框 `#e7e5e4`，`padding 10px 20px`，`gap 24px`）—— 替代原来六个统计数字
- `88` 22px/600 mono `letter-spacing -.02em` + `/ 95` 14px `#a8a29e` + 「张卡在线」12px `#78716c`
- 三个异常摘要 12px `#78716c`，各带 7px 方块：读卡失败 `#ef4444` / ICCID 不匹配 `#f59e0b` / 离线 `#d6d3d1`
- 「处理 →」12px `#c2410c`，下边框 `#fdba74`
- **删掉的**：今日接收、今日发送、总接收、总发送、成功率、95 格设备网格。理由：这些数字不驱动任何动作，占了 62px 高度却只在被问到时才有人看。

**号码栏 aside**（288px，`#fff`，边框 `#e7e5e4`，圆角 10px）
- 顶部 `padding 12px`，下边框 `#f5f5f4`：
  - 搜索框：`bg #fafaf9`，边框 `#e7e5e4`，圆角 8px，`padding 7px 10px`；14px 放大镜 `#a8a29e` + 13px 占位「号码 / 运营商 / ICCID」
  - 三个筛选 chip 12px，圆角 6px，`padding 4px 9px`：`全部 95`（`bg #1c1917` 白字）/ `在线 88`（`bg #fafaf9` 边框 `#e7e5e4`）/ `异常 7`（`bg #fef2f2` 边框 `#fecaca` 字 `#b91c1c`）
- 每行 `padding 9px 12px`，下边框 `#f5f5f4`，`gap 9px`：
  - 7px 状态圆点
  - **卡号** 14px/600 mono，`width 24px`，右对齐，`font-variant-numeric: tabular-nums`（离线态 `#a8a29e`，正常 `#44403c`）
  - 主行：国旗 13px + 号码 13px/500 mono
  - 副行 11px `#a8a29e`：`运营商 · ICCID尾号`（mono）—— 搜索框承诺的四个字段全部可见
  - 右侧 4 格信号条（3px 宽，5/8/11/14px 高，`gap 1.5px`）
  - 异常行整行底色：读卡失败 `#fef2f2`，待映射 `#fffbeb` + 一个「映射」按钮
  - 选中态：`bg #fff7ed` + `box-shadow: inset 3px 0 0 #f97316`
  - 搜索命中用 `<mark>` 高亮，`bg #fed7aa`
- **删掉的**：原来行内的 `M2/S0`。SIM 与模块锁死，卡号已经含这个信息；模块位置只在 ICCID 表和映射面板出现。

**消息列表 main**（`flex:1`，`#fff`，边框 `#e7e5e4`，圆角 10px）
- 标题栏 `padding 11px 16px`，下边框 `#f5f5f4`，两端对齐：
  - 左：`05` 14px/700 mono + 国旗 + 号码 14px/500 mono `#57534e` + `· 312 条` 12px `#a8a29e` + `✕ 清除` chip + `映射` 11px `#c2410c`
  - 未选卡时左侧是「全部设备」+ 绿点「实时」
  - 右：`点击验证码即复制` 12px `#a8a29e`，然后**两个维度分开**：
    - 分段控件（`bg #f5f5f4`，圆角 7px，`padding 2px`）：`验证码` / `全部短信`，选中态白底 + 600 + `shadow 0 1px 2px rgba(28,25,23,.10)`
    - 竖分隔线 1×18px `#e7e5e4`，`margin 0 4px`
    - 垃圾开关 chip：13px 方形复选框（勾选时 `bg #57534e` + 白勾）+ 「隐藏垃圾 **18**」，**默认勾选**。点掉即放开，那 18 条按时间插回列表
    - 「验证码」视图下开关置灰显示 `0` —— 含验证码的短信永不被规则隐藏，此处无可放开内容
- 列头 `padding 6px 12px 8px`，11px/600 `#a8a29e` `letter-spacing .06em`：3px 占位 / 发送方 150px / 验证码 118px / 短信内容 flex / 接收卡 196px（选中单卡时该列变「时间」84px）
- 每行 `padding 11px 12px`，圆角 8px，`gap 16px`，`align-items:center`：
  - 3px × 34px 左竖标（最新消息 `bg #f97316` + 圆角 2px，其余透明）
  - 发送方 150px：14px/600 mono **原始发送方**（`77000` / `SGCert` / `+65 9812 0043`）—— 不做平台名映射
  - 验证码 118px：`inline-flex`，`padding 4px 10px`，圆角 7px，`bg #fff7ed`，边框 `#fed7aa`，18px/600 mono `letter-spacing .06em` `cursor:pointer`；复制后 `bg #ecfdf5` 边框 `#6ee7b7`
  - 无验证码时该格显示 12px `#a8a29e`「无验证码」（保持列对齐，空着会像渲染坏了）
  - 正文 flex：14px `#44403c`，`line-height 1.45`，`-webkit-line-clamp: 2`
  - 接收卡 196px 右对齐：12px mono `国旗 号码` `#292524` / 11px mono `05 · 14:32:07` `#a8a29e`
  - 隔行 `bg #fafaf9`，最新行 `bg #fffbf5`
- **删掉的**：「最新」文字标签。沿用现有逻辑 —— 新消息只用底色 + 左竖标标记，**10 秒后褪回普通行**。滚动时不会积压一排「最新」。

**发送抽屉**（400px，`position absolute`，`box-shadow -16px 0 40px rgba(28,25,23,.16)`）
- 标题栏 `padding 16px 20px` + 关闭 ✕
- 表单 `padding 20px`，`gap 18px`，字段标签 12px/600 `#78716c` `letter-spacing .03em`：
  - **发送卡** —— `bg #fafaf9` 圆角 8px：绿点 + 国旗 + 号码 14px/500 mono + 副行「Singtel · 05 · 信号优秀」+ 右侧「更换」12px `#c2410c`
  - **接收号码** —— 国家码下拉（`+65`，最小 90px）+ 号码输入；下方最近号码 chip ×2 + 「最近 20 个 ›」
  - **内容** —— 边框 `#d6d3d1`，圆角 8px，`min-height 104px`，14px `line-height 1.6`；右上角 `17 / 500 · 1 条`（字数 + 短信条数）；下方三个模板 chip
- 底部 `padding 16px 20px`，上边框 `#e7e5e4`：「取消」+ 「发送到 +65 9812 0043」（按钮写出目标号码，不是光秃秃「发送」）

### 二、消息管理 · 桌面宽屏（1760 × 900）

同上，但 **≥1600px 时发送面板作为常驻第三栏**（352px），各栏独立滚动，header 里不再有「发送短信」按钮，面板里没有「取消」。

`< 1600px` → 抽屉模式。发送是低频功能（日均 62 条发送 vs 1284 条接收），不该常占 1/4 屏；但宽屏空间够时没必要为点一下再弹一层。

**两帧都不再有卡详情栏。** 原本右侧 304px 显示 ICCID / IMEI / 模块位置 / 信号 / RSSI 等，其中卡号、号码、ICCID、信号在号码栏和列表标题里已有 —— 同一份数据显示三遍。IMEI 和模块位置是排障数据，归「设备与卡」页。列表标题里的「映射」直接打开映射面板。

### 三、消息管理 · iOS（390 × 844）

**Purpose** — 与桌面同样的完整工作流，不是精简版。

**Layout**
```
status bar   44px
header       约 100px  标题 + 筛选行
list         flex      overflow-y auto, padding 10px, gap 8px
tab bar      52px + 22px 安全区
```

**Header**（`padding 10px 16px`）
- H1「验证码」24px/700 `letter-spacing -.02em`
- 右侧：`88 / 95 在线` 12px mono + `● 7 异常` 12px/500 `#b91c1c`
- 筛选行 `gap 7px`，**三项刚好放下 356px**（实测需 325.6px）：
  - `全部卡 ▾` chip 102px：`bg #fafaf9` 边框 `#e7e5e4`，圆角 8px，`padding 8px 11px`，13px
  - 分段控件 152px：`bg #e7e5e4` 圆角 9px `padding 3px`；`验证码` / `全部短信`，选中白底 + 600
  - 垃圾开关 58px：**图标 + 数字**（眼睛划掉 15px + `18` mono/600），`bg #57534e` 白字，`padding 8px 10px`。这里放不下「隐藏垃圾」四个字（差 31px），所以只留图标和数字，`title` 补说明

**消息卡片**（`#fff`，边框 `#e7e5e4`，圆角 10px，`padding 11px 12px`，约 108px 高 —— 一屏 6 张）
- 第一行 `gap 9px`：验证码色块（17px/600 mono，`padding 3px 9px`，圆角 6px，`bg #fafaf9` / 最新 `#fff7ed`）+ 发送方 13px/600 mono `#57534e` + 右侧时间 12px mono
- 正文 13px `#57534e` `line-height 1.45` 两行截断，`margin-top 7px`
- 底行 11px mono `#a8a29e`：`05`（600 `#78716c`）` · 🇸🇬 +65 8824 1093`
- 最新卡片：边框 `#fdba74` + `box-shadow 0 1px 6px rgba(249,115,22,.10)`，10 秒后褪回

**Tab bar**（`#fff`，上边框 `#e7e5e4`，`padding-bottom 22px`）—— 四项各 52px 高：验证码 / 设备 / 发送 / 更多。选中 `#c2410c` + 10px/600，未选 `#a8a29e`。底部 134×5px 圆角 3px `#1c1917` home indicator。

替代现有的顶部五连排 tab（消息管理 / ICCID 映射 / 关键词 / 垃圾过滤 / 用户管理 挤在 390px 里，触摸目标过小且会折行）。

**「另有 18 条被规则隐藏 · 查看」** 钉在 tab bar 上方（`flex-shrink:0`，`bg #fafaf9`，上边框 `#e7e5e4`，`padding 10px 14px`），**不在滚动区内** —— 否则要划过所有消息才看得到。

**其他 iOS 页**：
- **设备** —— 卡片列表，问题卡排最前（读卡失败红边框 + 「已 42 分钟」、待映射黄边框 + 「映射」按钮）；筛选 chip 四个：全部 95 / 在线 88 / 异常 7 / 待映射 3；每张卡：状态点 + 卡号 16px/600 mono + 号码 15px/600 mono + 副行「运营商 · ICCID尾号」+ 信号条
- **按卡筛选弹层** —— 底部 sheet 660px：搜索框（输卡号）+ 「最近使用」分组。95 张卡不做横向标签排，那样滑不到底
- **发送** —— 正常标签页，不是悬浮按钮 + 全屏弹层。字段：发送卡（可展开）/ 接收号码（国家码 + 号码 + 最近号码列表）/ 内容 + 模板。输入框 48px 高。未填完时发送按钮是禁用态 `bg #e7e5e4` `#a8a29e`
- **选择发送卡弹层** —— 640px sheet；**默认按今日发送量升序**（轮着发不易被运营商限流），不可发送的卡置灰分组到底部并写明「不可发送」，避免选完写完才报错
- **更多** —— 三组：规则（关键词高亮、垃圾过滤）/ 管理（用户管理）/ 账户。每项带一行现状摘要（「6 条启用」/「11 条规则 · 今日隐藏 18 条」/「8 位用户 · 2 位管理员」）
  - 注意：**不要**加「ICCID 映射」入口 —— 与底部「设备」tab 完全重复（同样 95 张卡、同样字段）。映射在设备页内做，通过「待映射 3」筛选和卡片上的「映射」按钮进入
  - 也不要加「硬件诊断」「全部报表」—— 这两个页面不存在

### 四、ICCID 映射（1440 × 700）

**12 列压到 9 列。** 原表的 设备ID、USB 位置、Modem UP/DOWN 是排障数据，合并成一列「模块位置」（值形如 `M4 / S0`），UP/DOWN 并入「状态」。

列宽：卡号 44 / 号码 150 / ICCID 180 / 运营商 130 / 模块位置 110 / 信号 80 / 状态 110 / 备注 flex / 操作 80（右对齐）。

- 表头 `padding 9px 16px`，`bg #fafaf9`，11px/600 `#a8a29e` `letter-spacing .06em`
- 卡号 14px/600 mono `#1c1917` `tabular-nums`
- 行 `padding 11px 16px`，下边框 `#f5f5f4`
- **需要动手的行排最前**，整行底色：待映射 `#fffbeb` / SIM 错误 `#fef2f2` / ICCID 不符 `#fffbeb`
- 备注列直接写「怎么了」和已持续多久：「卡在读，但没有号码 · 已 6 天」「读卡失败 · 读不到 ICCID · 已 42 分钟 · 建议重插」「插槽里的卡与映射记录不一致」
- 状态 chip 11px/500，圆角 6px
- 操作列：`编辑`（正常行）/ `设置映射`（未映射行，`#c2410c` 600）
  - **只用代码里已有的动作。** 现有 `IccidMappings.svelte` 只有 编辑 / 删除；`设置映射` 存在于 `PhoneList.svelte`，打开的是同一个映射表单。不要发明新动作
  - 删除移进映射面板
- 筛选 chip：全部 95 / 活动 88 / 异常 5 / 待映射 3
- 搜索占位符：`卡号 / 号码 / 运营商 / ICCID`（不是 USB 路径 —— 表里已无该列）
- 「显示诊断列」开关：**不要做**。它不说明打开会多出什么，而模块位置和信号本来就在显示

### 五、映射面板（620px 模态）—— 一个面板，两种进入方式

现有代码里是**两套重复的表单**：`create-iccid / create-phone-number / create-country / create-carrier / create-sim-index / create-imei / create-description` 和一组同名的 `edit-*`，字段完全一样，只是接口不同（POST vs PUT）。**应合并为一个面板**，唯一区别是顶部这张卡是「待选」还是「已确定」。

**进入方式 A：点「添加映射」** —— 顶部是「选择要映射的卡」单选列表，列出守护进程已读到的未映射卡（卡号 + ICCID + 运营商 + 信号），选中态 `bg #fff7ed` 边框 `#f97316` + `shadow 0 0 0 3px rgba(249,115,22,.10)`。

> 原表单第一格是「ICCID *」空输入框，要人手抄 19 位数字。但守护进程本来就读到了这些 ICCID —— 抄错一位就映射到不存在的卡上。

**进入方式 B：点某行「编辑」** —— 顶部换成灰底身份条：卡号 20px/700 mono + 分隔线 + ICCID 13px mono + 「EC20 · M2 / S0 · 在线 · 信号 92%」+ 右侧在线 chip。这些是硬件事实，不可编辑，不该混在输入框中间。

**可编辑字段（两种方式相同）** —— 2 列网格，`gap 14px`：
- 手机号 *（mono，focus 态 `#f97316` + `shadow 0 0 0 3px rgba(249,115,22,.12)`）
- 国家/地区 *（下拉，来自 `countries.js`）
- 运营商（**下拉，不是自由文本** —— 避免同一家写成 `Singtel` / `SINGTEL` / `新加坡电信` 三种）
- IMEI（**只读**，灰底 + 锁图标 —— 守护进程读得到就不该问用户）
- 备注（可选，跨两列）

**删掉的字段**：`sim-index` 数字输入框。选了卡就有卡号；手填只会撞上已占用的槽位，而表单不知道哪些被占了。

**底部**：A 显示「映射后，17历史收到的 142 条短信会自动归属到这个号码」+ 取消 / 添加映射；B 多一个删除区（上边框 `#f5f5f4`，`padding-top 16px`）：「删除这条映射 / 卡还在槽里，但收到的短信将不再归属号码。已收到的 312 条短信保留。」+ 红边框「删除」按钮。原来点表格里的「删除」只弹一句 confirm。

**iOS 版**走 push 页不用弹窗：「‹ 设备」返回，右上角「保存」，输入框 48px 高，删除区在表单末尾。

### 六、规则 · 关键词高亮（1440 × 660）

**现有页面整个是英文**（Keyword Highlighting / Add New Keyword / Color / Priority / Case sensitive / Whole word / Update Keyword），与全站中文不一致 —— **全部汉化**。

「规则」页用分段控件切两个 tab：`关键词高亮 6` / `垃圾过滤 11`。

左侧表格列：效果预览 210 / 标签 96 / 优先级 60 / 匹配方式 96 / 命中 flex（右对齐）/ 启用 72（右对齐）
- **效果预览列**取代原来的「Color」列。原表单独列出 `#3B82F6` 这个色值，用户看不出效果；这里显示一句真实高亮：`您的[验证码]是 839204`，`<mark>` 用该关键词的配色（`bg #dbeafe` 字 `#1d4ed8`，`padding 1px 3px`，圆角 3px，600）
- 匹配方式列把 `case_sensitive` / `whole_word` 两个复选框收成一句人话：`包含` / `整词 · 区分大小写`
- 启用开关 34×20px，`bg #1c1917`（开）/ `#e7e5e4`（关）；停用行整行 `opacity .55`

右侧「添加关键词」表单（新增/编辑共用，代码里已经是 `editingKeyword` 切换，保持）：关键词 / 标签 + 颜色（4 个预设色块，选中 `box-shadow 0 0 0 2px #fff, 0 0 0 3px #1c1917`）/ 优先级 / 匹配方式。下方一张说明卡：「同一段文字被两个关键词同时命中时，数字大的那个上色。所以「验证码」应该高于「优惠」。」

**iOS 版**底部 sheet 720px：顶部常驻效果预览（改一个字立刻看到结果），然后关键词 / 标签 / 颜色（**5 个预设色块 44×44px，不用取色器** —— 手机上拖色盘选不准，且这些色要和高亮底色搭配）/ 优先级 / 两个开关行（44×26px）。底部 删除 + 保存。

### 七、规则 · 垃圾过滤（1440 × 720）

- **「含验证码的短信永不隐藏」提到最上面**（`bg #ecfdf5` 边框 `#a7f3d0`，盾牌图标，13px `#065f46`）。这句原本埋在页面说明第二行小字里 —— 它决定用户敢不敢开过滤
- **重新分类进度常驻**（`bg #fff` 边框 `#fcd34d`）：标题 + 百分比 + 6px 进度条（`bg #fef3c7`，填充 `#f59e0b`）+ 「已重新判定 34,120 条，受影响 218 条，还有 16,043 条待处理」+ 继续处理 / 全部重判。原来 `pending` 数字只在操作后闪一句 toast
- 两类规则分开：
  - **正文关键词**（7 条）—— 表格：规则内容 190 / 备注 flex / 已隐藏 80 / 状态 74 / 操作 70
  - **发送方号码**（4 条）—— **不做表格，做可删标签**：`10086 · 804 ✕`。4 条不值得一整张表
- 右侧「添加规则」：类型下拉 / 规则内容 / 备注

**iOS 版** sheet 560px：类型 / 规则内容 / 备注 + 一条黄色提示「保存后会重新判定全部历史短信，约需 2 分钟。当前这条已隐藏 2,140 条。」—— 这句原来在删除的 `confirm` 里，挪到面板里是为了保存前就看到影响范围。

### 八、用户管理（900 × 520）

- 页面说明里写明：**「改角色会立即注销该用户的所有会话。」** 原来只在 confirm 弹窗里 —— 那时人已经决定要点了，警告来得太晚
- 列：用户 flex / 角色 96 / 最近登录 130 / 操作 190（右对齐）
- **无角色的人排最前**，整行 `bg #fef2f2`，头像 `bg #fee2e2` 字 `#b91c1c` 显示 `?`
- 操作按钮**说结果**：`降级为查看者` / `提升为管理员` / `设为查看者`。不是原来两个并排的「设为管理员 / 设为查看者」（其中一个永远禁用，占位置还不能点）
- 当前登录用户那行不给按钮，只标 12px `#a8a29e`「当前登录用户」

**iOS 版**卡片：上半身份（38px 头像 / 姓名 15px/600 / 角色 chip / 邮箱 12px mono）+ 分隔线 + 下半（最近登录 + 一个结果按钮）。

### 九、登录 / 空 / 错误态

- **登录**（460 × 340）—— 52px 产品标记 + 「验证码中心」19px/600 + 「需要公司邮箱和 sms 角色。首次登录后默认为查看者。」+ 「使用 Auth0 登录」按钮 + 「95 modems · 守护进程在线」11px mono `#a8a29e`
- **空状态** —— 三个点（`#10b981` 呼吸 / `#a7f3d0` / `#d1fae5`）+ 「正在监听 88 张卡」15px/600 + 「新验证码到达后会自动出现在这里，无需刷新。今天已收到 1,284 条。」不写「暂无数据」
- **错误态** —— 红点 + 「守护进程离线」15px/600 `#b91c1c` + 「最后一次心跳是 **14 分钟前**。下面显示的是那时的数据，新短信不会进来。」+ 「通常是 Orange Pi 掉线或 USB 集线器断电。历史消息仍可查看。」+ 「重新连接」按钮
  - **不要**加「查看硬件诊断」按钮 —— 那个页面不存在

## Interactions & Behavior

**点击验证码即复制** —— 整个色块是点击目标（桌面 `cursor:pointer`，手机整块 ≥44px）。`navigator.clipboard.writeText(code)`。反馈：色块 `bg #fff7ed → #ecfdf5`、边框 `#fed7aa → #6ee7b7`，2 秒后回落。不弹 toast。焦点卡额外显示「已复制」+ 对勾。

**新消息高亮 10 秒后褪回**（沿用现有逻辑）—— 到达时加底色 `#fffbf5` + 左竖标 `#f97316`（手机是橙边框），10 秒后 `transition: background .6s, border-color .6s` 褪回普通。不加「最新」文字标签。

**垃圾开关** —— 默认勾选（隐藏）。点掉后那 18 条按时间插回列表，样式区分（虚线边框 + `opacity .7` + 「已过滤: 规则名」chip，沿用现状复刻里的处理）。这是客户端筛选，与「验证码 / 全部短信」是**两个独立维度**，所以并排但用竖线隔开、样式不同（复选框 vs 分段项）。

**内容筛选** —— `验证码` = 有 `parsed_code` 的；`全部短信` = 所有未被规则隐藏的。两者都不含被规则拦掉的。「验证码」视图下垃圾开关置灰为 `0`（含码短信永不被隐藏）。

**响应式断点** —— `≥1600px` 发送面板常驻第三栏；`<1600px` 抽屉；`<768px` 手机布局（底部 tab bar，号码栏变弹层）。

**其他** —— 号码栏行点击 = 筛选消息 + 高亮该行；搜索命中用 `<mark>` 高亮；发送按钮在必填未完成时禁用；映射面板保存后重新判定历史消息归属。

## State Management

沿用现有 Svelte 5 `$state` 模式。新增/变更：

```js
let selectedCardIndex = $state(null);   // 卡号，null = 全部设备
let contentFilter = $state('code');     // 'code' | 'all'
let hideSpam = $state(true);            // 垃圾开关，默认隐藏
let copiedMessageId = $state(null);     // 复制反馈，2s 后清空
let newMessageIds = $state(new Set());  // 高亮中的消息，10s 后移除
let sendPanelMode = $derived(window.innerWidth >= 1600 ? 'column' : 'drawer');
let mappingPanel = $state(null);        // { mode: 'create'|'edit', card } —— 合并后的单一面板
```

数据需求：
- 消息列表需要 `parsed_code`（服务端解析的验证码）、`sender`（原始发送方，不做平台映射）、`receiving_card_index`
- 卡列表需要 `sim_index`（卡号）、`iccid`、`carrier`、`signal`、`status`（统一后的五种）、`today_sent_count`（发送卡选择器排序用）
- `filtered_count`（被规则隐藏的条数）随消息列表返回

## Design Tokens

**颜色**
| 用途 | 值 |
|---|---|
| 页面底 | `#F7F5F2` |
| 卡片 / 面板 | `#FFFFFF` |
| 次级底 | `#FAFAF9` |
| 边框 | `#E7E5E4` |
| 边框（输入框） | `#D6D3D1` |
| 分隔线（浅） | `#F5F5F4` |
| 正文 | `#1C1917` / `#292524` |
| 次级文字 | `#57534E` / `#78716C` |
| 弱化文字 | `#A8A29E`（**对比度下限，不要用 `#C3BDB4`**） |
| 主动作 / 新 | `#F97316`，hover `#EA580C`，文字 `#C2410C` |
| 主动作浅底 | `#FFF7ED`，边框 `#FED7AA` / `#FDBA74` |
| 健康 / 成功 | `#10B981`，文字 `#047857`，浅底 `#ECFDF5`，边框 `#A7F3D0` |
| 警告 | `#F59E0B`，文字 `#92400E`，浅底 `#FFFBEB`，边框 `#FCD34D` |
| 错误 | `#EF4444`，文字 `#B91C1C`，浅底 `#FEF2F2`，边框 `#FECACA` |
| 高亮 · 蓝 | `bg #DBEAFE` 字 `#1D4ED8` 边框 `#BFDBFE` |
| 高亮 · 紫 | `bg #EDE9FE` 字 `#6D28D9` 边框 `#DDD6FE` |

**字体** —— IBM Plex Sans（界面）/ IBM Plex Mono（所有数字：号码、卡号、ICCID、IMEI、验证码、时间、计数）。数字列加 `font-variant-numeric: tabular-nums`。

**字号** —— 桌面：10 / 11 / 12 / 13 / 14 / 16 / 18 / 20 / 22 / 24（验证码）/ 44（焦点卡）；iOS：11 / 12 / 13 / 14 / 15 / 17（验证码）/ 19 / 24（H1）/ 52（焦点卡）。iOS 输入框正文 ≥15px（避免 Safari 自动缩放）。

**间距** —— 2 / 3 / 4 / 6 / 7 / 8 / 9 / 10 / 11 / 12 / 14 / 16 / 18 / 20 / 22 / 24

**圆角** —— 4（小 chip）/ 5 / 6 / 7 / 8 / 9 / 10（卡片）/ 11 / 12（帧）/ 13（开关）/ 16（sheet 顶）/ 50%（圆点、头像）

**阴影**
```
卡片      0 1px 2px rgba(28,25,23,.04)
浮起      0 1px 3px rgba(28,25,23,.06)
焦点卡    0 2px 10px rgba(249,115,22,.10)
抽屉      -16px 0 40px rgba(28,25,23,.16)
模态      0 24px 60px rgba(28,25,23,.28)
底部sheet 0 -8px 30px rgba(28,25,23,.18)
focus ring 0 0 0 3px rgba(249,115,22,.12)
```

**触摸目标** —— iOS 最小 44px；主按钮 48–52px；tab 52px。

## Assets

- `assets/favicon.svg` —— 从现有 `sms-dashboard/public/favicon.svg` 复制（橙色圆角方块 + 白色气泡 + 橙色对勾）。header 用 22px，登录页 52px
- 国旗用 emoji（沿用 `countries.js` 里的 `flag` 字段）
- 图标全部是内联 SVG，`stroke-width 2`（强调处 2.5），`viewBox 0 0 24 24`，`stroke="currentColor"`。没有图标字体依赖
- **无插图、无占位图**

## Screenshots

`screenshots/` 里是 24 张设计帧的截图（桌面 1x，手机 2x）。文件名对应下表：

| 文件 | 帧 | 尺寸 |
|---|---|---|
| `01-desktop-1440-messages.png` | 消息 · 窄屏 · 未选设备 | 1440×900 |
| `02-desktop-1440-send-drawer.png` | 消息 · 窄屏 · 选中 05 + 发送抽屉 | 1440×900 |
| `03-desktop-1760-send-column.png` | 消息 · 宽屏 · 发送常驻第三栏 | 1760×900 |
| `04-ios-codes.png` | iOS 验证码列表 | 390×844 |
| `05-ios-card-filter-sheet.png` | iOS 按卡筛选弹层 | 390×844 |
| `06-ios-devices.png` | iOS 设备 | 390×844 |
| `07-ios-send.png` | iOS 发送 | 390×844 |
| `08-ios-more.png` | iOS 更多 | 390×844 |
| `09-ios-keywords.png` | iOS 关键词高亮 | 390×844 |
| `10-ios-spam-filter.png` | iOS 垃圾过滤 | 390×844 |
| `11-ios-users.png` | iOS 用户管理 | 390×844 |
| `12-ios-edit-mapping.png` | iOS 编辑映射 | 390×844 |
| `13-ios-keyword-panel.png` | iOS 关键词面板（sheet） | 390×844 |
| `14-ios-filter-rule-panel.png` | iOS 过滤规则面板（sheet） | 390×844 |
| `15-ios-pick-send-card.png` | iOS 选择发送卡（sheet） | 390×844 |
| `16-iccid-mappings-table.png` | ICCID 映射表 | 1440×700 |
| `17-mapping-panel-create.png` | 映射面板 · 进入方式 A（先选卡） | 1440×700 |
| `18-mapping-panel-edit.png` | 映射面板 · 进入方式 B（卡已确定） | 1440×700 |
| `19-rules-keywords.png` | 规则 · 关键词高亮 | 1440×660 |
| `20-rules-spam-filter.png` | 规则 · 垃圾过滤 | 1440×720 |
| `21-user-management.png` | 用户管理 | 900×520 |
| `22-login.png` | 登录 | 460×340 |
| `23-empty-state.png` | 空状态 · 等待验证码 | 460×270 |
| `24-error-daemon-offline.png` | 错误 · 守护进程离线 | 460×270 |

截图是静态的，交互（点击复制的反馈、新消息 10 秒褪色、响应式断点）见「Interactions & Behavior」一节。设计源文件里每帧带 `data-shot` 属性，与上表编号对应。

## Files

| 文件 | 内容 |
|---|---|
| `Redesign v1.dc.html` | 新设计 19 帧（桌面窄屏/宽屏、iOS 全流程、ICCID 映射、映射面板、规则两页、用户管理、登录/空/错误） |
| `Current UI.dc.html` | 现状复刻，用于对照 |
| `assets/favicon.svg` | 产品标记 |
| `screenshots/*.png` | 24 张帧截图，见上表 |

用浏览器打开 `.dc.html` 即可（会联网加载 Google Fonts）。每帧下方有一段中文注解，说明这一帧改了什么、为什么。

## Screen map — 设计帧 ↔ 现有源文件

| 设计帧 | 需要改的文件 |
|---|---|
| 消息管理（桌面窄屏/宽屏） | `client/App.svelte`（布局 + 响应式断点 + header + health strip） |
| 消息列表 | `client/lib/SimpleMessageView.svelte`（验证码列、点击复制、发送方/接收卡、两个筛选维度） |
| 号码栏 | `client/lib/PhoneList.svelte`（卡号优先、ICCID 可见、去掉 M/S、状态收敛） |
| 发送面板 / 抽屉 | `client/lib/MessageComposer.svelte`（常驻 vs 抽屉、字段标签、按钮文案） |
| ICCID 映射表 + 映射面板 | `client/lib/IccidMappings.svelte`（12→9 列、两套表单合并、ICCID 改选择、删除移入面板） |
| 关键词高亮 | `client/lib/KeywordConfig.svelte`（**汉化**、效果预览列取代色值列、匹配方式合并） |
| 垃圾过滤 | `client/lib/FilterRules.svelte`（保证提到顶部、进度常驻、发送方改标签） |
| 用户管理 | `client/lib/UserManagement.svelte`（无角色排最前、按钮说结果、警告提前） |
| 卡详情（删除） | `client/lib/PhoneDetails.svelte` —— 消息页不再使用；ICCID/IMEI/模块位置归设备与卡页 |
| 状态词收敛 | `PhoneList` / `IccidMappings` / `PhoneDetails` + 服务端 |

## 顺带发现的现存 bug

读源码时发现的，与重设计无关但值得一并修：

1. **`app.css` 的 `.data-value` 覆盖了标题字号** —— `@layer` 里 `.data-value { @apply text-2xl }` 使「号码列表」`text-lg` 失效，实际渲染 24px mono。`Current UI.dc.html` 复刻的是实际渲染结果
2. **`MessageComposer.svelte` 手机端发送按钮残留旧配色** —— 紫色渐变 + `text-stone-900`，与全站橙色主色不一致
3. **手机端顶部五个 tab 挤在 390px 里**会折行，触摸目标约 32px 高，低于 44px 下限
4. **`KeywordConfig.svelte` 整页英文**，与其余页面中文不一致
