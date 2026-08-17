/**
 * @dsh-external/dsh-cost-meter — host half (TypeScript source).
 *
 * Serves `/@dsh-external/dsh-cost-meter/balance` for the browser half: resolve
 * the DeepSeek API key, call `GET https://api.deepseek.com/user/balance`, and
 * return the CNY balance row. `lib/index.js` is committed prebuilt.
 */
export const name = '@dsh-external/dsh-cost-meter'

export const inject = ['webServer']

const BALANCE_PATH = '/@dsh-external/dsh-cost-meter/balance'
const BALANCE_URL = 'https://api.deepseek.com/user/balance'
const CACHE_TTL_MS = 60000

let cache: { at: number; payload: Record<string, unknown> | null } = { at: 0, payload: null }

function sendJson(res: any, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-cache',
  })
  res.end(JSON.stringify(body))
}

async function resolveApiKey(ctx: any): Promise<string | null> {
  const credentials = ctx.get('credentials')
  if (credentials !== void 0) {
    try {
      const hit = await credentials.resolve('DEEPSEEK_API_KEY')
      if (hit !== void 0 && typeof hit.value === 'string' && hit.value.trim().length > 0) {
        return hit.value.trim()
      }
    } catch { /* fall through */ }
  }
  const ambient = process.env.DEEPSEEK_API_KEY
  if (ambient !== void 0 && ambient.trim().length > 0) return ambient.trim()
  return null
}

export function apply(ctx: any): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: BALANCE_PATH,
    handler: async (req: any, res: any) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { ok: false, reason: 'method' })
        return
      }
      if (cache.payload !== null && Date.now() - cache.at < CACHE_TTL_MS) {
        sendJson(res, 200, cache.payload)
        return
      }
      const apiKey = await resolveApiKey(ctx)
      if (apiKey === null) {
        sendJson(res, 200, { ok: false, reason: 'no-key' })
        return
      }
      try {
        const upstream = await fetch(BALANCE_URL, {
          headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
        })
        if (!upstream.ok) {
          sendJson(res, 200, { ok: false, reason: `upstream-${upstream.status}` })
          return
        }
        const data = await upstream.json()
        const infos: any[] = Array.isArray(data?.balance_infos) ? data.balance_infos : []
        const row = infos.find((i) => i && i.currency === 'CNY') || infos[0] || null
        const payload = {
          ok: true,
          isAvailable: !(data && data.is_available === false),
          currency: row ? row.currency : null,
          totalBalance: row ? row.total_balance : null,
          grantedBalance: row ? row.granted_balance : null,
          toppedUpBalance: row ? row.topped_up_balance : null,
        }
        cache = { at: Date.now(), payload }
        sendJson(res, 200, payload)
      } catch (error: any) {
        sendJson(res, 200, { ok: false, reason: 'error', message: String(error?.message ?? error) })
      }
    },
  }), '@dsh-external/dsh-cost-meter: balance route')
}
