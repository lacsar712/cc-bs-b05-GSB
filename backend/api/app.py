import os
from datetime import datetime, timedelta, timezone

import jwt
from passlib.context import CryptContext
from psycopg.types.json import Json
from sanic import Sanic
from sanic.response import json as sanic_json

from db import create_pool, ensure_schema, seed_if_empty

RECENT_DONE_LIMIT = 5

SECRET = os.environ.get("JWT_SECRET", "bridge-strain-dev-secret")
pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")

USERS = {
    "surveyor": {"role": "writer", "password_hash": pwd.hash("surv123456")},
    "reviewer": {"role": "reader", "password_hash": pwd.hash("rev123456")},
}

app = Sanic("bridge-strain-shift")


def _auth_header(request) -> str | None:
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:].strip()
    return None


def _decode_user(token: str | None) -> dict | None:
    if not token:
        return None
    try:
        payload = jwt.decode(token, SECRET, algorithms=["HS256"])
    except jwt.InvalidTokenError:
        return None
    sub = payload.get("sub")
    if sub not in USERS:
        return None
    return {"username": sub, "role": payload.get("role")}


def _require_user(request) -> dict:
    user = _decode_user(_auth_header(request))
    if not user:
        return None
    return user


def _iso(dt) -> str | None:
    if dt is None:
        return None
    return dt.isoformat()


def _fmt_dt(dt) -> str:
    if dt is None:
        return "—"
    return dt.strftime("%Y-%m-%d %H:%M:%S")


def _render_briefing_body(
    briefing_id: int,
    created_at,
    created_by: str,
    stats: dict,
    recent_done: list[dict],
) -> str:
    """用生成瞬间的同一份统计结果渲染只读正文，保证正文与统计同源。"""
    lines = [
        f"交班简报 第 {briefing_id} 期",
        f"生成时间：{_fmt_dt(created_at)}",
        f"生成人：{created_by}",
        "",
        f"合格量：{stats['pass_count']} 笔",
        f"越界量：{stats['fail_count']} 笔",
        f"候审量：{stats['pending_count']} 笔",
        "",
        f"最近办结（{len(recent_done)} 笔）：",
    ]
    if recent_done:
        for i, r in enumerate(recent_done, 1):
            ts = str(r.get("processed_at") or "")[:19].replace("T", " ") or "—"
            lines.append(
                f"{i}. {r['span_code']} · {float(r['microstrain']):g} με · "
                f"{r['verdict']} · 办结于 {ts}"
            )
    else:
        lines.append("（暂无办结记录）")
    lines += [
        "",
        "—— 本简报为生成瞬间快照，此后新办结不影响本正文 ——",
    ]
    return "\n".join(lines)


@app.before_server_start
async def setup(_app, _loop):
    pool = await create_pool()
    _app.ctx.pool = pool
    await ensure_schema(pool)
    await seed_if_empty(pool)


@app.after_server_stop
async def teardown(_app, _loop):
    pool = _app.ctx.pool
    if pool:
        await pool.close()


@app.get("/api/health")
async def health(_request):
    return sanic_json({"status": "ok", "service": "bridge-strain-shift"})


@app.post("/api/auth/login")
async def login(request):
    body = request.json or {}
    username = str(body.get("username", "")).strip()
    password = str(body.get("password", ""))
    user = USERS.get(username)
    if not user or not pwd.verify(password, user["password_hash"]):
        return sanic_json({"detail": "用户名或密码错误"}, status=401)
    exp = datetime.now(timezone.utc) + timedelta(hours=8)
    token = jwt.encode(
        {"sub": username, "role": user["role"], "exp": exp},
        SECRET,
        algorithm="HS256",
    )
    return sanic_json(
        {"access_token": token, "username": username, "role": user["role"]}
    )


@app.get("/api/readings")
async def list_readings(request):
    if not _require_user(request):
        return sanic_json({"detail": "未登录"}, status=401)
    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT id, span_code, microstrain, verdict, reason, status,
                       created_by, created_at, processed_at
                FROM strain_readings
                ORDER BY id DESC
                """
            )
            rows = await cur.fetchall()
    out = []
    for r in rows:
        out.append(
            {
                "id": r["id"],
                "span_code": r["span_code"],
                "microstrain": r["microstrain"],
                "verdict": r["verdict"],
                "reason": r["reason"],
                "status": r["status"],
                "created_by": r["created_by"],
                "created_at": _iso(r["created_at"]),
                "processed_at": _iso(r["processed_at"]),
            }
        )
    return sanic_json(out)


@app.post("/api/readings")
async def create_reading(request):
    user = _require_user(request)
    if not user:
        return sanic_json({"detail": "未登录"}, status=401)
    if user["role"] != "writer":
        return sanic_json({"detail": "仅测量员可提交应变读数"}, status=403)
    body = request.json or {}
    span_code = str(body.get("span_code", "")).strip()
    if not span_code:
        return sanic_json({"detail": "跨段编号不能为空"}, status=400)
    try:
        microstrain = float(body.get("microstrain"))
    except (TypeError, ValueError):
        return sanic_json({"detail": "微应变必须是数字"}, status=400)

    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO strain_readings (span_code, microstrain, status, created_by, created_at)
                VALUES (%s, %s, 'pending', %s, now())
                RETURNING id, span_code, microstrain, verdict, reason, status,
                          created_by, created_at, processed_at
                """,
                (span_code, microstrain, user["username"]),
            )
            row = await cur.fetchone()
        await conn.commit()

    return sanic_json(
        {
            "id": row["id"],
            "span_code": row["span_code"],
            "microstrain": row["microstrain"],
            "verdict": row["verdict"],
            "reason": row["reason"],
            "status": row["status"],
            "created_by": row["created_by"],
            "created_at": _iso(row["created_at"]),
            "processed_at": None,
            "message": "已入队，后台工人将认领并判定",
        },
        status=201,
    )


@app.post("/api/briefings")
async def create_briefing(request):
    user = _require_user(request)
    if not user:
        return sanic_json({"detail": "未登录"}, status=401)
    if user["role"] != "writer":
        return sanic_json({"detail": "仅测量员可生成交班简报"}, status=403)

    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            # 单条 SQL 取同一快照：合格/越界/候审统计与最近办结摘要同源
            await cur.execute(
                """
                WITH stats AS (
                    SELECT
                        COUNT(*) FILTER (WHERE verdict = '合格') AS pass_count,
                        COUNT(*) FILTER (WHERE verdict = '越界') AS fail_count,
                        COUNT(*) FILTER (WHERE status IN ('pending', 'processing'))
                            AS pending_count
                    FROM strain_readings
                ),
                recent AS (
                    SELECT id, span_code, microstrain, verdict, processed_at
                    FROM strain_readings
                    WHERE status = 'done'
                    ORDER BY id DESC
                    LIMIT %s
                )
                SELECT
                    stats.pass_count,
                    stats.fail_count,
                    stats.pending_count,
                    COALESCE(
                        (SELECT jsonb_agg(to_jsonb(recent) ORDER BY recent.id DESC)
                         FROM recent),
                        '[]'::jsonb
                    ) AS recent_done
                FROM stats
                """,
                (RECENT_DONE_LIMIT,),
            )
            snap = await cur.fetchone()
            recent_done = snap["recent_done"]
            await cur.execute(
                """
                INSERT INTO shift_briefings
                    (created_by, pass_count, fail_count, pending_count, recent_done, body)
                VALUES (%s, %s, %s, %s, %s, '')
                RETURNING id, created_at
                """,
                (
                    user["username"],
                    snap["pass_count"],
                    snap["fail_count"],
                    snap["pending_count"],
                    Json(recent_done),
                ),
            )
            briefing = await cur.fetchone()
            body = _render_briefing_body(
                briefing["id"],
                briefing["created_at"],
                user["username"],
                snap,
                recent_done,
            )
            await cur.execute(
                "UPDATE shift_briefings SET body = %s WHERE id = %s",
                (body, briefing["id"]),
            )
        await conn.commit()

    return sanic_json(
        {
            "id": briefing["id"],
            "created_by": user["username"],
            "created_at": _iso(briefing["created_at"]),
            "pass_count": snap["pass_count"],
            "fail_count": snap["fail_count"],
            "pending_count": snap["pending_count"],
            "body": body,
            "message": "交班简报已生成，正文已冻结",
        },
        status=201,
    )


@app.get("/api/briefings")
async def list_briefings(request):
    if not _require_user(request):
        return sanic_json({"detail": "未登录"}, status=401)
    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT id, created_by, created_at,
                       pass_count, fail_count, pending_count
                FROM shift_briefings
                ORDER BY id DESC
                """
            )
            rows = await cur.fetchall()
    out = [
        {
            "id": r["id"],
            "created_by": r["created_by"],
            "created_at": _iso(r["created_at"]),
            "pass_count": r["pass_count"],
            "fail_count": r["fail_count"],
            "pending_count": r["pending_count"],
        }
        for r in rows
    ]
    return sanic_json(out)


@app.get("/api/briefings/<bid:int>")
async def get_briefing(request, bid: int):
    if not _require_user(request):
        return sanic_json({"detail": "未登录"}, status=401)
    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT id, created_by, created_at,
                       pass_count, fail_count, pending_count, body
                FROM shift_briefings
                WHERE id = %s
                """,
                (bid,),
            )
            row = await cur.fetchone()
    if not row:
        return sanic_json({"detail": "简报不存在"}, status=404)
    return sanic_json(
        {
            "id": row["id"],
            "created_by": row["created_by"],
            "created_at": _iso(row["created_at"]),
            "pass_count": row["pass_count"],
            "fail_count": row["fail_count"],
            "pending_count": row["pending_count"],
            "body": row["body"],
        }
    )
