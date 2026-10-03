import os
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import jwt
import psycopg
from passlib.context import CryptContext
from psycopg.types.json import Json
from sanic import Sanic
from sanic.response import json as sanic_json

from db import create_pool, ensure_schema, seed_if_empty

SECRET = os.environ.get("JWT_SECRET", "bridge-strain-dev-secret")
pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")

LOCAL_TZ = ZoneInfo("Asia/Shanghai")
RECENT_BRIEF_ITEMS = 10

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


def _brief_out(row) -> dict:
    return {
        "id": row["id"],
        "created_by": row["created_by"],
        "created_at": _iso(row["created_at"]),
        "pass_count": row["pass_count"],
        "fail_count": row["fail_count"],
        "pending_count": row["pending_count"],
        "recent_items": row["recent_items"],
        "body": row["body"],
    }


def _render_brief_body(created_at, counts: dict, recent_items: list) -> str:
    frozen_at = created_at.astimezone(LOCAL_TZ).strftime("%Y-%m-%d %H:%M:%S")
    lines = [
        "交班简报",
        f"生成时间：{frozen_at}",
        (
            "本班统计：合格 "
            f"{counts['pass']} 条，越界 {counts['fail']} 条，候审 {counts['pending']} 条。"
        ),
        f"最近办结（{len(recent_items)} 条）：",
    ]
    if recent_items:
        for item in recent_items:
            processed = item["processed_at"]
            if processed:
                dt = datetime.fromisoformat(processed).astimezone(LOCAL_TZ)
                processed_text = dt.strftime("%Y-%m-%d %H:%M")
            else:
                processed_text = "—"
            lines.append(
                f"- #{item['id']} {item['span_code']} {item['microstrain']:g}με"
                f" {item['verdict']}（{item['reason']}）"
                f" 办结于 {processed_text}，提交人 {item['created_by']}"
            )
    else:
        lines.append("- 暂无办结记录")
    lines.append("（本简报为生成瞬间冻结的只读快照，此后新办结不再改变本文。）")
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


@app.post("/api/briefs")
async def create_brief(request):
    user = _require_user(request)
    if not user:
        return sanic_json({"detail": "未登录"}, status=401)
    if user["role"] != "writer":
        return sanic_json({"detail": "仅测量员可生成交班简报"}, status=403)

    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        # REPEATABLE READ：计数与最近办结取自同一事务快照，保证正文与统计同源
        async with conn.transaction(
            isolation_level=psycopg.IsolationLevel.REPEATABLE_READ
        ):
            async with conn.cursor() as cur:
                await cur.execute("SELECT now() AS frozen_at")
                frozen_at = (await cur.fetchone())["frozen_at"]
                await cur.execute(
                    """
                    SELECT
                        count(*) FILTER (WHERE status = 'done' AND verdict = '合格') AS pass_count,
                        count(*) FILTER (WHERE status = 'done' AND verdict = '越界') AS fail_count,
                        count(*) FILTER (WHERE status IN ('pending', 'processing')) AS pending_count
                    FROM strain_readings
                    """
                )
                counts = await cur.fetchone()
                await cur.execute(
                    """
                    SELECT id, span_code, microstrain, verdict, reason,
                           created_by, created_at, processed_at
                    FROM strain_readings
                    WHERE status = 'done'
                    ORDER BY processed_at DESC, id DESC
                    LIMIT %s
                    """,
                    (RECENT_BRIEF_ITEMS,),
                )
                done_rows = await cur.fetchall()
                recent_items = [
                    {
                        "id": r["id"],
                        "span_code": r["span_code"],
                        "microstrain": r["microstrain"],
                        "verdict": r["verdict"],
                        "reason": r["reason"],
                        "created_by": r["created_by"],
                        "created_at": _iso(r["created_at"]),
                        "processed_at": _iso(r["processed_at"]),
                    }
                    for r in done_rows
                ]
                counts_map = {
                    "pass": counts["pass_count"],
                    "fail": counts["fail_count"],
                    "pending": counts["pending_count"],
                }
                body = _render_brief_body(frozen_at, counts_map, recent_items)
                await cur.execute(
                    """
                    INSERT INTO shift_briefs
                        (created_by, pass_count, fail_count, pending_count,
                         recent_items, body, created_at)
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
                    RETURNING id, created_by, created_at, pass_count, fail_count,
                              pending_count, recent_items, body
                    """,
                    (
                        user["username"],
                        counts_map["pass"],
                        counts_map["fail"],
                        counts_map["pending"],
                        Json(recent_items),
                        body,
                        frozen_at,
                    ),
                )
                row = await cur.fetchone()

    return sanic_json(_brief_out(row), status=201)


@app.get("/api/briefs")
async def list_briefs(request):
    if not _require_user(request):
        return sanic_json({"detail": "未登录"}, status=401)
    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT id, created_by, created_at, pass_count, fail_count,
                       pending_count, recent_items, body
                FROM shift_briefs
                ORDER BY id DESC
                """
            )
            rows = await cur.fetchall()
    return sanic_json([_brief_out(r) for r in rows])


@app.get("/api/briefs/<brief_id:int>")
async def get_brief(request, brief_id: int):
    if not _require_user(request):
        return sanic_json({"detail": "未登录"}, status=401)
    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT id, created_by, created_at, pass_count, fail_count,
                       pending_count, recent_items, body
                FROM shift_briefs
                WHERE id = %s
                """,
                (brief_id,),
            )
            row = await cur.fetchone()
    if not row:
        return sanic_json({"detail": "简报不存在"}, status=404)
    return sanic_json(_brief_out(row))
