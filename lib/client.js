window.__ModuleLoader__.load({
	id: "@dsh-external/dsh-cost-meter",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var react = require("react");

		/* ===== cost: served by the host route, never priced here =====
		 * A session's token lump cannot be priced client-side: router-standard
		 * mixes deepseek-v4-pro / -flash inside one session (3x rate), the
		 * Beijing 9-12 / 14-18 peak window doubles rates mid-session, and a
		 * task's subagents bill from their own logs. The host route folds every
		 * usage record at its own model rate and its own tier instead. */

		function isDeepSeekPeak(now) {
			var h = (now.getUTCHours() + 8) % 24;
			return (h >= 9 && h < 12) || (h >= 14 && h < 18);
		}
		function tierLabel() {
			return isDeepSeekPeak(new Date()) ? "高峰" : "空闲";
		}
		function billedInputTokens(usage) {
			return usage.uncachedInputTokens + (usage.cacheReadTokens != null ? usage.cacheReadTokens : 0) + (usage.cacheWriteTokens != null ? usage.cacheWriteTokens : 0);
		}
		function formatCostCny(cny) {
			if (!(cny > 0)) return "¥0.00";
			if (cny >= 0.01) return "¥" + cny.toFixed(2);
			return "¥" + cny.toFixed(4);
		}

		/* ===== stats ===== */

		function usageOutputTokens(usage) {
			if (typeof usage !== "object" || usage === null) return null;
			var value = usage.outputTokens;
			return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
		}
		function assistantStepReading(node) {
			var timing = node.timing;
			return {
				ttftMs: timing !== void 0 && timing.stepStartTime !== null && timing.firstTokenTime !== null ? Math.max(0, timing.firstTokenTime - timing.stepStartTime) : null,
				decodeMs: timing !== void 0 && timing.firstTokenTime !== null ? Math.max(0, timing.completedTime - timing.firstTokenTime) : null,
				outputTokens: usageOutputTokens(node.usage)
			};
		}
		function deriveStats(nodes) {
			var turns = new Set();
			var steps = 0, llmMs = 0, toolMs = 0, ttftMs = 0, ttftSteps = 0, decodeMs = 0, decodeTokens = 0;
			for (var i = 0; i < nodes.length; i += 1) {
				var node = nodes[i];
				if (node.kind === "tool-result") {
					if (node.callTime !== null) toolMs += Math.max(0, node.time - node.callTime);
					continue;
				}
				if (node.kind !== "assistant") continue;
				turns.add(node.turn);
				steps += 1;
				if (node.timing !== void 0 && node.timing.stepStartTime !== null) llmMs += Math.max(0, node.timing.completedTime - node.timing.stepStartTime);
				var reading = assistantStepReading(node);
				if (reading.ttftMs !== null) { ttftMs += reading.ttftMs; ttftSteps += 1; }
				if (reading.decodeMs !== null && reading.outputTokens !== null) { decodeMs += reading.decodeMs; decodeTokens += reading.outputTokens; }
			}
			return { turns: turns.size, steps: steps, llmMs: llmMs, toolMs: toolMs, ttftMs: ttftMs, ttftSteps: ttftSteps, decodeMs: decodeMs, decodeTokens: decodeTokens };
		}
		function formatTokens(n) {
			var scaled = function (v) { return v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10); };
			if (n < 1e3) return String(n);
			if (n < 1e6) return scaled(n / 1e3) + "K";
			return scaled(n / 1e6) + "M";
		}
		function formatDuration(ms) {
			var s = ms / 1e3;
			if (s < 60) return String(Math.round(s * 10) / 10) + "s";
			var whole = Math.round(s);
			return Math.floor(whole / 60) + "m" + (whole % 60) + "s";
		}
		function formatTokensPerSecond(tps) {
			var clamped = Math.max(0, tps);
			return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10);
		}
		function cacheHitPercent(usage) {
			var denominator = billedInputTokens(usage);
			return denominator === 0 ? null : Math.round((usage.cacheReadTokens != null ? usage.cacheReadTokens : 0) / denominator * 100);
		}

		/* ===== host readings ===== */

		function useBalance() {
			var state = react.useState(null);
			var balance = state[0], setBalance = state[1];
			react.useEffect(function () {
				var cancelled = false;
				var load = function () {
					fetch("/@dsh-external/dsh-cost-meter/balance").then(function (r) { return r.json(); }).then(function (data) {
						if (cancelled || !data || data.ok !== true || data.totalBalance == null) return;
						setBalance({ totalBalance: String(data.totalBalance), currency: data.currency === "USD" ? "USD" : "CNY" });
					}).catch(function () {});
				};
				load();
				var timer = setInterval(load, 60000);
				return function () { cancelled = true; clearInterval(timer); };
			}, []);
			return balance;
		}

		/**
		 * Real per-task cost from the host route. `signal` is a monotone token
		 * counter: bumping it refetches as soon as the provider reports usage,
		 * and the 10s timer keeps a long streaming turn current.
		 */
		function useCost(sessionId, signal) {
			var state = react.useState(null);
			var cost = state[0], setCost = state[1];
			react.useEffect(function () {
				if (typeof sessionId !== "string" || sessionId === "") return;
				var cancelled = false;
				var load = function () {
					fetch("/@dsh-external/dsh-cost-meter/cost?session=" + encodeURIComponent(sessionId)).then(function (r) { return r.json(); }).then(function (data) {
						if (cancelled || !data || data.ok !== true || !data.total || typeof data.total.cost !== "number") return;
						setCost({
							total: { cost: data.total.cost, calls: data.total.calls != null ? data.total.calls : 0 },
							session: { cost: data.session && data.session.cost != null ? data.session.cost : 0 },
							delegated: {
								cost: data.delegated && data.delegated.cost != null ? data.delegated.cost : 0,
								sessions: data.delegated && data.delegated.sessions != null ? data.delegated.sessions : 0
							},
							unpricedModels: Array.isArray(data.unpricedModels) ? data.unpricedModels : []
						});
					}).catch(function () {});
				};
				load();
				var timer = setInterval(load, 10000);
				return function () { cancelled = true; clearInterval(timer); };
			}, [sessionId, signal]);
			return cost;
		}

		function formatBalance(balance) {
			if (balance === null) return null;
			var sym = balance.currency === "USD" ? "$" : "¥";
			return sym + balance.totalBalance;
		}

		/* ===== context-meter colors ===== */

		function meterColor(percent) {
			var hue = 120 - Math.min(100, Math.max(0, percent)) * 1.2;
			return "hsl(" + hue + ", 75%, 45%)";
		}
		function applyMeterColors() {
			if (typeof document === "undefined") return;
			var buttons = document.querySelectorAll('button[aria-haspopup="dialog"][aria-label*="%"]');
			for (var i = 0; i < buttons.length; i += 1) {
				var btn = buttons[i];
				var svg = btn.querySelector("svg");
				if (!svg) continue;
				var fill = svg.querySelector("circle[stroke-dasharray]");
				if (!fill) continue;
				var m = /(\d+)\s*%/.exec(btn.getAttribute("aria-label") || "");
				if (!m) continue;
				fill.style.stroke = meterColor(parseInt(m[1], 10));
			}
		}
		function installMeterColorObserver() {
			if (typeof document === "undefined" || typeof MutationObserver === "undefined") return function () {};
			var observer = new MutationObserver(applyMeterColors);
			observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-label"] });
			applyMeterColors();
			return function () { observer.disconnect(); };
		}

		/* ===== css ===== */

		var COST_METER_CSS = [
			".dsh-cost-meter-root{text-align:center;max-width:var(--dsh-chat-content-width);box-sizing:border-box;width:100%;padding:4px calc(var(--dsh-composer-side-clearance) + 16px) 0px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;text-overflow:ellipsis;margin:0 auto;font-size:12px;line-height:20px;display:block;overflow:hidden}",
			".dsh-cost-meter-tier-idle{color:#22c55e}",
			".dsh-cost-meter-tier-peak{color:#ef4444}"
		].join("");
		var COST_METER_CSS_TAG = "@dsh-external/dsh-cost-meter/CostLine.module.css";
		function injectCss() {
			if (typeof document === "undefined") return;
			if (document.querySelector('style[data-plugin-css="' + COST_METER_CSS_TAG + '"]') !== null) return;
			var tag = document.createElement("style");
			tag.dataset.plugin = "@dsh-external/dsh-cost-meter";
			tag.dataset.pluginCss = COST_METER_CSS_TAG;
			tag.textContent = COST_METER_CSS;
			document.head.appendChild(tag);
		}

		/* ===== the merged line ===== */

		var MergedStats = react.memo(function MergedStats(props) {
			var useSession = props.useSession;
			var useProjection = props.useProjection;
			var settledNodes = useSession(function (s) { return s.chat.legacy.nodes; });
			var usage = useProjection("tokenUsage");
			var projected = useProjection("sessionStats");
			var stats = react.useMemo(function () { return projected != null ? projected : deriveStats(settledNodes); }, [projected, settledNodes]);
			var balance = useBalance();
			var hasUsage = usage !== void 0 && (billedInputTokens(usage) > 0 || usage.outputTokens > 0);
			var cost = useCost(props.sessionId, hasUsage ? usage.outputTokens + billedInputTokens(usage) : 0);

			var groups = [];
			if (stats.steps > 0) {
				groups.push(stats.turns + " 轮 · " + stats.steps + " 步");
				var durations = [];
				if (stats.llmMs > 0) durations.push("LLM " + formatDuration(stats.llmMs));
				if (stats.toolMs > 0) durations.push("工具调用 " + formatDuration(stats.toolMs));
				if (durations.length > 0) groups.push(durations.join(" · "));
				var speeds = [];
				if (stats.ttftSteps > 0) speeds.push("首 token 平均 " + formatDuration(stats.ttftMs / stats.ttftSteps));
				if (stats.decodeMs > 0) speeds.push(formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1e3)) + " tok/s");
				if (speeds.length > 0) groups.push(speeds.join(" · "));
			}
			if (hasUsage) {
				var cacheHit = cacheHitPercent(usage);
				if (cacheHit !== null) groups.push("缓存命中 " + cacheHit + "%");
				groups.push("输入 " + formatTokens(billedInputTokens(usage)) + " tok · 输出 " + formatTokens(usage.outputTokens) + " tok");
			}

			var costGroup = null;
			var costText = null;
			if (cost !== null) {
				var tier = tierLabel();
				var tierClass = tier === "高峰" ? "dsh-cost-meter-tier-peak" : "dsh-cost-meter-tier-idle";
				costText = tier + " 花费 " + formatCostCny(cost.total.cost);
				if (cost.delegated.sessions > 0 && cost.delegated.cost > 0) {
					costText += "（子代理 " + cost.delegated.sessions + " 个 " + formatCostCny(cost.delegated.cost) + "）";
				}
				var balanceText = formatBalance(balance);
				if (balanceText !== null) costText += " · 剩余 " + balanceText;
				costGroup = react.createElement("span", null,
					react.createElement("span", { className: tierClass }, tier),
					costText.slice(tier.length)
				);
			}
			if (groups.length === 0 && costGroup === null) return null;

			var lineParts = [];
			if (costText !== null) lineParts.push(costText);
			for (var p = 0; p < groups.length; p += 1) lineParts.push(groups[p]);
			var line = lineParts.join(" | ");
			if (cost !== null) {
				line += "\n花费按每次请求的真实模型与当时的峰谷时段计价（本会话 " + formatCostCny(cost.session.cost);
				if (cost.delegated.cost > 0) line += " + 子代理 " + formatCostCny(cost.delegated.cost);
				line += "，共 " + cost.total.calls + " 次请求），取自已落盘的会话日志，可能比正在流式输出的这一步落后几秒。";
				if (cost.unpricedModels.length > 0) line += "\n未收录价目的模型按 pro 价估算：" + cost.unpricedModels.join(", ");
			}

			var children = [];
			if (costGroup !== null) children.push(costGroup);
			for (var g = 0; g < groups.length; g += 1) {
				if (children.length > 0) children.push(" | ");
				children.push(groups[g]);
			}
			return react.createElement("div", { className: "dsh-cost-meter-root", title: line }, children);
		});

		exports.inject = ["slots"];
		exports.apply = function apply(ctx) {
			ctx.slots.inject("conversation.composer.dock", function () {
				return ctx.slots.register({
					name: "conversation.composer.dock",
					id: "stats",
					priority: -1,
					order: 0
				}, MergedStats);
			});
			injectCss();
			ctx.effect(installMeterColorObserver, "@dsh-external/dsh-cost-meter: context meter colors");
		};

		return module.exports;
	}
});
