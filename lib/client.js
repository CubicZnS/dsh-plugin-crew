/**
 * dsh-plugin-crew — client half.
 *
 * A plain (unbuilt) module in the same shape as other DSH client plugins: the
 * host serves this file and the loader runs the factory with require("react").
 * Everything else comes from the host rpc bridge (/api + "crewPanel").
 */
window.__ModuleLoader__.load({
  id: "dsh-plugin-crew",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");
    var h = React.createElement;

    var RPC_CHANNEL = "/api";
    var RPC_METHOD = "crewPanel";
    var POLL_MS = 5000;

    function warn() {
      try { console.warn.apply(console, ["[crew]"].concat(Array.prototype.slice.call(arguments))); } catch (e) { /* ignore */ }
    }

    var CSS = [
      ".cw-root{display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;padding:14px 16px;gap:10px;overflow:auto;font-size:13px;line-height:1.55;color:inherit}",
      ".cw-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".cw-title{font-weight:600;font-size:15px}",
      ".cw-dot{width:8px;height:8px;border-radius:50%;background:#2aa56a;display:inline-block}",
      ".cw-dot.bad{background:#d9534f}",
      ".cw-meta{opacity:.6;font-size:12px;margin-left:auto}",
      ".cw-btn{cursor:pointer;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;border-radius:7px;padding:3px 10px;font-size:12px}",
      ".cw-btn:hover{background:rgba(127,127,127,.12)}",
      ".cw-btn:disabled{opacity:.45;cursor:default}",
      ".cw-stats{display:flex;gap:8px;flex-wrap:wrap}",
      ".cw-stat{border:1px solid rgba(127,127,127,.22);border-radius:9px;padding:6px 12px;min-width:76px;background:rgba(127,127,127,.05)}",
      ".cw-stat b{display:block;font-size:16px}",
      ".cw-stat span{font-size:11px;opacity:.65}",
      ".cw-card{border:1px solid rgba(127,127,127,.22);border-radius:10px;background:rgba(127,127,127,.04);overflow:hidden}",
      ".cw-row{display:flex;align-items:center;gap:8px;padding:9px 12px;cursor:pointer}",
      ".cw-row:hover{background:rgba(127,127,127,.08)}",
      ".cw-id{font-family:ui-monospace,Menlo,monospace;font-size:11px;opacity:.75}",
      ".cw-sub{font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".cw-pill{font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid rgba(127,127,127,.35);opacity:.9}",
      ".cw-pill.ok{border-color:rgba(42,165,106,.65);color:#2aa56a}",
      ".cw-pill.bad{border-color:rgba(217,83,79,.7);color:#d9534f}",
      ".cw-pill.warn{border-color:rgba(214,150,40,.7);color:#b57d1e}",
      ".cw-thread{padding:0 12px 12px;display:flex;flex-direction:column;gap:8px}",
      ".cw-turn{margin-top:6px}",
      ".cw-who{display:flex;justify-content:space-between;gap:8px;font-size:11px;opacity:.65;margin-bottom:3px}",
      ".cw-arrow{color:rgba(88,166,255,1)}",
      ".cw-msg{margin:0;padding:8px 10px;border-radius:8px;white-space:pre-wrap;word-break:break-word;font:11.5px/1.6 ui-monospace,Menlo,monospace;border:1px solid rgba(127,127,127,.22);background:rgba(127,127,127,.06);max-height:260px;overflow:auto}",
      ".cw-msg.in{border-color:rgba(42,165,106,.35);background:rgba(42,165,106,.07)}",
      ".cw-empty{opacity:.6;padding:18px 4px}",
      ".cw-err{border:1px solid rgba(217,83,79,.6);color:#d9534f;border-radius:8px;padding:8px 10px;font-size:12px}",
      ".cw-inbox{border:1px solid rgba(214,150,40,.5);border-radius:10px;padding:9px 12px;font-size:12px}",
      ".cw-inbox b{color:#b57d1e}"
    ].join("");

    function installStyles() {
      if (document.getElementById("crew-panel-style")) return;
      var tag = document.createElement("style");
      tag.id = "crew-panel-style";
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    function fmtTime(iso) {
      if (!iso) return "";
      try { return new Date(iso).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" }); } catch (e) { return ""; }
    }

    function statusClass(status) {
      if (status === "done") return "ok";
      if (status === "blocked" || status === "failed") return "bad";
      if (status === "review" || status === "claimed") return "warn";
      return "";
    }

    function Turn(props) {
      var run = props.run;
      var isReview = run.kind === "review";
      var who = isReview ? "reviewer" : "worker";
      return h("div", { className: "cw-turn" },
        h("div", { className: "cw-who" },
          h("span", { className: "cw-arrow" }, "Lead → " + who),
          h("span", null, run.id + "　" + fmtTime(run.startedAt))),
        h("pre", { className: "cw-msg" }, run.prompt || "（这一轮没有记录提示词）"),
        h("div", { className: "cw-who" },
          h("span", { className: "cw-arrow" }, who + " → Lead"),
          h("span", null, (run.status === "running" ? "等待中" : run.status) + "　" + fmtTime(run.reportedAt))),
        h("pre", { className: "cw-msg in" },
          (run.summary || "（还没有回报）") +
          (run.artifacts && run.artifacts.length ? "\n\n产物：\n" + run.artifacts.join("\n") : ""))
      );
    }

    function CrewPanel(props) {
      var call = props.call;
      var [state, setState] = React.useState({ loading: true, error: null, data: null });
      var [expanded, setExpanded] = React.useState({});

      var load = React.useCallback(async function () {
        try {
          var data = await call("snapshot", {});
          setState({ loading: false, error: null, data: data });
        } catch (error) {
          setState(function (prev) { return { loading: false, error: String(error && error.message || error), data: prev.data }; });
        }
      }, [call]);

      React.useEffect(function () {
        installStyles();
        load();
        var timer = setInterval(load, POLL_MS);
        return function () { clearInterval(timer); };
      }, [load]);

      var data = state.data;
      var tasks = (data && data.tasks) || [];
      var stats = (data && data.stats) || { counts: {}, tasks: 0, turns: 0, openInbox: 0 };

      return h("div", { className: "cw-root" },
        h("div", { className: "cw-top" },
          h("span", { className: "cw-dot" + (state.error ? " bad" : "") }),
          h("span", { className: "cw-title" }, "班组"),
          h("button", { className: "cw-btn", onClick: load, disabled: state.loading }, state.loading ? "刷新中" : "刷新"),
          h("span", { className: "cw-meta" }, data ? "共 " + stats.turns + " 轮对话" : "加载中")),

        state.error ? h("div", { className: "cw-err" }, "读取账本失败：" + state.error) : null,

        h("div", { className: "cw-stats" },
          h("div", { className: "cw-stat" }, h("b", null, stats.tasks), h("span", null, "任务")),
          h("div", { className: "cw-stat" }, h("b", { style: { color: "#2aa56a" } }, stats.counts.done || 0), h("span", null, "完成")),
          h("div", { className: "cw-stat" }, h("b", { style: { color: "#d9534f" } }, stats.counts.blocked || 0), h("span", null, "阻塞")),
          h("div", { className: "cw-stat" }, h("b", null, stats.counts.review || 0), h("span", null, "待评审")),
          h("div", { className: "cw-stat" }, h("b", null, stats.openInbox || 0), h("span", null, "待拍板"))),

        stats.openInbox ? h("div", { className: "cw-inbox" }, h("b", null, stats.openInbox + " 件事在等你拍板"), "　说 crew_inbox 看详情") : null,

        tasks.length === 0
          ? h("div", { className: "cw-empty" }, "任务板是空的。跟 Lead 说一句「加个任务：……」")
          : tasks.map(function (task) {
              var open = !!expanded[task.id];
              return h("div", { className: "cw-card", key: task.id },
                h("div", { className: "cw-row", onClick: function () {
                  setExpanded(function (prev) { var next = Object.assign({}, prev); next[task.id] = !prev[task.id]; return next; });
                } },
                  h("span", { className: "cw-id" }, task.id),
                  h("span", { className: "cw-sub" }, task.subject),
                  h("span", { className: "cw-pill " + statusClass(task.status) }, task.status),
                  h("span", { className: "cw-id" }, open ? "▾" : "▸")),
                open ? h("div", { className: "cw-thread" },
                  task.runs && task.runs.length
                    ? task.runs.map(function (run) { return h(Turn, { key: run.id, run: run }); })
                    : h("div", { className: "cw-empty" }, "还没有派过活。")) : null
              );
            })
      );
    }

    class ErrorBoundary extends React.Component {
      constructor(props) { super(props); this.state = { error: null }; }
      static getDerivedStateFromError(error) { return { error: error }; }
      render() {
        if (this.state.error) {
          return h("div", { className: "cw-root" },
            h("div", { className: "cw-err" }, "班组面板出错：" + String(this.state.error && this.state.error.message || this.state.error)));
        }
        return this.props.children;
      }
    }

    function SafeCrewPanel(props) {
      return h(ErrorBoundary, null, h(CrewPanel, props));
    }

    function apply(ctx) {
      try {
        if (!ctx || !ctx.slots || typeof ctx.slots.inject !== "function") {
          warn("slots service unavailable; crew panel not registered");
          return;
        }
        var connection = ctx.get ? ctx.get("connection") : undefined;
        if (!connection || !connection.rpc || typeof connection.rpc.call !== "function") {
          warn("connection.rpc unavailable; crew panel not registered");
          return;
        }
        var call = async function (endpoint, payload) {
          var res = await connection.rpc.call(RPC_CHANNEL, RPC_METHOD, { endpoint: endpoint, payload: payload || {} });
          if (!res || res.ok !== true) {
            var err = (res && res.error) || {};
            throw new Error((err.code || "rpc-failed") + ": " + (err.message || "unknown"));
          }
          return res.value;
        };
        try { ctx.effect(installStyles, "crew: styles"); } catch (e) { /* styles also installed on mount */ }
        ctx.slots.inject("conversation.view", function () {
          return ctx.slots.register({
            name: "conversation.view",
            id: "crew",
            order: 32,
            label: function () { return "班组"; },
            inject: function () { return { call: call }; }
          }, SafeCrewPanel);
        });
      } catch (error) {
        warn("apply failed; host UI left untouched", error);
      }
    }

    exports.inject = ["slots", "connection"];
    exports.apply = apply;
    exports.__internals = { CrewPanel: CrewPanel, SafeCrewPanel: SafeCrewPanel, fmtTime: fmtTime, statusClass: statusClass };
    return module.exports;
  }
});
