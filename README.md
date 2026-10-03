# 桥梁应变班交台

测量员上报跨段编号与微应变读数，后台工人用 `FOR UPDATE SKIP LOCKED` 认领待处理队列，按 **80～220 με** 判定 **合格** 或 **越界**。

## 交班简报

顶栏「交班简报」专页一键生成只读简报：把生成瞬间的 **合格量 / 越界量 / 候审量** 与最近 5 笔办结摘要冻结进正文。统计与正文出自同一条 SQL 快照（同源），落库后正文不再变化——此后新办结只影响「读数汇总」页的在线汇总，旧简报数字保持生成时原样。

- 测量员（writer）：可生成、翻阅简报
- 复核员（reader）：仅可翻阅历史简报，不可生成

| 接口 | 说明 |
|------|------|
| `POST /api/briefings` | 生成交班简报（仅测量员），同事务取快照、渲染正文并落库 |
| `GET /api/briefings` | 历史简报列表（登录即可） |
| `GET /api/briefings/<id>` | 简报只读正文（登录即可） |

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
| surveyor | surv123456 | 测量员，可提交读数 |
| reviewer | rev123456 | 复核员，只读列表 |

## 启动

```bash
cd projects/19-bridge-strain-shift
docker compose up --build
```

健康检查：`GET http://localhost:8198/api/health` → `{"status":"ok","service":"bridge-strain-shift"}`

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
