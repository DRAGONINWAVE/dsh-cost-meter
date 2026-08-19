# @dsh-external/dsh-cost-meter

DeepSeek Harness 会话成本计费条：在 Web 界面对话框下方、统计条（`2 轮 · 26 步 | …`）前面，实时显示按 **DeepSeek 官方价格**计算的本次任务花费（¥）与账户余额。

**计价方式（v0.0.2 起，逐次请求计价）**

宿主侧读取已落盘的会话日志，把**每一次请求**按它自己的模型、它发生**当时**的峰谷时段单独计价后累加，并把该任务下**所有层级的子代理会话**一并计入：

```
每次请求 = (未缓存输入 + 缓存写入) × 未命中价 + 缓存读取 × 命中价 + 输出 × 输出价
任务花费 = Σ 本会话每次请求 + Σ 各层子代理会话每次请求
```

- 混用模型正确计价：`router-standard` 等预设会在同一会话里切换 `deepseek-v4-pro` / `deepseek-v4-flash`（单价差 3 倍）
- 峰谷时段按**请求发生时刻**判定（北京时间 9:00–12:00、14:00–18:00 高峰，其余空闲、半价），历史花费不再随时钟变化
- 子代理（subagent / workflow 派生的会话）计入发起它的任务
- 未收录价目的模型按 pro 价（较贵一档）估算，并在悬浮提示中列出
- 拿不到宿主数据时**不显示 ¥**，不展示估算值
- 价格来源：[DeepSeek 模型 & 价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)（2026-08-19 核对）

> v0.0.1 用「会话累计 token × 最后一次用的模型 × 当前时刻的峰谷档」估算，与平台账单存在明显偏差（模型混用、时段跳变、子代理未计），v0.0.2 已重写。

## 路由

| 路由 | 用途 |
|---|---|
| `GET /@dsh-external/dsh-cost-meter/balance` | DeepSeek 账户余额（`GET https://api.deepseek.com/user/balance`，凭据取 `DEEPSEEK_API_KEY`）|
| `GET /@dsh-external/dsh-cost-meter/cost?session=<id>` | 该会话（含子代理）的真实花费与 token 明细 |

`cost` 路由对每个日志维护字节游标，只解压新增的 Zstandard 帧，长会话轮询也不会重复扫描。

## 安装

安装插件分两步：先用 `dsh plugin` 装包，再把它加进 profile 的 `bundles`。

### 方式 A：从 GitHub Release 的 tgz 安装（推荐）

```bash
dsh plugin --profile web add https://github.com/DRAGONINWAVE/dsh-cost-meter/releases/download/v0.0.2/dsh-cost-meter-0.0.2.tgz
```

### 方式 B：从 GitHub 仓库安装

```bash
dsh plugin --profile web add github:DRAGONINWAVE/dsh-cost-meter
```

### 方式 C：从 npm 安装（若已发布）

```bash
dsh plugin --profile web add @dsh-external/dsh-cost-meter
```

### 第二步：加入 bundles

打开 `~/.dsh/profiles/web/package.json`，把包名加进 `dsh.profile.bundles`：

```jsonc
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@dsh-external/dsh-cost-meter"
      ]
    }
  }
}
```

（上面是示例，保留你已有的其它项，只需追加 `"@dsh-external/dsh-cost-meter"`。）

然后重启 Web：

```bash
dsh web --port 3080
```

刷新页面，对话框下方统计条最前面就会出现 `空闲 花费 ¥0.00 · 剩余 ¥…`。

## 本地构建（可选）

`lib/` 已提交预构建产物，开箱即用。若需从源码重建：

```bash
# 仅重建 client bundle（需要先 npm install 装 tsdown）
npm install
npm run build:client

# 重建 host（需 DSH 源码 checkout；预构建的 lib/index.js 通常无需改动）
DSH_CHECKOUT=<dsh-source-checkout> bash scripts/build.sh
```

## 打包

```bash
npm pack
# 生成 dsh-external-dsh-cost-meter-0.0.2.tgz
```

## 说明

- 花费按官方价目表计算，仍属**本地核算**：与平台账单存在秒级结算延迟；插件侧（会话标题生成等）不经会话日志的调用不计入。
- 数据来自已落盘的会话日志，正在流式输出的那一步可能落后几秒。
- 统计条其余字段（轮/步、LLM 用时、tok/s、缓存命中、输入输出 token）取自 harness 的 `tokenUsage` / `sessionStats` 投影。
