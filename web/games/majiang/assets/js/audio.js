/* audio.js — Web Audio 程序化音效：零音频文件、零网络请求、总体积 0KB
   首次用户手势后才创建 AudioContext（自动播放策略）。默认音效开、BGM 关。 */
(function (root, factory) {
  var mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.MJ = root.MJ || {};
  root.MJ.Audio = mod;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var ctx = null, master = null, noiseBuf = null;
  var muted = false, bgmOn = false, bgmNodes = [];

  function supported() {
    return typeof window !== 'undefined' && !!(window.AudioContext || window.webkitAudioContext);
  }

  function makeNoise() {
    var len = Math.floor(ctx.sampleRate * 0.25);
    var b = ctx.createBuffer(1, len, ctx.sampleRate), d = b.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * 0.6;
    return b;
  }

  /* 必须在用户点击/按键事件里调用一次 */
  function unlock() {
    if (!supported()) return false;
    try {
      if (!ctx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = muted ? 0 : 0.9;
        master.connect(ctx.destination);
        noiseBuf = makeNoise();
      }
      if (ctx.state === 'suspended') { var p = ctx.resume(); if (p && p.catch) p.catch(function () {}); }
      if (bgmOn && !bgmNodes.length) startBgm();
      return true;
    } catch (e) { return false; }
  }

  function envelope(gainNode, t0, attack, decay, peak) {
    var g = gainNode.gain;
    g.setValueAtTime(0.0001, t0);
    g.exponentialRampToValueAtTime(peak, t0 + attack);
    g.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  }

  function tone(freq, t0, dur, type, vol, glideTo) {
    if (!ctx || muted) return;
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t0);
    if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t0 + dur);
    envelope(g, t0, 0.008, dur, vol || 0.2);
    o.connect(g); g.connect(master);
    o.start(t0); o.stop(t0 + dur + 0.04);
    o.onended = function () { try { o.disconnect(); g.disconnect(); } catch (e) {} };
  }

  function noise(t0, dur, vol) {
    if (!ctx || muted || !noiseBuf) return;
    var s = ctx.createBufferSource(), g = ctx.createGain(), f = ctx.createBiquadFilter();
    s.buffer = noiseBuf;
    f.type = 'bandpass'; f.frequency.value = 1350; f.Q.value = 0.8;
    envelope(g, t0, 0.004, dur, vol || 0.12);
    s.connect(f); f.connect(g); g.connect(master);
    s.start(t0); s.stop(t0 + dur + 0.02);
    s.onended = function () { try { s.disconnect(); f.disconnect(); g.disconnect(); } catch (e) {} };
  }

  function play(name) {
    if (!ctx || muted) return;
    var t = ctx.currentTime + 0.01;
    switch (name) {
      case 'deal':
        for (var i = 0; i < 3; i++) tone(720 + i * 95, t + i * 0.042, 0.035, 'triangle', 0.09);
        noise(t, 0.05, 0.05); break;
      case 'draw': tone(540, t, 0.075, 'sine', 0.13, 700); break;
      case 'discard': noise(t, 0.09, 0.15); tone(190, t, 0.10, 'triangle', 0.15, 115); break;
      case 'peng': tone(150, t, 0.16, 'sine', 0.21, 105); tone(300, t + 0.03, 0.14, 'triangle', 0.10); break;
      case 'gang': tone(105, t, 0.23, 'sine', 0.25, 78); tone(215, t + 0.04, 0.18, 'triangle', 0.11); noise(t, 0.12, 0.08); break;
      case 'win': [523, 659, 784, 1047].forEach(function (f, i) { tone(f, t + i * 0.11, 0.28, 'triangle', 0.17); }); break;
      case 'tick': tone(1050, t, 0.045, 'square', 0.05); break;
      case 'lack': tone(430, t, 0.09, 'sine', 0.12, 520); break;
      case 'settle': [392, 494, 587].forEach(function (f, i) { tone(f, t + i * 0.09, 0.30, 'sine', 0.11); }); break;
      default: break;
    }
  }

  function startBgm() {
    if (!ctx || bgmNodes.length) return;
    var freqs = [130.81, 196.00, 261.63];
    for (var i = 0; i < freqs.length; i++) {
      (function (f, idx) {
        var o = ctx.createOscillator(), g = ctx.createGain();
        var lfo = ctx.createOscillator(), lg = ctx.createGain();
        o.type = 'sine'; o.frequency.value = f;
        g.gain.value = 0.022 / (idx + 1);
        lfo.frequency.value = 0.11 + idx * 0.045;
        lg.gain.value = 0.007;
        lfo.connect(lg); lg.connect(g.gain);
        o.connect(g); g.connect(master);
        o.start(); lfo.start();
        bgmNodes.push({ o: o, g: g, lfo: lfo, lg: lg });
      })(freqs[i], i);
    }
  }
  function stopBgm() {
    for (var i = 0; i < bgmNodes.length; i++) {
      var n = bgmNodes[i];
      try {
        n.o.stop(); n.lfo.stop();
        n.o.disconnect(); n.g.disconnect(); n.lfo.disconnect(); n.lg.disconnect();
      } catch (e) {}
    }
    bgmNodes = [];
  }
  function setMuted(v) {
    muted = !!v;
    if (master) master.gain.value = muted ? 0 : 0.9;
  }
  function setBgm(v) {
    bgmOn = !!v;
    if (!ctx) return;
    if (bgmOn) startBgm(); else stopBgm();
  }
  function state() { return { muted: muted, bgmOn: bgmOn, unlocked: !!ctx, supported: supported() }; }

  return { unlock: unlock, play: play, setMuted: setMuted, setBgm: setBgm, state: state };
});
