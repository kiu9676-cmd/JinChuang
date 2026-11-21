/* net.js — WebSocket 联机层（协议见需求规格 §3）
   房主：权威推进局面并把 state 广播给同房所有人；客人：只发 action，等 state。
   局面经中继同步，手牌仅发给对应座位；连接中断时报告状态并重连。 */
(function (root, factory) {
  var mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.MJ = root.MJ || {};
  root.MJ.Net = mod;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var E = (typeof module !== 'undefined' && module.exports)
    ? require('./engine.js')
    : ((typeof window !== 'undefined' ? window : globalThis).MJ.Engine);

  function create(opts) {
    opts = opts || {};
    var self = {
      room: String(opts.room || '0000'),
      seat: opts.seat === 'auto' ? 'auto' : Number(opts.seat),
      name: String(opts.name || '玩家'), avatarKey:normalizeAvatar(opts.avatarKey),
      host: String(opts.host || ''),
      port: Number(opts.port) || 8765,
      isHost: !!opts.isHost,
      game: opts.game || null,
      mode: 'waiting',                 // waiting | online | local
      onSeated: opts.onSeated || function () {},
      onState: opts.onState || function () {},
      onError: opts.onError || function () {},
      onBye: opts.onBye || function () {},
      onStatus: opts.onStatus || function () {},
      onJoin: opts.onJoin || function () {},
      onProfile: opts.onProfile || function () {},
      onHostApplied: opts.onHostApplied || function () {},
      onRoomFull: opts.onRoomFull || function () {},
      onStart: opts.onStart || function () {},
      _ws: null, _closed: false, _retry: 0, _retryTimer: null, _connectTimer: null, _everSeated:false,
      _queue: [], _hostSeq: 1000000000, _actionSeq: Date.now(),
      humanSeats: {}, _detached: false
    };
    if (self.isHost) self.humanSeats[self.seat] = self.name;

    function wsUrl() {
      var q = 'room=' + encodeURIComponent(self.room) +
        '&seat=' + encodeURIComponent(String(self.seat)) +
        '&name=' + encodeURIComponent(self.name) + '&avatar=' + encodeURIComponent(self.avatarKey);
      return 'ws://' + self.host + ':' + self.port + '/ws/game?' + q;
    }

    function send(obj) {
      var text;
      try { text = JSON.stringify(obj); } catch (e) { return false; }
      if (text.length > 60000) return false;                 // 单帧 < 64KB
      if (self.mode === 'online' && self._ws && self._ws.readyState === 1) {
        try { self._ws.send(text); return true; } catch (e) { return false; }
      }
      if (self._queue.length < 24) self._queue.push(text);  // 断线期间缓存少量动作
      return false;
    }
    function flush() {
      var q = self._queue.slice(); self._queue = [];
      for (var i = 0; i < q.length; i++) {
        try { self._ws.send(q[i]); } catch (e) {}
      }
    }

    function status(text, kind) {
      self.mode = kind || self.mode;
      self.onStatus(text, kind);
    }

    function clearConnectTimer() {
      if (self._connectTimer) clearTimeout(self._connectTimer);
      self._connectTimer = null;
    }

    function connect() {
      if (self._closed || self._detached || self._ws) return;
      var WS = (typeof window !== 'undefined') ? window.WebSocket : null;
      if (!WS || !self.host || self.host === '0.0.0.0') {
        self.onError('NETWORK_UNAVAILABLE');
        return;
      }
      var ws;
      try { ws = new WS(wsUrl()); }
      catch (e) { self.onError('NETWORK_UNAVAILABLE'); return; }
      self._ws = ws;  // 即使还在握手，退出联机时也能关闭这条连接
      self._connectTimer = setTimeout(function () {
        if (self._ws === ws && self.mode !== 'online') ws.close();
      }, 4200);
      ws.onmessage = function (ev) {
        if (self._ws !== ws || self._closed || self._detached) return;
        var m;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        handle(m);
      };
      ws.onclose = function () {
        if (self._ws !== ws || self._closed || self._detached) return;
        clearConnectTimer();
        self._ws = null;
        if (!self._everSeated && self._retry >= 1) {
          self.onError('NETWORK_UNAVAILABLE');
          detach();
          return;
        }
        markDisconnected(); scheduleRetry();
      };
    }

    function markDisconnected() {
      status(self.isHost ? '联机暂时中断' : '等待房主…','waiting');
    }

    function scheduleRetry() {
      if (self._closed || self._detached || self._retryTimer) return;
      var delay = Math.min(1000 * Math.pow(2, self._retry), 5000);
      self._retry++;
      // 客人持续掉线超过 60 秒：视为房主已离开，回大厅（60 秒内仍可回原座）
      if (!self.isHost && !self._awayTimer) {
        self._awayTimer = setTimeout(function () {
          self._awayTimer = null;
          self.onBye('host_left', -1);
          detach();
        }, 60000);
      }
      // 房主在单机模式下降低重连频率，不阻塞本地对局
      if (self.isHost && self._retry > 3) delay = 15000;
      self._retryTimer = setTimeout(function () {
        self._retryTimer = null;
        connect();
      }, delay);
    }

    function handle(m) {
      if (m && m.t === 'start') { self.onStart(m); return; }
      if (!m || typeof m !== 'object') return;
      switch (m.t) {
        case 'seated':
          if (m.room !== self.room || !Number.isInteger(m.seat) || m.seat < 0 || m.seat > 3 ||
              (self.isHost ? m.seat !== 0 : m.seat === 0)) return;
          self.seat = m.seat;
          self._everSeated = true;
          self._retry = 0;
          clearConnectTimer();
          if (self._awayTimer) { clearTimeout(self._awayTimer); self._awayTimer = null; }
          self.onSeated(m.seat);
          status('已联机 · 房间 ' + self.room, 'online');
          flush();
          if (self.isHost) broadcastState();
          break;
        case 'state':
          if (self.isHost || self.mode !== 'online') return;
          if (m.to != null && Number(m.to) !== self.seat) return;  // 别人的私有帧
          if (m.to == null && m.view && m.view.phase !== 'init') return;
          self.onState(m.view || {}, m.private || null);
          break;
        case 'action':
          if (!self.isHost) return;                   // 客人不处理 action
          if (Number(m.seat) === self.seat) return;   // 自己的回显
          applyRemote(m);
          break;
        case 'join':
          if (self.isHost) onJoin(m);
          break;
        case 'profile':
          if (self.isHost && self.game && self.humanSeats[m.seat] && self.game.players[m.seat].online) {
            var name = String(m.name || '').trim().slice(0,24);
            if (name) {
              self.humanSeats[m.seat] = name;
              E.setPlayer(self.game,Number(m.seat),{name:name,avatarKey:normalizeAvatar(m.avatarKey)});
              self.onProfile(); broadcastState();
            }
          }
          break;
        case 'error':
          if (m.to != null && Number(m.to) !== self.seat && !self.isHost) return;
          self.onError(m.code || 'INVALID_ACTION', m.msg);
          if (m.fatal) detach();
          break;
        case 'bye':
          if (m.reason === 'host_left') {
            self.onBye('host_left', m.seat);
            detach();
          } else {
            self.onBye(m.reason || 'leave', m.seat);
          }
          break;
        default: break;
      }
    }

    function onJoin(m) {
      if (!self.game) return;
      if (m.room && String(m.room) !== self.room) {
        send({ t: 'error', code: 'ROOM_NOT_FOUND', msg: '房间不存在', to: m.seat });
        return;
      }
      var seat = Number(m.seat);
      if (!(seat >= 0 && seat <= 3)) return;
      var joinName = String(m.name || ('玩家' + (seat + 1)));
      var prev = self.humanSeats[seat];
      if (prev && prev !== joinName && self.game.players[seat].online) {
        send({ t: 'error', code: 'ROOM_FULL', msg: '房间已满', to: m.seat });
        self.onRoomFull(seat);
        return;
      }
      var wasOnline = self.game.players[seat].online && self.game.players[seat].name === joinName;
      self.humanSeats[seat] = joinName;
      // 60 秒内 room+seat 回原座：保留席位与手牌，取消 AI 托管
      var restored = E.setReconnected(self.game, seat, joinName);
      if (!restored) {
        send({ t: 'error', code: 'ROOM_FULL', msg: '该席位已退出本局', to: m.seat });
        delete self.humanSeats[seat];
        return;
      }
      E.setPlayer(self.game, seat, { online:true, ai:false, name:joinName, avatarKey:normalizeAvatar(m.avatarKey) });
      if (!wasOnline) self.onJoin(seat, joinName);
      broadcastState();   // 立即补发全量 state，刷新也能回原座
    }

    /* 房主权威：收到客人 action → 推进 → 广播 */
    function applyRemote(msg) {
      if (!self.game) return { ok: false, code: 'NOT_HOST', msg: '本机不是房主' };
      var res = E.applyAction(self.game, {
        t: 'action', seq: Number(msg.seq), seat: Number(msg.seat), action: msg.action || {}
      });
      if (!res.ok) {
        send({ t: 'error', code: res.code || 'INVALID_ACTION', msg: res.msg || '非法操作', to: Number(msg.seat) });
        return res;
      }
      self.onHostApplied(res, msg);
      broadcastState();
      return res;
    }

    /* 房主本地动作（同一入口，便于统一广播） */
    function hostApply(action) {
      var msg = { t: 'action', seq: ++self._hostSeq, seat: self.seat, action: action };
      var res = E.applyAction(self.game, msg);
      if (!res.ok) { self.onError(res.code, res.msg); return res; }
      self.onHostApplied(res, msg);
      broadcastState();
      return res;
    }

    /* 广播：一条公共 view（供邀请卡/所有人）+ 每位真人一条私有视图（按 to 过滤） */
    function broadcastState() {
      if (!self.game || !self.isHost) return;
      if (!self._ws || self._ws.readyState !== 1) return;   // 单机模式不广播
      var g = self.game;
      var pub = E.getView(g, null);
      send({ t: 'state', seq: g.seq, view: pub });
      for (var s = 0; s < 4; s++) {
        if (s === self.seat) continue;
        var p = g.players[s];
        if (!p.online || p.ai) continue;
        var v = E.getView(g, s);
        send({
          t: 'state', seq: g.seq, view: pub, to: s,
          private: { hand: v.hand, myOptions: v.myOptions, myKongs: v.myKongs, myWin: v.myWin, myDrawn: v.myDrawn }
        });
      }
    }

    /* 客人：只发 action，等 state */
    function sendAction(action) {
      return send({ t: 'action', seq: ++self._actionSeq, seat: self.seat, action: action });
    }

    function hostSendBye(reason) {
      send({ t: 'bye', reason: reason || 'host_left' });
    }
    function hostSendError(seat, code, msg) {
      send({ t: 'error', code: code, msg: msg, to: seat });
    }

    function detach() {
      self._detached = true;
      if (self._retryTimer) { clearTimeout(self._retryTimer); self._retryTimer = null; }
      if (self._awayTimer) { clearTimeout(self._awayTimer); self._awayTimer = null; }
      clearConnectTimer();
      self._queue = [];
      var ws = self._ws;
      self._ws = null;
      if (ws && ws.readyState < 2) ws.close();
    }
    function close() {
      self._closed = true;
      detach();
    }

    self.updateProfile = function(name,avatarKey) {
      self.name = name;
      self.avatarKey = avatarKey;
      if (self.isHost) {
        self.humanSeats[self.seat] = name;
        broadcastState();
      } else send({t:'profile',name:name,avatarKey:avatarKey});
    };
    self.connect = connect;
    self.send = send;
    self.sendAction = sendAction;
    self.hostApply = hostApply;
    self.broadcastState = broadcastState;
    self.hostSendBye = hostSendBye;
    self.hostSendError = hostSendError;
    self.detach = detach;
    self.close = close;
    self.status = status;
    return self;
  }

  return { create: create, ERRORS: ['NOT_YOUR_TURN', 'INVALID_ACTION', 'ROOM_FULL', 'ROOM_NOT_FOUND', 'NOT_HOST'] };
});
