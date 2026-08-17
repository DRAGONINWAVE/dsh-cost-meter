/**
 * @dsh-external/dsh-cost-meter — client half (TypeScript source).
 *
 * Renders an estimated-cost line above the conversation stats line by
 * registering into the `conversation.composer.dock` slot (order -1 → renders
 * before the built-in `stats` entry at order 0).
 *
 * `lib/client.js` is committed prebuilt (hand-rolled CJS factory so it works
 * without a DSH source checkout). Regenerate with `npm run build:client`
 * (tsdown) if tsdown is installed.
 */
import { createElement, memo } from 'react'

type SlotsService = {
  inject(key: string, callback: () => () => void): void
  register(options: Record<string, unknown>, component: unknown): () => void
}

type ClientContext = {
  slots: SlotsService
}

const DEEPSEEK_PRICE_CNY_PER_1M: Record<string, {
  inputHit: { offPeak: number; peak: number }
  inputMiss: { offPeak: number; peak: number }
  output: { offPeak: number; peak: number }
}> = {
  'deepseek-v4-flash': {
    inputHit: { offPeak: 0.05, peak: 0.1 },
    inputMiss: { offPeak: 1.5, peak: 3 },
    output: { offPeak: 4.5, peak: 9 },
  },
  'deepseek-v4-pro': {
    inputHit: { offPeak: 0.15, peak: 0.3 },
    inputMiss: { offPeak: 4.5, peak: 9 },
    output: { offPeak: 13.5, peak: 27 },
  },
}

const DEFAULT_COST_MODEL = 'deepseek-v4-flash'

function beijingHour(now: Date): number {
  return (now.getUTCHours() + 8) % 24
}

function isDeepSeekPeak(now: Date): boolean {
  const h = beijingHour(now)
  return (h >= 9 && h < 12) || (h >= 14 && h < 18)
}

function sessionModel(nodes: readonly any[]): string {
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const node = nodes[i]
    if (node.kind !== 'assistant') continue
    const model = node.provenance?.model ?? node.requestConfig?.model
    if (typeof model === 'string' && model.length > 0) return model
  }
  return DEFAULT_COST_MODEL
}

function billedInputTokens(usage: any): number {
  return usage.uncachedInputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
}

function computeCostCny(usage: any, model: string): number {
  const price = DEEPSEEK_PRICE_CNY_PER_1M[model] ?? DEEPSEEK_PRICE_CNY_PER_1M[DEFAULT_COST_MODEL]
  const tier = isDeepSeekPeak(new Date()) ? 'peak' : 'offPeak'
  const cny = (usage.uncachedInputTokens + (usage.cacheWriteTokens ?? 0)) * price.inputMiss[tier]
    + (usage.cacheReadTokens ?? 0) * price.inputHit[tier]
    + usage.outputTokens * price.output[tier]
  return cny / 1e6
}

function formatCostCny(cny: number): string {
  if (!(cny > 0)) return '¥0.00'
  if (cny >= 0.01) return `¥${cny.toFixed(2)}`
  return `¥${cny.toFixed(4)}`
}

const CostLine = memo(function CostLine(props: any) {
  const useSession = props.useSession
  const useProjection = props.useProjection
  const settledNodes = useSession((s: any) => s.chat.legacy.nodes)
  const usage = useProjection('tokenUsage')
  if (usage === void 0 || (billedInputTokens(usage) <= 0 && usage.outputTokens <= 0)) return null
  return createElement('div', {
    className: 'dsh-cost-meter-root',
    title: '按 DeepSeek 官方价格估算（¥，含峰谷时段）· Estimated from DeepSeek list pricing',
  }, `花费 ${formatCostCny(computeCostCny(usage, sessionModel(settledNodes)))}`)
})

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.composer.dock', () =>
    ctx.slots.register({
      name: 'conversation.composer.dock',
      id: '@dsh-external/dsh-cost-meter',
      order: -1,
    }, CostLine),
  )
}
