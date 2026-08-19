/**
 * @dsh-external/dsh-cost-meter — client half (TypeScript source).
 *
 * Shadows the built-in `stats` cell of the `conversation.composer.dock` slot
 * (same id `stats`, lower priority -1) and renders ONE merged line:
 * `花费 ¥… | 5 轮 · 91 步 | LLM … | … | 缓存命中 …% | 输入 … tok · 输出 … tok`.
 *
 * The ¥ figure is NOT computed here. Cost comes from the host route
 * `/@dsh-external/dsh-cost-meter/cost?session=<id>`, which prices every
 * provider-reported usage record in the durable log at its own model rate and
 * its own peak/off-peak tier and adds the task's subagent sessions. Pricing the
 * client's lump-sum token projection with one model at the current clock — what
 * this file used to do — disagreed with the platform bill, because
 * `router-standard` mixes pro/flash mid-session (3× rate), the Beijing 9–12 /
 * 14–18 peak window doubles rates mid-session, and delegated sessions bill to
 * the same account from their own logs. When the route cannot answer, the line
 * shows no ¥ at all rather than a fabricated one.
 *
 * `lib/client.js` is committed prebuilt. Regenerate with `npm run build:client`.
 */
import { createElement, memo, useEffect, useMemo, useState } from 'react'

type SlotsService = {
  inject(key: string, callback: () => () => void): void
  register(options: Record<string, unknown>, component: unknown): () => void
}
type ClientContext = { slots: SlotsService; effect(callback: () => unknown, name?: string): unknown }

const COST_METER_CSS = [
  '.dsh-cost-meter-root{text-align:center;max-width:var(--dsh-chat-content-width);box-sizing:border-box;width:100%;padding:4px calc(var(--dsh-composer-side-clearance) + 16px) 0px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;text-overflow:ellipsis;margin:0 auto;font-size:12px;line-height:20px;display:block;overflow:hidden}',
  '.dsh-cost-meter-tier-idle{color:#22c55e}',
  '.dsh-cost-meter-tier-peak{color:#ef4444}',
].join('')
const COST_METER_CSS_TAG = '@dsh-external/dsh-cost-meter/CostLine.module.css'
function injectCss(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${COST_METER_CSS_TAG}"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = '@dsh-external/dsh-cost-meter'
  tag.dataset.pluginCss = COST_METER_CSS_TAG
  tag.textContent = COST_METER_CSS
  document.head.appendChild(tag)
}

/** Peak = Beijing 9:00–12:00 and 14:00–18:00; used for the live tier label only. */
function isDeepSeekPeak(now: Date): boolean {
  const h = (now.getUTCHours() + 8) % 24
  return (h >= 9 && h < 12) || (h >= 14 && h < 18)
}
function tierLabel(): string {
  return isDeepSeekPeak(new Date()) ? '高峰' : '空闲'
}
function billedInputTokens(usage: any): number {
  return usage.uncachedInputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
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

type CostReading = {
  total: { cost: number; calls: number }
  session: { cost: number; calls: number }
  delegated: { cost: number; sessions: number }
  unpricedModels: string[]
}

/**
 * Real per-task cost from the host route. `signal` is any monotone token
 * counter: bumping it refetches the moment the provider reports new usage, and
 * the 10s timer keeps a long streaming turn current.
 */
function useCost(sessionId: unknown, signal: number): CostReading | null {
  const [cost, setCost] = useState<CostReading | null>(null)
  useEffect(() => {
    if (typeof sessionId !== 'string' || sessionId === '') return
    let cancelled = false
    const load = () => {
      fetch(`/@dsh-external/dsh-cost-meter/cost?session=${encodeURIComponent(sessionId)}`)
        .then((r) => r.json())
        .then((data) => {
          if (cancelled || !data || data.ok !== true || typeof data.total?.cost !== 'number') return
          setCost({
            total: { cost: data.total.cost, calls: data.total.calls ?? 0 },
            session: { cost: data.session?.cost ?? 0, calls: data.session?.calls ?? 0 },
            delegated: { cost: data.delegated?.cost ?? 0, sessions: data.delegated?.sessions ?? 0 },
            unpricedModels: Array.isArray(data.unpricedModels) ? data.unpricedModels : [],
          })
        })
        .catch(() => {})
    }
    load()
    const timer = setInterval(load, 10000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [sessionId, signal])
  return cost
}

function formatBalance(balance: { totalBalance: string; currency: 'CNY' | 'USD' } | null): string | null {
  if (balance === null) return null
  const sym = balance.currency === 'USD' ? '$' : '¥'
  return `${sym}${balance.totalBalance}`
}

/** Green → red by occupancy percent (0% green, 100% red). */
function meterColor(percent: number): string {
  const hue = 120 - Math.min(100, Math.max(0, percent)) * 1.2
  return `hsl(${hue}, 75%, 45%)`
}
/** Color every context-occupancy ring's fill from its aria-label percent. */
function applyMeterColors(): void {
  if (typeof document === 'undefined') return
  const buttons = document.querySelectorAll('button[aria-haspopup="dialog"][aria-label*="%"]')
  for (let i = 0; i < buttons.length; i += 1) {
    const btn = buttons[i]
    const svg = btn.querySelector('svg')
    if (!svg) continue
    const fill = svg.querySelector('circle[stroke-dasharray]')
    if (!fill) continue
    const m = /(\d+)\s*%/.exec(btn.getAttribute('aria-label') || '')
    if (!m) continue
    ;(fill as HTMLElement).style.stroke = meterColor(parseInt(m[1], 10))
  }
}
/** Watch for the ring appearing/updating; returns the observer disposer. */
function installMeterColorObserver(): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {}
  const observer = new MutationObserver(applyMeterColors)
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-label'] })
  applyMeterColors()
  return () => observer.disconnect()
}

const MergedStats = memo(function MergedStats(props: any) {
  const useSession = props.useSession
  const useProjection = props.useProjection
  const settledNodes = useSession((s: any) => s.chat.legacy.nodes)
  const usage = useProjection('tokenUsage')
  const projected = useProjection('sessionStats')
  const stats = useMemo(() => projected ?? deriveStats(settledNodes), [projected, settledNodes])
  const balance = useBalance()
  const hasUsage = usage !== void 0 && (billedInputTokens(usage) > 0 || usage.outputTokens > 0)
  const cost = useCost(props.sessionId, hasUsage ? usage.outputTokens + billedInputTokens(usage) : 0)

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
  if (hasUsage) {
    const cacheHit = cacheHitPercent(usage)
    if (cacheHit !== null) groups.push(`缓存命中 ${cacheHit}%`)
    groups.push(`输入 ${formatTokens(billedInputTokens(usage))} tok · 输出 ${formatTokens(usage.outputTokens)} tok`)
  }

  let costGroup: any = null
  let costText: string | null = null
  if (cost !== null) {
    const tier = tierLabel()
    const tierClass = tier === '高峰' ? 'dsh-cost-meter-tier-peak' : 'dsh-cost-meter-tier-idle'
    costText = `${tier} 花费 ${formatCostCny(cost.total.cost)}`
    if (cost.delegated.sessions > 0 && cost.delegated.cost > 0) {
      costText += `（子代理 ${cost.delegated.sessions} 个 ${formatCostCny(cost.delegated.cost)}）`
    }
    const balanceText = formatBalance(balance)
    if (balanceText !== null) costText += ` · 剩余 ${balanceText}`
    costGroup = createElement('span', null,
      createElement('span', { className: tierClass }, tier),
      costText.slice(tier.length),
    )
  }
  if (groups.length === 0 && costGroup === null) return null

  const lineParts: string[] = []
  if (costText !== null) lineParts.push(costText)
  lineParts.push(...groups)
  let line = lineParts.join(' | ')
  if (cost !== null) {
    line += `\n花费按每次请求的真实模型与当时的峰谷时段计价（本会话 ${formatCostCny(cost.session.cost)}`
    if (cost.delegated.cost > 0) line += ` + 子代理 ${formatCostCny(cost.delegated.cost)}`
    line += `，共 ${cost.total.calls} 次请求），数据来自已落盘的会话日志，可能比正在流式输出的这一步落后几秒。`
    if (cost.unpricedModels.length > 0) line += `\n未收录价目的模型按 pro 价估算：${cost.unpricedModels.join(', ')}`
  }

  const children: any[] = []
  if (costGroup !== null) children.push(costGroup)
  for (let g = 0; g < groups.length; g += 1) {
    if (children.length > 0) children.push(' | ')
    children.push(groups[g])
  }
  return createElement('div', { className: 'dsh-cost-meter-root', title: line }, children)
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
  injectCss()
  ctx.effect(installMeterColorObserver, '@dsh-external/dsh-cost-meter: context meter colors')
}
