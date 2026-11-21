# -*- coding: utf-8 -*-
"""四川麻将（血战到底）规则引擎 —— 4 人、108 张、定缺、摸打、胡牌结算。

v1 覆盖：定缺 / 摸打 / 自摸 / 点炮 / 血战到底 / 番型（平胡·对对胡·清一色·七对）/ 简单结算。
下一版补：碰、杠、抢杠胡、查叫。

牌编码：0..26 = (0万 1条 2筒) × 1..9
"""
import random

SUIT_CH = "万条筒"
ROOMS = {}


def tname(t):
    if t is None:
        return ""
    return "%d%s" % (t % 9 + 1, SUIT_CH[t // 9])


def new_wall():
    return [t for t in range(27) for _ in range(4)]


# ---------------- 胡牌判定 ----------------
def _sets_ok(cnt, need):
    if need == 0:
        return True
    for t in range(27):
        if cnt[t] <= 0:
            continue
        if cnt[t] >= 3:
            cnt[t] -= 3
            if _sets_ok(cnt, need - 1):
                cnt[t] += 3
                return True
            cnt[t] += 3
        if t % 9 <= 6 and cnt[t + 1] > 0 and cnt[t + 2] > 0:
            cnt[t] -= 1
            cnt[t + 1] -= 1
            cnt[t + 2] -= 1
            if _sets_ok(cnt, need - 1):
                cnt[t] += 1
                cnt[t + 1] += 1
                cnt[t + 2] += 1
                return True
            cnt[t] += 1
            cnt[t + 1] += 1
            cnt[t + 2] += 1
        break
    return False


def is_qidui(tiles):
    if len(tiles) != 14:
        return False
    cnt = [0] * 27
    for t in tiles:
        cnt[t] += 1
    return all(c in (0, 2) for c in cnt)


def is_hu(tiles, que):
    """tiles 含刚摸/点的第 14 张；que 为定缺花色（手牌不能有该花色）。"""
    if len(tiles) % 3 != 2:
        return False
    if que is not None and any(t // 9 == que for t in tiles):
        return False
    if is_qidui(tiles) and len(tiles) == 14:
        return True
    cnt = [0] * 27
    for t in tiles:
        cnt[t] += 1
    for p in range(27):
        if cnt[p] >= 2:
            cnt[p] -= 2
            if _sets_ok(cnt, len(tiles) // 3 - 1):
                cnt[p] += 2
                return True
            cnt[p] += 2
    return False


def fan_of(tiles, que, zimo):
    """很朴素的番型：七对 > 清一色 > 对对胡 > 平胡，自摸 +1。"""
    fan, name = 1, "平胡"
    if is_qidui(tiles):
        fan, name = 4, "七对"
    else:
        cnt = [0] * 27
        for t in tiles:
            cnt[t] += 1
        suits = {t // 9 for t in tiles}
        if len(suits) == 1:
            fan, name = 3, "清一色"
        elif all(c % 3 == 0 for c in cnt if c):
            fan, name = 2, "对对胡"
    if zimo:
        fan += 1
        name += "·自摸"
    return fan, name


# ---------------- 房间 ----------------
def new_room(host_id, host_name):
    rid = "m-" + "".join(random.choice("0123456789abcdef") for _ in range(8))
    room = {
        "id": rid, "game": "scmj", "host": host_id, "phase": "waiting",
        "players": [{"id": host_id, "name": host_name, "seat": 0, "bot": False,
                     "hand": [], "que": None, "done": False, "score": 0,
                     "win": None}],
        "wall": [], "turn": 0, "dealer": 0, "last": None, "log": [],
        "created": 0, "updated": 0,
    }
    ROOMS[rid] = room
    return room


def fill_bots(room):
    while len(room["players"]) < 4:
        seat = len(room["players"])
        room["players"].append({"id": "mjbot-%d" % (seat + 1), "name": "机器人·%d 号" % (seat + 1),
                                "seat": seat, "bot": True, "hand": [], "que": None,
                                "done": False, "score": 0, "win": None})


def start(room, now_ms):
    fill_bots(room)
    wall = new_wall()
    random.shuffle(wall)
    for p in room["players"]:
        p["hand"] = sorted(wall[:13])
        del wall[:13]
        p["que"] = None
        p["done"] = False
        p["score"] = 0
        p["win"] = None
    room["wall"] = wall
    room["phase"] = "dingque"
    room["dealer"] = 0
    room["turn"] = 0
    room["last"] = None
    room["log"] = ["发牌完成，请选一门定缺（手里不能留这门牌）"]
    room["updated"] = now_ms


def bot_que(p):
    cnt = [0, 0, 0]
    for t in p["hand"]:
        cnt[t // 9] += 1
    return cnt.index(min(cnt))


def set_que(room, seat, suit, now_ms):
    p = room["players"][seat]
    if p["que"] is not None or room["phase"] != "dingque":
        return False, "已经定缺了"
    p["que"] = int(suit)
    room["updated"] = now_ms
    if all(x["que"] is not None for x in room["players"]):
        room["phase"] = "play"
        room["log"].append("定缺完成，开始摸牌")
        draw(room, room["turn"], now_ms)
    return True, ""


def draw(room, seat, now_ms):
    """轮到 seat 摸牌；摸完能自摸就直接自摸。"""
    if not room["wall"]:
        end_game(room, now_ms)
        return False, "牌墙空了"
    t = room["wall"].pop(0)
    p = room["players"][seat]
    p["hand"].append(t)
    p["hand"].sort()
    room["turn"] = seat
    if is_hu(p["hand"], p["que"]):
        hu(room, seat, True, None, now_ms)
        return True, "zimo"
    room["updated"] = now_ms
    return True, ""


def discard(room, seat, tile, now_ms):
    p = room["players"][seat]
    if room["phase"] != "play" or room["turn"] != seat:
        return False, "还没轮到你"
    if tile not in p["hand"]:
        return False, "手里没有这张牌"
    p["hand"].remove(tile)
    room["last"] = {"seat": seat, "tile": tile}
    room["log"].append("%s 打出 %s" % (p["name"], tname(tile)))
    room["updated"] = now_ms
    # 点炮：按座位顺序找第一个能胡的（血战：可以多人胡，这里先取第一个）
    for off in range(1, 4):
        q = room["players"][(seat + off) % 4]
        if q["done"]:
            continue
        if is_hu(q["hand"] + [tile], q["que"]):
            hu(room, q["seat"], False, seat, now_ms)
            break
    if room["phase"] == "over":
        return True, ""
    # 下一家摸牌
    nxt = (seat + 1) % 4
    for _ in range(4):
        if not room["players"][nxt]["done"]:
            break
        nxt = (nxt + 1) % 4
    draw(room, nxt, now_ms)
    return True, ""


def hu(room, seat, zimo, from_seat, now_ms):
    p = room["players"][seat]
    tiles = p["hand"] if zimo else p["hand"] + [room["last"]["tile"]]
    fan, name = fan_of(tiles, p["que"], zimo)
    p["done"] = True
    p["win"] = name
    # 结算要守恒：谁付谁收都按实际付的人数算，别凭空造分
    if zimo:
        payers = [o for o in room["players"] if o["seat"] != seat and not o["done"]]
        for o in payers:
            o["score"] -= fan
        p["score"] += fan * len(payers)
    elif from_seat is not None:
        room["players"][from_seat]["score"] -= fan
        p["score"] += fan
    room["log"].append("%s %s %s（%d 番）" % (p["name"], "自摸" if zimo else "胡",
                                            name, fan))
    room["last"] = None
    room["updated"] = now_ms
    left = [x for x in room["players"] if not x["done"]]
    if len(left) <= 1:
        end_game(room, now_ms)


def end_game(room, now_ms):
    room["phase"] = "over"
    room["log"].append("本局结束")
    room["updated"] = now_ms


def auto_bot(room, now_ms):
    """轮到机器人：定缺、摸打都自动走。"""
    guard = 0
    while room["phase"] in ("dingque", "play") and guard < 200:
        guard += 1
        if room["phase"] == "dingque":
            # 只替机器人定缺；真人必须自己选，选完才开始摸打
            pending = [p for p in room["players"] if p["que"] is None and p["bot"]]
            if not pending:
                break
            p = pending[0]
            set_que(room, p["seat"], bot_que(p), now_ms)
            continue
        p = room["players"][room["turn"]]
        if not p["bot"]:
            break
        tile = choose_discard(p)
        if tile is None:
            break
        discard(room, p["seat"], tile, now_ms)


def choose_discard(p):
    """先打缺门牌；否则打最孤立的牌（同牌少、无相邻）。"""
    hand = p["hand"]
    if not hand:
        return None
    que = p["que"]
    que_tiles = [t for t in hand if t // 9 == que]
    if que_tiles:
        return que_tiles[0]
    cnt = {}
    for t in hand:
        cnt[t] = cnt.get(t, 0) + 1
    best, best_score = hand[0], 999
    for t in hand:
        score = cnt[t] * 3
        if (t - 1) in cnt:
            score += 2
        if (t + 1) in cnt:
            score += 2
        if (t + 2) in cnt or (t - 2) in cnt:
            score += 1
        if score < best_score:
            best, best_score = t, score
    return best


def view(room, pid):
    me = next((p for p in room["players"] if p["id"] == pid), None)
    return {
        "ok": True, "id": room["id"], "game": room["game"], "phase": room["phase"],
        "seat": me["seat"] if me else -1,
        "turn": room["turn"], "dealer": room["dealer"],
        "wall": len(room["wall"]), "last": room["last"],
        "players": [{
            "id": p["id"], "name": p["name"], "seat": p["seat"], "bot": p["bot"],
            "count": len(p["hand"]), "que": p["que"], "done": p["done"],
            "score": p["score"], "win": p["win"],
        } for p in room["players"]],
        "hand": list(me["hand"]) if me else [],
        "log": room["log"][-8:], "updated": room["updated"],
    }
