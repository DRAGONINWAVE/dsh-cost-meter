/**
 * @dsh-external/dsh-cost-meter — client half (TypeScript source).
 *
 * Shadows the built-in `stats` cell of the `conversation.composer.dock` slot
 * (same id `stats`, lower priority -1) and renders ONE merged line:
 * `花费 ¥… | 5 轮 · 91 步 | LLM … | … | 缓存命中 …% | 输入 … tok · 输出 … tok`.
 *
 * `lib/client.js` is committed prebuilt. Regenerate with `npm run build:client`.
 */
import { createElement, memo, useEffect, useMemo, useState } from 'react'

type SlotsService = {
  inject(key: string, callback: () => () => void): void
  register(options: Record<string, unknown>, component: unknown): () => void
}
type ClientContext = { slots: SlotsService }

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

function beijingHour(now: Date): number { return (now.getUTCHours() + 8) % 24 }
function isDeepSeekPeak(now: Date): boolean {
  const h = beijingHour(now)
  return (h >= 9 && h < 12) || (h >= 14 && h < 18)
}
function tierLabel(): string {
  return isDeepSeekPeak(new Date()) ? '高峰' : '空闲'
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
  return ((usage.uncachedInputTokens + (usage.cacheWriteTokens ?? 0)) * price.inputMiss[tier]
    + (usage.cacheReadTokens ?? 0) * price.inputHit[tier]
    + usage.outputTokens * price.output[tier]) / 1e6
}
function formatCostCny(cny: number): string {
  if (!(cny > 0)) return '¥0.00'
  if (cny >= 0.01) return `¥${cny.toFixed(2)}`
  return `¥${cny.toFixed(4)}`
}

function usageOutputTokens(usage: any): number | null {
  if (typeof usage !== 'object' || usage === null) return null
  const value = usage.outputTokens
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}
function assistantStepReading(node: any): { ttftMs: number | null; decodeMs: number | null; outputTokens: number | null } {
  const timing = node.timing
  return {
    ttftMs: timing !== void 0 && timing.stepStartTime !== null && timing.firstTokenTime !== null
      ? Math.max(0, timing.firstTokenTime - timing.stepStartTime) : null,
    decodeMs: timing !== void 0 && timing.firstTokenTime !== null
      ? Math.max(0, timing.completedTime - timing.firstTokenTime) : null,
    outputTokens: usageOutputTokens(node.usage),
  }
}
function deriveStats(nodes: readonly any[]) {
  const turns = new Set<number>()
  let steps = 0, llmMs = 0, toolMs = 0, ttftMs = 0, ttftSteps = 0, decodeMs = 0, decodeTokens = 0
  for (const node of nodes) {
    if (node.kind === 'tool-result') {
      if (node.callTime !== null) toolMs += Math.max(0, node.time - node.callTime)
      continue
    }
    if (node.kind !== 'assistant') continue
    turns.add(node.turn)
    steps += 1
    if (node.timing !== void 0 && node.timing.stepStartTime !== null) llmMs += Math.max(0, node.timing.completedTime - node.timing.stepStartTime)
    const reading = assistantStepReading(node)
    if (reading.ttftMs !== null) { ttftMs += reading.ttftMs; ttftSteps += 1 }
    if (reading.decodeMs !== null && reading.outputTokens !== null) { decodeMs += reading.decodeMs; decodeTokens += reading.outputTokens }
  }
  return { turns: turns.size, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens }
}
function formatTokens(n: number): string {
  const scaled = (v: number) => v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10)
  if (n < 1e3) return String(n)
  if (n < 1e6) return `${scaled(n / 1e3)}K`
  return `${scaled(n / 1e6)}M`
}
function formatDuration(ms: number): string {
  const s = ms / 1e3
  if (s < 60) return `${Math.round(s * 10) / 10}s`
  const whole = Math.round(s)
  return `${Math.floor(whole / 60)}m${whole % 60}s`
}
function formatTokensPerSecond(tps: number): string {
  const clamped = Math.max(0, tps)
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10)
}
function cacheHitPercent(usage: any): number | null {
  const denominator = billedInputTokens(usage)
  return denominator === 0 ? null : Math.round((usage.cacheReadTokens ?? 0) / denominator * 100)
}

function useBalance(): { totalBalance: string; currency: 'CNY' | 'USD' } | null {
  const [balance, setBalance] = useState<{ totalBalance: string; currency: 'CNY' | 'USD' } | null>(null)
  useEffect(() => {
    let cancelled = false
    const load = () => {
      fetch('/@dsh-external/dsh-cost-meter/balance')
        .then((r) => r.json())
        .then((data) => {
          if (cancelled || !data || data.ok !== true || data.totalBalance == null) return
          setBalance({ totalBalance: String(data.totalBalance), currency: data.currency === 'USD' ? 'USD' : 'CNY' })
        })
        .catch(() => {})
    }
    load()
    const timer = setInterval(load, 60000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [])
  return balance
}

function formatBalance(balance: { totalBalance: string; currency: 'CNY' | 'USD' } | null): string | null {
  if (balance === null) return null
  const sym = balance.currency === 'USD' ? '$' : '¥'
  return `${sym}${balance.totalBalance}`
}

const MergedStats = memo(function MergedStats(props: any) {
  const useSession = props.useSession
  const useProjection = props.useProjection
  const settledNodes = useSession((s: any) => s.chat.legacy.nodes)
  const usage = useProjection('tokenUsage')
  const projected = useProjection('sessionStats')
  const stats = useMemo(() => projected ?? deriveStats(settledNodes), [projected, settledNodes])
  const balance = useBalance()

  const groups: string[] = []
  if (stats.steps > 0) {
    groups.push(`${stats.turns} 轮 · ${stats.steps} 步`)
    const durations: string[] = []
    if (stats.llmMs > 0) durations.push(`LLM ${formatDuration(stats.llmMs)}`)
    if (stats.toolMs > 0) durations.push(`工具调用 ${formatDuration(stats.toolMs)}`)
    if (durations.length > 0) groups.push(durations.join(' · '))
    const speeds: string[] = []
    if (stats.ttftSteps > 0) speeds.push(`首 token 平均 ${formatDuration(stats.ttftMs / stats.ttftSteps)}`)
    if (stats.decodeMs > 0) speeds.push(`${formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1e3))} tok/s`)
    if (speeds.length > 0) groups.push(speeds.join(' · '))
  }
  const hasUsage = usage !== void 0 && (billedInputTokens(usage) > 0 || usage.outputTokens > 0)
  if (hasUsage) {
    const cacheHit = cacheHitPercent(usage)
    if (cacheHit !== null) groups.push(`缓存命中 ${cacheHit}%`)
    groups.push(`输入 ${formatTokens(billedInputTokens(usage))} tok · 输出 ${formatTokens(usage.outputTokens)} tok`)
    let costText = `${tierLabel()} 花费 ${formatCostCny(computeCostCny(usage, sessionModel(settledNodes)))}`
    const balanceText = formatBalance(balance)
    if (balanceText !== null) costText += ` · 剩余 ${balanceText}`
    groups.unshift(costText)
  }
  if (groups.length === 0) return null
  return createElement('div', {
    className: 'dsh-cost-meter-root',
    title: '花费按 DeepSeek 官方价格估算（¥，含峰谷时段）· Cost estimated from DeepSeek list pricing',
  }, groups.join(' | '))
})

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.composer.dock', () =>
    ctx.slots.register({
      name: 'conversation.composer.dock',
      id: 'stats',
      priority: -1,
      order: 0,
    }, MergedStats),
  )
}
