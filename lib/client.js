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
      ".cw-root{display:flex;flex-direction:column;height:100%;min-height:520px;font-size:13.5px;line-height:1.65;color:inherit;box-sizing:border-box}",
      ".cw-head{display:flex;align-items:center;gap:10px;padding:13px 20px;border-bottom:1px solid rgba(127,127,127,.16)}",
      ".cw-dot{width:7px;height:7px;border-radius:50%;background:#2aa56a;flex:none}",
      ".cw-dot.bad{background:#d9534f}",
      ".cw-title{font-size:15px;font-weight:650;letter-spacing:.01em}",
      ".cw-pills{display:flex;gap:6px;flex-wrap:wrap}",
      ".cw-pill{font-size:11.5px;line-height:1.6;padding:1px 9px;border-radius:999px;border:1px solid rgba(127,127,127,.24);opacity:.75;white-space:nowrap}",
      ".cw-pill.warn{border-color:rgba(214,150,40,.55);color:#c9922e;opacity:1}",
      ".cw-refresh{margin-left:auto;cursor:pointer;border:1px solid rgba(127,127,127,.28);background:transparent;color:inherit;border-radius:8px;padding:4px 12px;font-size:12px;line-height:1.5}",
      ".cw-refresh:hover{background:rgba(127,127,127,.1)}",
      ".cw-refresh:disabled{opacity:.4;cursor:default}",
      ".cw-scroll{flex:1 1 auto;overflow-y:auto;overflow-x:hidden;padding:22px 20px 12px;display:flex;flex-direction:column;min-height:180px}",
      ".cw-inner{width:100%;max-width:760px;margin:0 auto;display:flex;flex-direction:column;gap:18px}",
      ".cw-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;opacity:.5;padding:40px 0}",
      ".cw-empty-title{font-size:14px}",
      ".cw-empty-sub{font-size:12px}",
      ".cw-row{display:flex;gap:10px;align-items:flex-start;max-width:86%}",
      ".cw-row.me{flex-direction:row-reverse;margin-left:auto}",
      ".cw-avatar{width:28px;height:28px;flex:none;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;border:1px solid rgba(127,127,127,.22);background:rgba(127,127,127,.1)}",
      ".cw-row.me .cw-avatar{background:rgba(41,110,190,.55);border-color:rgba(58,110,180,.5)}",
      ".cw-body{min-width:0;display:flex;flex-direction:column}",
      ".cw-row.me .cw-body{align-items:flex-end}",
      ".cw-who{display:flex;gap:7px;align-items:baseline;font-size:11px;opacity:.55;margin-bottom:4px;padding:0 2px}",
      ".cw-who b{font-weight:600;opacity:1}",
      ".cw-badge{font-size:10.5px;border:1px solid rgba(127,127,127,.3);border-radius:999px;padding:0 6px;opacity:.9}",
      ".cw-bubble{border:1px solid rgba(127,127,127,.18);background:rgba(127,127,127,.08);border-radius:14px;padding:9px 13px;white-space:pre-wrap;word-break:break-word;text-align:left;max-width:100%}",
      ".cw-row.me .cw-bubble{background:rgba(41,110,190,.55);border-color:rgba(58,110,180,.45)}",
      ".cw-mention{color:rgba(88,166,255,1);font-weight:600}",
      ".cw-err{margin:0 20px 10px;border:1px solid rgba(217,83,79,.55);color:#d9534f;border-radius:10px;padding:9px 12px;font-size:12px}",
      ".cw-compose{border-top:1px solid rgba(127,127,127,.16);padding:14px 20px 16px;flex:none}",
      ".cw-compose-inner{width:100%;max-width:760px;margin:0 auto;display:flex;gap:10px;align-items:flex-end}",
      ".cw-input{flex:1;box-sizing:border-box;min-height:44px;max-height:150px;resize:none;padding:11px 14px;border-radius:12px;border:1px solid rgba(127,127,127,.26);background:rgba(127,127,127,.05);color:inherit;font-family:inherit;font-size:13.5px;line-height:1.5}",
      ".cw-input:focus{outline:none;border-color:rgba(88,166,255,.55)}",
      ".cw-send{height:44px;padding:0 20px;cursor:pointer;border:1px solid rgba(88,166,255,.55);background:rgba(41,110,190,.5);color:inherit;border-radius:12px;font-size:13.5px;font-family:inherit}",
      ".cw-send:hover{background:rgba(41,110,190,.7)}",
      ".cw-send:disabled{opacity:.35;cursor:default}",
      ".cw-hint{width:100%;max-width:760px;margin:9px auto 0;font-size:11px;opacity:.42}"
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
        h("div", { className: "cw-avatar" }, (name || "?").slice(0, 1)),
        h("div", { className: "cw-body" },
          h("div", { className: "cw-who" },
            h("b", null, name), to,
            badge ? h("span", { className: "cw-badge" }, badge) : null,
            h("span", null, fmtTime(message.at))),
          h("div", { className: "cw-bubble" }, renderText(message.text || ""))));
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
      var hostCanChat = Boolean(state.data && Array.isArray(state.data.messages));
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
          h("div", { className: "cw-pills" },
            h("span", { className: "cw-pill" }, stats.tasks + " 个任务"),
            h("span", { className: "cw-pill" }, (stats.counts.done || 0) + " 完成"),
            h("span", { className: "cw-pill" + (stats.counts.blocked ? " warn" : "") }, (stats.counts.blocked || 0) + " 阻塞"),
            h("span", { className: "cw-pill" + (stats.openInbox ? " warn" : "") }, (stats.openInbox || 0) + " 待拍板")),
          h("button", { className: "cw-refresh", onClick: load, disabled: state.loading }, state.loading ? "刷新中" : "刷新")),

        state.error ? h("div", { className: "cw-err" }, state.error) : null,

        h("div", { className: "cw-scroll", ref: scroller },
          messages.length === 0
            ? h("div", { className: "cw-empty" },
                h("div", { className: "cw-empty-title" }, hostCanChat ? "还没有消息" : "宿主需要重启一次"),
                h("div", { className: "cw-empty-sub" },
                  hostCanChat
                    ? "跟 Lead 说一句「加个任务：……」就开始"
                    : "聊天记录由宿主侧投射。客户端已经更新，但当前宿主还是旧版本——重启 DSH 后这里就会出现。"))
            : h("div", { className: "cw-inner" },
                messages.map(function (message) { return h(Message, { key: message.id, message: message }); }))),

        h("div", { className: "cw-compose" },
          h("div", { className: "cw-compose-inner" },
            h("textarea", {
              className: "cw-input",
              value: draft,
              rows: 1,
              placeholder: "说点什么，可以 @worker / @reviewer",
              onChange: function (event) { setDraft(event.target.value); },
              onKeyDown: function (event) {
                if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); }
              }
            }),
            h("button", { className: "cw-send", onClick: send, disabled: !draft.trim() || sending }, sending ? "发送中" : "发送")),
          h("div", { className: "cw-hint" }, "回车发送 · Shift+回车换行 · 你发的消息会写进账本")));
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
