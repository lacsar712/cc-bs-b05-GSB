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

function formatTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

function liveSummary(rows) {
  let pass = 0;
  let fail = 0;
  let pending = 0;
  for (const r of rows) {
    if (r.status === "done") {
      if (r.verdict === "合格") pass += 1;
      else if (r.verdict === "越界") fail += 1;
    } else if (r.status === "pending" || r.status === "processing") {
      pending += 1;
    }
  }
  return { pass, fail, pending };
}

const state = {
  token: localStorage.getItem(TOKEN_KEY) || "",
  user: null,
  page: "readings",
  loginForm: { username: "surveyor", password: "surv123456" },
  submitForm: { span_code: "", microstrain: "" },
  rows: [],
  briefs: [],
  selectedBrief: null,
  error: "",
  msg: "",
  briefError: "",
  loading: false,
  generating: false,
  timer: null,
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

async function loadBriefs() {
  if (!state.token) return;
  try {
    // 只更新历史列表；已打开的正文留在 state.selectedBrief，轮询不得覆盖
    state.briefs = await api("/api/briefs");
    state.briefError = "";
  } catch {
    state.briefError = "加载历史简报失败";
  }
  m.redraw();
}

async function openBrief(id) {
  state.briefError = "";
  try {
    // 取一次即冻结在本地；此后轮询/新办结都不再改变这份正文
    state.selectedBrief = await api(`/api/briefs/${id}`);
  } catch (err) {
    state.briefError = err.message || "打开简报失败";
  }
  m.redraw();
}

async function generateBrief() {
  state.generating = true;
  state.briefError = "";
  try {
    const brief = await api("/api/briefs", { method: "POST" });
    state.briefs = [brief, ...state.briefs];
    state.selectedBrief = brief;
  } catch (err) {
    state.briefError = err.message || "生成失败";
  } finally {
    state.generating = false;
    m.redraw();
  }
}

function pollTick() {
  loadReadings();
  if (state.page === "briefs") loadBriefs();
}

function startPolling() {
  if (state.timer) clearInterval(state.timer);
  if (!state.token) return;
  state.timer = setInterval(pollTick, 3000);
}

function logout() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  state.token = "";
  state.user = null;
  state.rows = [];
  state.briefs = [];
  state.selectedBrief = null;
  state.page = "readings";
  if (state.timer) clearInterval(state.timer);
}

const ReadingsPage = {
  view() {
    const isWriter = state.user?.role === "writer";
    const s = liveSummary(state.rows);
    return [
      m("div.card.summary-card", [
        m("strong", "在线汇总（实时）"),
        m("span.summary-item", ["合格 ", m("em.pass", s.pass), " 条"]),
        m("span.summary-item", ["越界 ", m("em.fail", s.fail), " 条"]),
        m("span.summary-item", ["候审 ", m("em.wait", s.pending), " 条"]),
        m("span.sub-note", "随新办结自动变化，不影响已生成的交班简报。"),
      ]),
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
  },
};

const BriefsPage = {
  oninit() {
    loadBriefs();
  },
  view() {
    const isWriter = state.user?.role === "writer";
    return [
      m("div.card", [
        m("div.brief-head", [
          m("h2", { style: { margin: 0, fontSize: "1.1rem" } }, "交班简报"),
          isWriter
            ? m(
                "button",
                {
                  type: "button",
                  disabled: state.generating,
                  onclick: generateBrief,
                },
                state.generating ? "生成中…" : "一键生成交班简报"
              )
            : m("span.readonly-note", "复核侧仅可翻阅简报，不能生成。"),
        ]),
        m(
          "p.sub",
          { style: { margin: "0.5rem 0 0" } },
          "生成瞬间冻结合格量、越界量、候审量与最近办结摘要；此后新办结只影响在线汇总，旧简报正文不再变化。"
        ),
        state.briefError ? m("p.err", state.briefError) : null,
      ]),
      m("div.brief-layout", [
        m("div.card.brief-history", [
          m("h3", { style: { marginTop: 0 } }, "历史简报"),
          state.briefs.length
            ? m(
                "ul.brief-list",
                state.briefs.map((b) =>
                  m(
                    "li",
                    {
                      key: b.id,
                      class:
                        state.selectedBrief?.id === b.id ? "selected" : "",
                      onclick: () => openBrief(b.id),
                    },
                    [
                      m("div.brief-list-title", `#${b.id} 交班简报`),
                      m("div.brief-list-time", formatTime(b.created_at)),
                      m(
                        "div.brief-list-counts",
                        `合格 ${b.pass_count} · 越界 ${b.fail_count} · 候审 ${b.pending_count}`
                      ),
                    ]
                  )
                )
              )
            : m("p.sub", "暂无简报"),
        ]),
        m("div.card.brief-body-card", [
          state.selectedBrief
            ? [
                m("div.brief-body-head", [
                  m(
                    "h3",
                    { style: { margin: 0 } },
                    `#${state.selectedBrief.id} 交班简报（只读）`
                  ),
                  m(
                    "span.tag.wait",
                    `生成于 ${formatTime(state.selectedBrief.created_at)} · ${state.selectedBrief.created_by}`
                  ),
                ]),
                m("pre.brief-body", state.selectedBrief.body),
              ]
            : m(
                "p.sub",
                { style: { margin: 0 } },
                isWriter
                  ? "点击“一键生成交班简报”生成首份简报，或从左侧翻阅历史简报。"
                  : "从左侧选择一份历史简报翻阅。"
              ),
        ]),
      ]),
    ];
  },
};

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
      return m(
        "div.wrap",
        [
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
        ]
      );
    }

    const isWriter = state.user?.role === "writer";

    return m("div.wrap", [
      m("div.topbar", [
        m("div", [
          m("h1", "桥梁应变班交台"),
          m("p.sub", "微应变 80～220 με 为合格，否则为越界。"),
        ]),
        m("div.topbar-right", [
          m("nav.tabs", [
            m(
              "button.tab",
              {
                type: "button",
                class: state.page === "readings" ? "active" : "",
                onclick: () => {
                  state.page = "readings";
                },
              },
              "读数台"
            ),
            m(
              "button.tab",
              {
                type: "button",
                class: state.page === "briefs" ? "active" : "",
                onclick: () => {
                  state.page = "briefs";
                  loadBriefs();
                },
              },
              "交班简报"
            ),
          ]),
          m("div.user-line", [
            `${state.user?.username}（${isWriter ? "测量员" : "复核员"}） `,
            m(
              "button.secondary",
              { type: "button", onclick: logout },
              "退出"
            ),
          ]),
        ]),
      ]),
      state.page === "briefs" ? m(BriefsPage) : m(ReadingsPage),
    ]);
  },
};

export default App;
