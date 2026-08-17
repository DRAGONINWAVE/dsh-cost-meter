window.__ModuleLoader__.load({
	id: "@dsh-external/dsh-cost-meter",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var react = require("react");

		/**
		* DeepSeek official list price in CNY per 1M tokens, split by peak/off-peak.
		* Source: https://api-docs.deepseek.com/zh-cn/quick_start/pricing
		* Peak hours (Beijing time): 9:00-12:00 and 14:00-18:00; otherwise off-peak.
		*/
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

		/** Beijing (UTC+8) hour, independent of the browser's local timezone. */
		function beijingHour(now) {
			return (now.getUTCHours() + 8) % 24;
		}
		function isDeepSeekPeak(now) {
			var h = beijingHour(now);
			return (h >= 9 && h < 12) || (h >= 14 && h < 18);
		}

		/** Newest assistant node's model id; falls back to flash. */
		function sessionModel(nodes) {
			for (var i = nodes.length - 1; i >= 0; i -= 1) {
				var node = nodes[i];
				if (node.kind !== "assistant") continue;
				var model = node.provenance && node.provenance.model != null ? node.provenance.model : node.requestConfig && node.requestConfig.model;
				if (typeof model === "string" && model.length > 0) return model;
			}
			return DEFAULT_COST_MODEL;
		}

		/** Sum the three disjoint prompt-side billing buckets. */
		function billedInputTokens(usage) {
			return usage.uncachedInputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
		}

		/** Estimated session spend in CNY (unrounded). */
		function computeCostCny(usage, model) {
			var price = DEEPSEEK_PRICE_CNY_PER_1M[model] || DEEPSEEK_PRICE_CNY_PER_1M[DEFAULT_COST_MODEL];
			var tier = isDeepSeekPeak(new Date()) ? "peak" : "offPeak";
			var cny = (usage.uncachedInputTokens + (usage.cacheWriteTokens ?? 0)) * price.inputMiss[tier]
				+ (usage.cacheReadTokens ?? 0) * price.inputHit[tier]
				+ usage.outputTokens * price.output[tier];
			return cny / 1e6;
		}

		/** Compact CNY display: two decimals from one cent up, four below. */
		function formatCostCny(cny) {
			if (!(cny > 0)) return "¥0.00";
			if (cny >= 0.01) return "¥" + cny.toFixed(2);
			return "¥" + cny.toFixed(4);
		}

		/* CSS mirroring the conversation StatsLine so the cost line reads as its prefix. */
		var CSS = ".dsh-cost-meter-root{text-align:center;max-width:var(--dsh-chat-content-width);box-sizing:border-box;width:100%;padding:4px calc(var(--dsh-composer-side-clearance) + 16px) 0px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;text-overflow:ellipsis;margin:0 auto;font-size:12px;line-height:20px;display:block;overflow:hidden}";
		var CSS_TAG_ID = "@dsh-external/dsh-cost-meter/CostLine.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG_ID) + "]") === null) {
			var tag = document.createElement("style");
			tag.dataset.plugin = "@dsh-external/dsh-cost-meter";
			tag.dataset.pluginCss = CSS_TAG_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		var CostLine = react.memo(function CostLine(props) {
			var useSession = props.useSession;
			var useProjection = props.useProjection;
			var settledNodes = useSession(function (s) { return s.chat.legacy.nodes; });
			var usage = useProjection("tokenUsage");
			if (usage === void 0 || (billedInputTokens(usage) <= 0 && usage.outputTokens <= 0)) return null;
			var cny = computeCostCny(usage, sessionModel(settledNodes));
			return react.createElement("div", {
				className: "dsh-cost-meter-root",
				title: "按 DeepSeek 官方价格估算（¥，含峰谷时段）· Estimated from DeepSeek list pricing"
			}, "花费 " + formatCostCny(cny));
		});

		exports.inject = ["slots"];
		exports.apply = function apply(ctx) {
			ctx.slots.inject("conversation.composer.dock", function () {
				return ctx.slots.register({
					name: "conversation.composer.dock",
					id: "@dsh-external/dsh-cost-meter",
					order: -1
				}, CostLine);
			});
		};

		return module.exports;
	}
});
