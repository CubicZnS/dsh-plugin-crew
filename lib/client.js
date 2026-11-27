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
    var POLL_MS = 4000;

    var NAMES = { user: "你", lead: "Lead", worker: "worker", reviewer: "reviewer", system: "系统" };
    var BADGES = { handoff: "派活", report: "回报", verdict: "判决", task: "任务", inbox: "待拍板" };

    function warn() {
      try { console.warn.apply(console, ["[crew]"].concat(Array.prototype.slice.call(arguments))); } catch (e) { /* ignore */ }
    }

    var CSS = [
      ".cw-root{display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;font-size:13px;line-height:1.55;color:inherit}",
      ".cw-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:12px 16px 8px;border-bottom:1px solid rgba(127,127,127,.18)}",
      ".cw-title{font-weight:600;font-size:15px}",
      ".cw-dot{width:8px;height:8px;border-radius:50%;background:#2aa56a;display:inline-block}",
      ".cw-dot.bad{background:#d9534f}",
      ".cw-meta{opacity:.6;font-size:12px;margin-left:auto}",
      ".cw-btn{cursor:pointer;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;border-radius:7px;padding:3px 10px;font-size:12px}",
      ".cw-btn:hover{background:rgba(127,127,127,.12)}",
      ".cw-scroll{flex:1;min-height:0;overflow:auto;padding:14px 16px;display:flex;flex-direction:column;gap:12px}",
      ".cw-row{max-width:82%;display:flex;flex-direction:column}",
      ".cw-row.me{align-self:flex-end;align-items:flex-end}",
      ".cw-who{display:flex;gap:6px;align-items:baseline;font-size:11px;opacity:.62;margin-bottom:3px}",
      ".cw-who b{opacity:.95;font-weight:600}",
      ".cw-badge{border:1px solid rgba(127,127,127,.35);border-radius:999px;padding:0 6px}",
      ".cw-at{margin-left:auto}",
      ".cw-bubble{border:1px solid rgba(127,127,127,.22);background:rgba(127,127,127,.07);border-radius:12px;padding:7px 11px;white-space:pre-wrap;word-break:break-word;text-align:left}",
      ".cw-row.me .cw-bubble{background:rgba(31,79,138,.55);border-color:rgba(58,110,180,.6)}",
      ".cw-mention{color:rgba(88,166,255,1);font-weight:600}",
      ".cw-err{border:1px solid rgba(217,83,79,.6);color:#d9534f;border-radius:8px;padding:8px 10px;font-size:12px;margin:8px 16px}",
      ".cw-empty{opacity:.55;padding:18px 4px}",
      ".cw-compose{display:flex;gap:8px;padding:10px 16px 14px;border-top:1px solid rgba(127,127,127,.18);align-items:flex-end}",
      ".cw-input{flex:1;box-sizing:border-box;min-height:34px;max-height:120px;resize:none;padding:7px 10px;border-radius:9px;border:1px solid rgba(127,127,127,.3);background:transparent;color:inherit;font:13px/1.5 inherit}",
      ".cw-send{cursor:pointer;border:1px solid rgba(42,140,255,.6);background:rgba(42,140,255,.12);color:inherit;border-radius:9px;padding:7px 14px;font-size:13px}",
      ".cw-send:disabled{opacity:.4;cursor:default}",
      ".cw-hint{padding:0 16px 10px;font-size:11px;opacity:.5}"
    ].join("");

    function installStyles() {
      if (typeof document === "undefined") return;
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

    /** Split text into plain runs and @mention spans. */
    function renderText(text) {
      var parts = [];
      var pattern = /@([\w\u4e00-\u9fa5-]+)/gu;
      var last = 0;
      var match;
      while ((match = pattern.exec(text)) !== null) {
        if (match.index > last) parts.push(text.slice(last, match.index));
        parts.push(h("span", { className: "cw-mention", key: "m" + match.index }, "@" + match[1]));
        last = match.index + match[0].length;
      }
      if (last < text.length) parts.push(text.slice(last));
      return parts;
    }

    function Message(props) {
      var message = props.message;
      var mine = message.from === "user";
      var name = NAMES[message.from] || message.from;
      var to = message.to && message.to.length
        ? " → " + message.to.map(function (id) { return NAMES[id] || id; }).join("、")
        : "";
      var badge = BADGES[message.kind];
      return h("div", { className: "cw-row" + (mine ? " me" : "") },
        h("div", { className: "cw-who" },
          h("b", null, name), to,
          badge ? h("span", { className: "cw-badge" }, badge) : null,
          h("span", { className: "cw-at" }, fmtTime(message.at))),
        h("div", { className: "cw-bubble" }, renderText(message.text || "")));
    }

    function CrewPanel(props) {
      var call = props.call;
      var [state, setState] = React.useState({ loading: true, error: null, data: null });
      var [draft, setDraft] = React.useState("");
      var [sending, setSending] = React.useState(false);
      var scroller = React.useRef(null);

      var load = React.useCallback(async function () {
        try {
          var data = await call("snapshot", {});
          setState({ loading: false, error: null, data: data });
        } catch (error) {
          setState(function (prev) { return { loading: false, error: String((error && error.message) || error), data: prev.data }; });
        }
      }, [call]);

      React.useEffect(function () {
        installStyles();
        load();
        var timer = setInterval(load, POLL_MS);
        return function () { clearInterval(timer); };
      }, [load]);

      var messages = (state.data && state.data.messages) || [];
      var stats = (state.data && state.data.stats) || { counts: {}, tasks: 0, openInbox: 0 };

      React.useEffect(function () {
        var node = scroller.current;
        if (node) node.scrollTop = node.scrollHeight;
      }, [messages.length]);

      var send = React.useCallback(async function () {
        var text = draft.trim();
        if (!text || sending) return;
        setSending(true);
        try {
          await call("say", { text: text });
          setDraft("");
          await load();
        } catch (error) {
          setState(function (prev) { return Object.assign({}, prev, { error: String((error && error.message) || error) }); });
        } finally {
          setSending(false);
        }
      }, [draft, sending, call, load]);

      return h("div", { className: "cw-root" },
        h("div", { className: "cw-head" },
          h("span", { className: "cw-dot" + (state.error ? " bad" : "") }),
          h("span", { className: "cw-title" }, "班组"),
          h("button", { className: "cw-btn", onClick: load, disabled: state.loading }, state.loading ? "刷新中" : "刷新"),
          h("span", { className: "cw-meta" },
            stats.tasks + " 个任务　" + (stats.counts.done || 0) + " 完成　"
            + (stats.counts.blocked || 0) + " 阻塞　" + (stats.openInbox || 0) + " 待拍板")),

        state.error ? h("div", { className: "cw-err" }, state.error) : null,

        h("div", { className: "cw-scroll", ref: scroller },
          messages.length === 0
            ? h("div", { className: "cw-empty" }, "还没有消息。说一句「加个任务：…」就开始。")
            : messages.map(function (message) { return h(Message, { key: message.id, message: message }); })),

        h("div", { className: "cw-compose" },
          h("textarea", {
            className: "cw-input",
            value: draft,
            placeholder: "说点什么，可以 @worker / @reviewer",
            onChange: function (event) { setDraft(event.target.value); },
            onKeyDown: function (event) {
              if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); }
            }
          }),
          h("button", { className: "cw-send", onClick: send, disabled: !draft.trim() || sending }, sending ? "发送中" : "发送")),

        h("div", { className: "cw-hint" }, "回车发送 / Shift+回车换行。你发的消息会进账本，Lead 下次 crew_chat 能看到。"));
    }

    class ErrorBoundary extends React.Component {
      constructor(props) { super(props); this.state = { error: null }; }
      static getDerivedStateFromError(error) { return { error: error }; }
      render() {
        if (this.state.error) {
          return h("div", { className: "cw-root" },
            h("div", { className: "cw-err" }, "班组面板出错：" + String((this.state.error && this.state.error.message) || this.state.error)));
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
    exports.__internals = { CrewPanel: CrewPanel, SafeCrewPanel: SafeCrewPanel, renderText: renderText, fmtTime: fmtTime };
    return module.exports;
  }
});
