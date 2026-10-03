# 桥梁应变班交台

测量员上报跨段编号与微应变读数，后台工人用 `FOR UPDATE SKIP LOCKED` 认领待处理队列，按 **80～220 με** 判定 **合格** 或 **越界**。

顶栏 **交班简报** 专页支持一键生成只读交班简报：测量员点击生成时，把当时的合格量、越界量、候审量与最近 10 条办结摘要冻结进简报正文；此后新办结只影响读数台的在线汇总，旧简报正文永不变化（统计与正文在同一 `REPEATABLE READ` 事务内取数，同源冻结）。复核员可翻阅历史简报但不能生成。

## 技术栈

| 层 | 选型 |
|----|------|
| 接口 | Python Sanic + psycopg（异步连接池） |
| 工人 | `worker.py`（psycopg 同步，`FOR UPDATE SKIP LOCKED`） |
| 页面 | Mithril.js + Vite，nginx 反代 `/api` |
| 数据库 | PostgreSQL 16 |

## 端口

| 服务 | 地址 |
|------|------|
| 页面 | http://localhost:3198 |
| 接口 | http://localhost:8198 |
| PostgreSQL | localhost:54398（库名 `bridgestrain`） |

## 账号

| 用户 | 密码 | 权限 |
|------|------|------|
| surveyor | surv123456 | 测量员，可提交读数、生成交班简报 |
| reviewer | rev123456 | 复核员，只读列表，可翻阅简报但不能生成 |

## 启动

```bash
cd projects/19-bridge-strain-shift
docker compose up --build
```

健康检查：`GET http://localhost:8198/api/health` → `{"status":"ok","service":"bridge-strain-shift"}`

交班简报接口（均需登录）：

| 方法与路径 | 权限 | 说明 |
|-----------|------|------|
| `POST /api/briefs` | 测量员 | 事务内冻结三项计数与最近办结，生成只读简报 |
| `GET /api/briefs` | 测量员/复核员 | 历史简报列表 |
| `GET /api/briefs/:id` | 测量员/复核员 | 单份简报冻结正文 |

## 种子数据

| 跨段 | 微应变 | 结论 |
|------|--------|------|
| 跨中S1 | 150 με | 合格 |
| 支座S2 | 40 με | 越界 |

## 本地开发（可选）

```bash
cd backend && pip install -r requirements.txt
python -m sanic api.app --host=0.0.0.0 --port=8000 --single-process
python worker.py
cd frontend && npm install && npm run dev
```

接口进程默认监听容器内 **8000**，对外映射 **8198**。
