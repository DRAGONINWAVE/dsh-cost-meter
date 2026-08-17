# @dsh-external/dsh-cost-meter

DeepSeek Harness 会话成本计费条：在 Web 界面对话框下方、统计条（`2 轮 · 26 步 | …`）前面，实时显示按 **DeepSeek 官方价格**估算的本次会话花费（¥）。

- 按 token 用量计费：`(未缓存输入 + 缓存写入) × 未命中价 + 缓存读取 × 命中价 + 输出 × 输出价`
- 自动识别当前模型：`deepseek-v4-flash` / `deepseek-v4-pro`（未知模型回退 flash）
- 支持 DeepSeek 官方**峰谷时段**定价（北京时间 9:00–12:00、14:00–18:00 为高峰，其余空闲）
- 价格来源：[DeepSeek 模型 & 价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)

## 安装

安装插件分两步：先用 `dsh plugin` 装包，再把它加进 profile 的 `bundles`。

### 方式 A：从 GitHub Release 的 tgz 安装（推荐）

```bash
dsh plugin --profile web add https://github.com/DRAGONINWAVE/dsh-cost-meter/releases/download/v0.0.1/dsh-cost-meter-0.0.1.tgz
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

刷新页面，对话框下方统计条最前面就会出现 `花费 ¥0.00`。

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
# 生成 dsh-external-dsh-cost-meter-0.0.1.tgz
```

## 说明

- 价格为估算值，以 DeepSeek 官方页面为准，可能随官方调价变动。
- 仅在能读到 `tokenUsage` 投影（标准组合已内置 token-meter）且产生过 token 时显示。
