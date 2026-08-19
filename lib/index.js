/**
 * @dsh-external/dsh-cost-meter — host half (prebuilt from src/index.ts).
 *
 * Routes:
 * - `/@dsh-external/dsh-cost-meter/balance` — DeepSeek CNY wallet row.
 * - `/@dsh-external/dsh-cost-meter/cost?session=<id>` — real cost of one task:
 *   every usage record in the durable log priced at ITS OWN model rate and ITS
 *   OWN peak/off-peak tier, plus every delegated (subagent) session beneath it.
 */
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

export const name = "@dsh-external/dsh-cost-meter";

export const inject = ["webServer"];

const BALANCE_PATH = "/@dsh-external/dsh-cost-meter/balance";
const COST_PATH = "/@dsh-external/dsh-cost-meter/cost";
const BALANCE_URL = "https://api.deepseek.com/user/balance";
const CACHE_TTL_MS = 60000;
const INDEX_TTL_MS = 15000;

/** Official DeepSeek CNY prices per 1M tokens, [offPeak, peak]; api-docs verified 2026-08-19. */
const PRICE = {
  "deepseek-v4-flash": { hit: [0.05, 0.1], miss: [1.5, 3], out: [4.5, 9] },
  "deepseek-v4-pro": { hit: [0.15, 0.3], miss: [4.5, 9], out: [13.5, 27] }
};
/** Unknown routes bill at the expensive tier rather than silently under-reporting. */
const FALLBACK_MODEL = "deepseek-v4-pro";

/** Peak = Beijing 9:00-12:00 and 14:00-18:00; every other hour is half price. */
function tierIndex(timeMs) {
  const hour = (new Date(timeMs).getUTCHours() + 8) % 24;
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18) ? 1 : 0;
}

function priceRow(model) {
  if (typeof model === "string") {
    const direct = PRICE[model];
    if (direct !== void 0) return { row: direct, known: true };
    const lower = model.toLowerCase();
    if (lower.includes("flash")) return { row: PRICE["deepseek-v4-flash"], known: true };
    if (lower.includes("pro")) return { row: PRICE["deepseek-v4-pro"], known: true };
  }
  return { row: PRICE[FALLBACK_MODEL], known: false };
}

function zeroTotals() {
  return { cost: 0, missTokens: 0, hitTokens: 0, outputTokens: 0, calls: 0 };
}

function addTotals(into, from) {
  into.cost += from.cost;
  into.missTokens += from.missTokens;
  into.hitTokens += from.hitTokens;
  into.outputTokens += from.outputTokens;
  into.calls += from.calls;
}

const ZSTD_MAGIC = 4247762216;

/**
 * Locate complete Zstandard frames without decompressing them. The session
 * backend appends one independently decodable frame per batch, so a byte cursor
 * at a frame boundary stays valid as the log grows.
 */
function scanFrames(buffer) {
  const frames = [];
  let offset = 0;
  const stop = () => ({ frames, consumed: frames.length === 0 ? 0 : frames[frames.length - 1].end });
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return stop();
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return stop();
    offset += 4;
    if (offset >= buffer.length) return stop();
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) return stop();
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (offset > buffer.length) return stop();
    for (;;) {
      if (buffer.length - offset < 3) return stop();
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      if (blockType === 3) return stop();
      const payloadBytes = blockType === 1 ? 1 : blockHeader >>> 3;
      if (buffer.length - offset < payloadBytes) return stop();
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return stop();
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames, consumed: offset };
}

/** Read [from, to) of a file without reloading bytes already folded. */
function readRange(path, from, to) {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(to - from);
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, from + read);
      if (n <= 0) break;
      read += n;
    }
    return read === buffer.length ? buffer : buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

const logs = new Map();
let indexAt = 0;

/** Session roots: `$DSH_HOME/sessions/<project>/<sessionId>/session.jsonl[.zstd]`. */
function indexSessions() {
  if (Date.now() - indexAt < INDEX_TTL_MS) return;
  indexAt = Date.now();
  const root = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "sessions");
  if (!existsSync(root)) return;
  let projects;
  try {
    projects = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return;
  }
  for (const project of projects) {
    let entries;
    try {
      entries = readdirSync(join(root, project), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      continue;
    }
    for (const id of entries) {
      if (logs.has(id)) continue;
      const zstd = join(root, project, id, "session.jsonl.zstd");
      const plain = join(root, project, id, "session.jsonl");
      const compressed = existsSync(zstd);
      if (!compressed && !existsSync(plain)) continue;
      logs.set(id, {
        path: compressed ? zstd : plain,
        compressed,
        cursor: 0,
        totals: zeroTotals(),
        parent: null,
        lastTime: 0,
        unknownModels: new Set()
      });
    }
  }
}

/** Fold one JSONL record into a log's running totals. */
function foldRecord(state, line) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return;
  }
  if (record.type === "session") {
    state.parent = typeof record.parentSession === "string" ? record.parentSession : null;
    return;
  }
  if (record.type !== "assistant/message") return;
  const usage = record.data && record.data.usage;
  if (usage === void 0 || usage === null) return;
  const model = record.data.message && record.data.message.source ? record.data.message.source.model : void 0;
  const time = typeof record.time === "number" ? record.time : Date.now();
  const priced = priceRow(model);
  if (!priced.known && typeof model === "string") state.unknownModels.add(model);
  const tier = tierIndex(time);
  const miss = (usage.inputTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  const hit = usage.cacheReadTokens ?? 0;
  const out = usage.outputTokens ?? 0;
  state.totals.cost += (miss * priced.row.miss[tier] + hit * priced.row.hit[tier] + out * priced.row.out[tier]) / 1e6;
  state.totals.missTokens += miss;
  state.totals.hitTokens += hit;
  state.totals.outputTokens += out;
  state.totals.calls += 1;
  if (time > state.lastTime) state.lastTime = time;
}

/** Fold every log record appended since the last call. */
function refresh(state) {
  let size;
  try {
    size = statSync(state.path).size;
  } catch {
    return;
  }
  if (size <= state.cursor) return;
  const tail = readRange(state.path, state.cursor, size);
  if (tail.length === 0) return;
  if (!state.compressed) {
    const text = tail.toString("utf8");
    const lastBreak = text.lastIndexOf("\n");
    if (lastBreak < 0) return;
    for (const line of text.slice(0, lastBreak).split("\n")) if (line.trim() !== "") foldRecord(state, line);
    state.cursor += Buffer.byteLength(text.slice(0, lastBreak + 1), "utf8");
    return;
  }
  const scanned = scanFrames(tail);
  for (const frame of scanned.frames) {
    let plain;
    try {
      plain = zstdDecompressSync(tail.subarray(frame.start, frame.end));
    } catch {
      continue;
    }
    for (const line of plain.toString("utf8").split("\n")) if (line.trim() !== "") foldRecord(state, line);
  }
  state.cursor += scanned.consumed;
}

/** Every delegated session underneath one root, at any depth. */
function descendantsOf(rootId) {
  const out = [];
  const queue = [rootId];
  const seen = new Set(queue);
  while (queue.length > 0) {
    const current = queue.shift();
    for (const [id, state] of logs) {
      if (state.parent !== current || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      queue.push(id);
    }
  }
  return out;
}

/** Real cost of one task: its own log plus every subagent log beneath it. */
function costOf(sessionId) {
  indexSessions();
  for (const state of logs.values()) refresh(state);
  const own = logs.get(sessionId);
  if (own === void 0) return { ok: false, reason: "unknown-session" };
  const delegatedIds = descendantsOf(sessionId);
  const delegated = zeroTotals();
  const unknown = new Set(own.unknownModels);
  let lastTime = own.lastTime;
  for (const id of delegatedIds) {
    const child = logs.get(id);
    if (child === void 0) continue;
    addTotals(delegated, child.totals);
    for (const model of child.unknownModels) unknown.add(model);
    if (child.lastTime > lastTime) lastTime = child.lastTime;
  }
  const total = zeroTotals();
  addTotals(total, own.totals);
  addTotals(total, delegated);
  return {
    ok: true,
    tier: tierIndex(Date.now()) === 1 ? "peak" : "offPeak",
    session: own.totals,
    delegated: Object.assign({}, delegated, { sessions: delegatedIds.length }),
    total,
    lastUsageTime: lastTime === 0 ? null : lastTime,
    unpricedModels: [...unknown]
  };
}

let cache = { at: 0, payload: null };

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-cache"
  });
  res.end(text);
}

/** Resolve the DeepSeek API key through the credentials seam, then the environment. */
async function resolveApiKey(ctx) {
  const credentials = ctx.get("credentials");
  if (credentials !== void 0) {
    try {
      const hit = await credentials.resolve("DEEPSEEK_API_KEY");
      if (hit !== void 0 && typeof hit.value === "string" && hit.value.trim().length > 0) {
        return hit.value.trim();
      }
    } catch {
      /* fall through to the ambient environment */
    }
  }
  const ambient = process.env.DEEPSEEK_API_KEY;
  if (ambient !== void 0 && ambient.trim().length > 0) return ambient.trim();
  return null;
}

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: BALANCE_PATH,
    handler: async (req, res) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendJson(res, 405, { ok: false, reason: "method" });
        return;
      }
      if (cache.payload !== null && Date.now() - cache.at < CACHE_TTL_MS) {
        sendJson(res, 200, cache.payload);
        return;
      }
      const apiKey = await resolveApiKey(ctx);
      if (apiKey === null) {
        sendJson(res, 200, { ok: false, reason: "no-key" });
        return;
      }
      try {
        const upstream = await fetch(BALANCE_URL, {
          headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" }
        });
        if (!upstream.ok) {
          sendJson(res, 200, { ok: false, reason: `upstream-${upstream.status}` });
          return;
        }
        const data = await upstream.json();
        const infos = Array.isArray(data && data.balance_infos) ? data.balance_infos : [];
        const row = infos.find((i) => i && i.currency === "CNY") || infos[0] || null;
        const payload = {
          ok: true,
          isAvailable: !(data && data.is_available === false),
          currency: row ? row.currency : null,
          totalBalance: row ? row.total_balance : null,
          grantedBalance: row ? row.granted_balance : null,
          toppedUpBalance: row ? row.topped_up_balance : null
        };
        cache = { at: Date.now(), payload };
        sendJson(res, 200, payload);
      } catch (error) {
        sendJson(res, 200, { ok: false, reason: "error", message: String((error && error.message) ?? error) });
      }
    }
  }), "@dsh-external/dsh-cost-meter: balance route");

  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: COST_PATH,
    handler: async (req, res) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendJson(res, 405, { ok: false, reason: "method" });
        return;
      }
      const query = new URL(req.url ?? "", "http://127.0.0.1").searchParams;
      const sessionId = query.get("session");
      if (sessionId === null || sessionId.trim() === "") {
        sendJson(res, 200, { ok: false, reason: "no-session" });
        return;
      }
      try {
        sendJson(res, 200, costOf(sessionId.trim()));
      } catch (error) {
        sendJson(res, 200, { ok: false, reason: "error", message: String((error && error.message) ?? error) });
      }
    }
  }), "@dsh-external/dsh-cost-meter: cost route");
}
