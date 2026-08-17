window.__ModuleLoader__.load({
	id: "@dsh-external/dsh-cost-meter",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var react = require("react");

		/* ===== cost pricing ===== */

		var DEEPSEEK_PRICE_CNY_PER_1M = {
			"deepseek-v4-flash": {
				inputHit: { offPeak: 0.05, peak: 0.1 },
				inputMiss: { offPeak: 1.5, peak: 3 },
				output: { offPeak: 4.5, peak: 9 }
			},
			"deepseek-v4-pro": {
				inputHit: { offPeak: 0.15, peak: 0.3 },
				inputMiss: { offPeak: 4.5, peak: 9 },
				output: { offPeak: 13.5, peak: 27 }
			}
		};
		var DEFAULT_COST_MODEL = "deepseek-v4-flash";

		function beijingHour(now) {
			return (now.getUTCHours() + 8) % 24;
		}
		function isDeepSeekPeak(now) {
			var h = beijingHour(now);
			return (h >= 9 && h < 12) || (h >= 14 && h < 18);
		}
		function tierLabel() {
			return isDeepSeekPeak(new Date()) ? "高峰" : "空闲";
		}
		function sessionModel(nodes) {
			for (var i = nodes.length - 1; i >= 0; i -= 1) {
				var node = nodes[i];
				if (node.kind !== "assistant") continue;
				var model = node.provenance && node.provenance.model != null ? node.provenance.model : node.requestConfig && node.requestConfig.model;
				if (typeof model === "string" && model.length > 0) return model;
			}
			return DEFAULT_COST_MODEL;
		}
		function billedInputTokens(usage) {
			return usage.uncachedInputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
		}
		function computeCostCny(usage, model) {
			var price = DEEPSEEK_PRICE_CNY_PER_1M[model] || DEEPSEEK_PRICE_CNY_PER_1M[DEFAULT_COST_MODEL];
			var tier = isDeepSeekPeak(new Date()) ? "peak" : "offPeak";
			var cny = (usage.uncachedInputTokens + (usage.cacheWriteTokens ?? 0)) * price.inputMiss[tier]
				+ (usage.cacheReadTokens ?? 0) * price.inputHit[tier]
				+ usage.outputTokens * price.output[tier];
			return cny / 1e6;
		}
		function formatCostCny(cny) {
			if (!(cny > 0)) return "¥0.00";
			if (cny >= 0.01) return "¥" + cny.toFixed(2);
			return "¥" + cny.toFixed(4);
		}

		/* ===== stats-line helpers (mirrors the built-in StatsLine) ===== */

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
				if (reading.ttftMs !== null) {
					ttftMs += reading.ttftMs;
					ttftSteps += 1;
				}
				if (reading.decodeMs !== null && reading.outputTokens !== null) {
					decodeMs += reading.decodeMs;
					decodeTokens += reading.outputTokens;
				}
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
			return denominator === 0 ? null : Math.round((usage.cacheReadTokens ?? 0) / denominator * 100);
		}

		/* ===== merged cost + stats line ===== */

		var CSS = ".dsh-cost-meter-root{text-align:center;max-width:var(--dsh-chat-content-width);box-sizing:border-box;width:100%;padding:4px calc(var(--dsh-composer-side-clearance) + 16px) 0px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;text-overflow:ellipsis;margin:0 auto;font-size:12px;line-height:20px;display:block;overflow:hidden}.dsh-cost-meter-tier-idle{color:#22c55e}.dsh-cost-meter-tier-peak{color:#ef4444}";
		var CSS_TAG_ID = "@dsh-external/dsh-cost-meter/CostLine.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG_ID) + "]") === null) {
			var tag = document.createElement("style");
			tag.dataset.plugin = "@dsh-external/dsh-cost-meter";
			tag.dataset.pluginCss = CSS_TAG_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		/** Fetch the DeepSeek account balance through the host route (polled). */
		function useBalance() {
			var state = react.useState(null);
			var balance = state[0];
			var setBalance = state[1];
			react.useEffect(function () {
				var cancelled = false;
				var load = function () {
					fetch("/@dsh-external/dsh-cost-meter/balance").then(function (r) {
						return r.json();
					}).then(function (data) {
						if (cancelled || !data || data.ok !== true || data.totalBalance == null) return;
						setBalance({ totalBalance: String(data.totalBalance), currency: data.currency === "USD" ? "USD" : "CNY" });
					}).catch(function () {});
				};
				load();
				var timer = setInterval(load, 60000);
				return function () {
					cancelled = true;
					clearInterval(timer);
				};
			}, []);
			return balance;
		}
		/** Currency-prefixed balance text, or null while unavailable. */
		function formatBalance(balance) {
			if (balance === null) return null;
			var sym = balance.currency === "USD" ? "$" : "¥";
			return sym + balance.totalBalance;
		}

		/** Green → red by occupancy percent (0% green, 100% red). */
		function meterColor(percent) {
			var hue = 120 - Math.min(100, Math.max(0, percent)) * 1.2;
			return "hsl(" + hue + ", 75%, 45%)";
		}
		/** Color every context-occupancy ring's fill from its aria-label percent. */
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
		/** Watch for the ring appearing/updating; returns the observer disposer. */
		function installMeterColorObserver() {
			if (typeof document === "undefined" || typeof MutationObserver === "undefined") return function () {};
			var observer = new MutationObserver(applyMeterColors);
			observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-label"] });
			applyMeterColors();
			return function () {
				observer.disconnect();
			};
		}

		var MergedStats = react.memo(function MergedStats(props) {
			var useSession = props.useSession;
			var useProjection = props.useProjection;
			var settledNodes = useSession(function (s) { return s.chat.legacy.nodes; });
			var usage = useProjection("tokenUsage");
			var projected = useProjection("sessionStats");
			var stats = react.useMemo(function () { return projected || deriveStats(settledNodes); }, [projected, settledNodes]);
			var balance = useBalance();

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
			var hasUsage = usage !== void 0 && (billedInputTokens(usage) > 0 || usage.outputTokens > 0);
			if (hasUsage) {
				var cacheHit = cacheHitPercent(usage);
				if (cacheHit !== null) groups.push("缓存命中 " + cacheHit + "%");
				groups.push("输入 " + formatTokens(billedInputTokens(usage)) + " tok · 输出 " + formatTokens(usage.outputTokens) + " tok");
			}

			var costGroup = null;
			var costText = null;
			if (hasUsage) {
				var tier = tierLabel();
				var tierClass = tier === "高峰" ? "dsh-cost-meter-tier-peak" : "dsh-cost-meter-tier-idle";
				costText = tier + " 花费 " + formatCostCny(computeCostCny(usage, sessionModel(settledNodes)));
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
			lineParts = lineParts.concat(groups);
			var line = lineParts.join(" | ");

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
			ctx.effect(installMeterColorObserver, "@dsh-external/dsh-cost-meter: context meter colors");
		};

		return module.exports;
	}
});
