import m from "mithril";

const TOKEN_KEY = "bridge_strain_token";
const USER_KEY = "bridge_strain_user";

function verdictClass(verdict, status) {
  if (verdict === "合格") return "tag pass";
  if (verdict === "越界") return "tag fail";
  if (status === "pending" || status === "processing") return "tag wait";
  return "tag wait";
}

function displayVerdict(row) {
  if (row.verdict) return row.verdict;
  if (row.status === "pending") return "待处理";
  if (row.status === "processing") return "处理中";
  return "—";
}

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", { hour12: false });
}

const state = {
  token: localStorage.getItem(TOKEN_KEY) || "",
  user: null,
  loginForm: { username: "surveyor", password: "surv123456" },
  submitForm: { span_code: "", microstrain: "" },
  rows: [],
  error: "",
  msg: "",
  loading: false,
  timer: null,
  view: "readings",
  briefings: [],
  briefing: null,
  briefingErr: "",
  briefingMsg: "",
  generating: false,
};

try {
  state.user = JSON.parse(localStorage.getItem(USER_KEY) || "null");
} catch {
  state.user = null;
}

async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(path, { ...opts, headers });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { detail: text };
  }
  if (!res.ok) throw new Error(data.detail || res.statusText);
  return data;
}

async function loadReadings() {
  if (!state.token) return;
  try {
    state.rows = await api("/api/readings");
    state.error = "";
  } catch {
    state.error = "加载列表失败，请重新登录";
  }
  m.redraw();
}

async function loadBriefings() {
  if (!state.token) return;
  try {
    state.briefings = await api("/api/briefings");
    state.briefingErr = "";
  } catch {
    state.briefingErr = "加载简报列表失败";
  }
  m.redraw();
}

async function openBriefing(id) {
  state.briefingErr = "";
  try {
    state.briefing = await api(`/api/briefings/${id}`);
  } catch (err) {
    state.briefing = null;
    state.briefingErr = err.message || "加载简报正文失败";
  }
  m.redraw();
}

async function generateBriefing() {
  state.briefingErr = "";
  state.briefingMsg = "";
  state.generating = true;
  try {
    const data = await api("/api/briefings", { method: "POST" });
    state.briefing = data;
    state.briefingMsg = data.message || "交班简报已生成";
    await loadBriefings();
  } catch (err) {
    state.briefingErr = err.message || "生成失败";
  } finally {
    state.generating = false;
    m.redraw();
  }
}

function startPolling() {
  if (state.timer) clearInterval(state.timer);
  if (!state.token) return;
  state.timer = setInterval(loadReadings, 3000);
}

function liveStats() {
  let pass = 0;
  let fail = 0;
  let pending = 0;
  for (const r of state.rows) {
    if (r.verdict === "合格") pass += 1;
    else if (r.verdict === "越界") fail += 1;
    else if (r.status === "pending" || r.status === "processing") pending += 1;
  }
  return { pass, fail, pending };
}

function loginView() {
  return m("div.wrap", [
    m("h1", "桥梁应变班交台"),
    m(
      "p.sub",
      "测量员提交跨段编号与微应变读数，后台工人认领队列后判定合格或越界。"
    ),
    m("div.card", [
      m(
        "form",
        {
          onsubmit: async (e) => {
            e.preventDefault();
            state.error = "";
            state.loading = true;
            try {
              const data = await api("/api/auth/login", {
                method: "POST",
                body: JSON.stringify(state.loginForm),
              });
              state.token = data.access_token;
              state.user = { username: data.username, role: data.role };
              localStorage.setItem(TOKEN_KEY, state.token);
              localStorage.setItem(USER_KEY, JSON.stringify(state.user));
              await loadReadings();
              startPolling();
            } catch {
              state.error = "用户名或密码错误";
            } finally {
              state.loading = false;
              m.redraw();
            }
          },
        },
        [
          m("div.row", [
            m("label", [
              "用户名",
              m("input", {
                value: state.loginForm.username,
                oninput: (e) => {
                  state.loginForm.username = e.target.value;
                },
              }),
            ]),
            m("label", [
              "密码",
              m("input", {
                type: "password",
                value: state.loginForm.password,
                oninput: (e) => {
                  state.loginForm.password = e.target.value;
                },
              }),
            ]),
            m(
              "button",
              { type: "submit", disabled: state.loading },
              "登录"
            ),
          ]),
          state.error ? m("p.err", state.error) : null,
        ]
      ),
      m(
        "p.sub",
        { style: { marginBottom: 0 } },
        "测量员 surveyor / surv123456 · 复核员 reviewer / rev123456"
      ),
    ]),
  ]);
}

function readingsView(isWriter) {
  const stats = liveStats();
  return [
    isWriter
      ? m("div.card", [
          m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "提交读数"),
          m(
            "form",
            {
              onsubmit: async (e) => {
                e.preventDefault();
                state.error = "";
                state.msg = "";
                state.loading = true;
                try {
                  const data = await api("/api/readings", {
                    method: "POST",
                    body: JSON.stringify({
                      span_code: state.submitForm.span_code,
                      microstrain: parseFloat(state.submitForm.microstrain),
                    }),
                  });
                  state.msg = data.message || "已提交";
                  state.submitForm = { span_code: "", microstrain: "" };
                  await loadReadings();
                } catch (err) {
                  state.error = err.message || "提交失败";
                } finally {
                  state.loading = false;
                  m.redraw();
                }
              },
            },
            [
              m("div.row", [
                m("label", [
                  "跨段编号",
                  m("input", {
                    required: true,
                    placeholder: "例如 跨中S3",
                    value: state.submitForm.span_code,
                    oninput: (e) => {
                      state.submitForm.span_code = e.target.value;
                    },
                  }),
                ]),
                m("label", [
                  "微应变（με）",
                  m("input", {
                    required: true,
                    type: "number",
                    step: "0.1",
                    value: state.submitForm.microstrain,
                    oninput: (e) => {
                      state.submitForm.microstrain = e.target.value;
                    },
                  }),
                ]),
                m(
                  "button",
                  { type: "submit", disabled: state.loading },
                  "提交"
                ),
              ]),
              state.error ? m("p.err", state.error) : null,
              state.msg ? m("p.ok", state.msg) : null,
            ]
          ),
        ])
      : null,
    m("div.card", [
      m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "在线汇总（实时）"),
      m("div.stats", [
        m("span.stat", [m("b", stats.pass), m("span.tag.pass", "合格")]),
        m("span.stat", [m("b", stats.fail), m("span.tag.fail", "越界")]),
        m("span.stat", [m("b", stats.pending), m("span.tag.wait", "候审")]),
      ]),
      m(
        "p.sub",
        { style: { marginBottom: 0, marginTop: "0.5rem" } },
        "在线汇总随新办结实时变化；已生成的交班简报正文保持生成时快照不变。"
      ),
    ]),
    m("div.card", [
      m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "读数列表"),
      m("table", [
        m("thead", [
          m("tr", [
            m("th", "编号"),
            m("th", "跨段"),
            m("th", "微应变"),
            m("th", "结论"),
            m("th", "说明"),
            m("th", "状态"),
            m("th", "提交人"),
          ]),
        ]),
        m(
          "tbody",
          state.rows.length
            ? state.rows.map((r) =>
                m("tr", { key: r.id }, [
                  m("td", r.id),
                  m("td", r.span_code),
                  m("td", r.microstrain),
                  m("td", [
                    m(
                      "span",
                      { class: verdictClass(r.verdict, r.status) },
                      displayVerdict(r)
                    ),
                  ]),
                  m("td", r.reason || "—"),
                  m("td", r.status),
                  m("td", r.created_by),
                ])
              )
            : [m("tr", m("td", { colspan: 7 }, "暂无数据"))]
        ),
      ]),
    ]),
  ];
}

function briefingsView(isWriter) {
  return [
    m("div.card", [
      m("div.briefing-head", [
        m("h2", { style: { margin: 0, fontSize: "1.1rem" } }, "交班简报"),
        isWriter
          ? m(
              "button",
              {
                type: "button",
                disabled: state.generating,
                onclick: generateBriefing,
              },
              state.generating ? "生成中…" : "一键生成交班简报"
            )
          : m("span.hint", "复核员仅可翻阅简报，不可生成"),
      ]),
      m(
        "p.sub",
        { style: { marginTop: "0.5rem" } },
        "生成时把当下合格量、越界量、候审量与最近办结摘要冻结为只读正文；此后新办结只影响在线汇总。"
      ),
      state.briefingErr ? m("p.err", state.briefingErr) : null,
      state.briefingMsg ? m("p.ok", state.briefingMsg) : null,
    ]),
    m("div.briefing-layout", [
      m("div.card.briefing-list", [
        m("h3", "历史简报"),
        state.briefings.length
          ? state.briefings.map((b) =>
              m(
                "div.briefing-item",
                {
                  key: b.id,
                  class:
                    state.briefing && state.briefing.id === b.id
                      ? "active"
                      : "",
                  onclick: () => openBriefing(b.id),
                },
                [
                  m("div.briefing-item-title", `第 ${b.id} 期`),
                  m("div.briefing-item-meta", fmtTime(b.created_at)),
                  m(
                    "div.briefing-item-meta",
                    `合格 ${b.pass_count} · 越界 ${b.fail_count} · 候审 ${b.pending_count}`
                  ),
                  m("div.briefing-item-meta", `生成人：${b.created_by}`),
                ]
              )
            )
          : m("p.sub", "暂无简报"),
      ]),
      m("div.card.briefing-body", [
        m("h3", [
          "简报正文 ",
          m("span.tag.wait", "只读"),
        ]),
        state.briefing
          ? m("pre", state.briefing.body)
          : m(
              "p.sub",
              state.briefings.length
                ? "点击左侧历史简报查看正文"
                : "尚无简报，测量员可点击上方按钮生成"
            ),
      ]),
    ]),
  ];
}

const App = {
  oninit() {
    loadReadings();
    startPolling();
  },
  onremove() {
    if (state.timer) clearInterval(state.timer);
  },
  view() {
    if (!state.token) {
      return loginView();
    }

    const isWriter = state.user?.role === "writer";

    return m("div.wrap", [
      m("div.topbar", [
        m("div", [
          m("h1", "桥梁应变班交台"),
          m("p.sub", "微应变 80～220 με 为合格，否则为越界。"),
        ]),
        m("div", [
          `${state.user?.username}（${isWriter ? "测量员" : "复核员"}） `,
          m(
            "button.secondary",
            {
              type: "button",
              onclick: () => {
                localStorage.removeItem(TOKEN_KEY);
                localStorage.removeItem(USER_KEY);
                state.token = "";
                state.user = null;
                state.rows = [];
                state.view = "readings";
                state.briefings = [];
                state.briefing = null;
                state.briefingErr = "";
                state.briefingMsg = "";
                if (state.timer) clearInterval(state.timer);
                m.redraw();
              },
            },
            "退出"
          ),
        ]),
      ]),
      m("div.tabs", [
        m(
          "button",
          {
            type: "button",
            class: state.view === "readings" ? "active" : "",
            onclick: () => {
              state.view = "readings";
            },
          },
          "读数汇总"
        ),
        m(
          "button",
          {
            type: "button",
            class: state.view === "briefings" ? "active" : "",
            onclick: async () => {
              state.view = "briefings";
              state.briefingMsg = "";
              await loadBriefings();
            },
          },
          "交班简报"
        ),
      ]),
      state.view === "readings" ? readingsView(isWriter) : briefingsView(isWriter),
    ]);
  },
};

export default App;
