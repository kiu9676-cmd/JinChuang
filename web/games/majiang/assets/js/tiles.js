/* tiles.js — 牌的定义、牌墙、洗牌与内联 SVG 牌面（无任何外部图片/字体） */
(function (root, factory) {
  var mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.MJ = root.MJ || {};
  root.MJ.Tiles = mod;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var KINDS = 27;          // 川麻仅万/条/筒 3 门 x 9 级 = 27 种（编号 0..26）
  var WALL_SIZE = 108;     // 每种 4 张 = 108 张，无字牌无花牌
  var SUIT_NAMES = ['万', '条', '筒'];
  var CN = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

  function suitOf(id) { return Math.floor(id / 9); }        // 0万 1条 2筒
  function rankOf(id) { return (id % 9) + 1; }              // 1..9
  function tileName(id) { return CN[rankOf(id)] + SUIT_NAMES[suitOf(id)]; }
  function isLack(id, lack) { return lack >= 0 && suitOf(id) === lack; }

  function makeWall() {
    var w = [];
    for (var i = 0; i < KINDS; i++) for (var k = 0; k < 4; k++) w.push(i);
    return w;
  }

  // 可注入 rng，便于复现与自动化测试
  function shuffle(arr, rng) {
    var r = rng || Math.random;
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(r() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  function sortHand(h) { return h.slice().sort(function (a, b) { return a - b; }); }
  function toCounts(hand) {
    var c = new Array(KINDS).fill(0);
    for (var i = 0; i < hand.length; i++) c[hand[i]]++;
    return c;
  }
  function countsToHand(c) {
    var h = [];
    for (var i = 0; i < KINDS; i++) for (var k = 0; k < c[i]; k++) h.push(i);
    return h;
  }
  function hasLack(hand, lack) {
    if (lack < 0) return false;
    for (var i = 0; i < hand.length; i++) if (suitOf(hand[i]) === lack) return true;
    return false;
  }
  function removeOne(hand, id) {
    var i = hand.indexOf(id);
    if (i < 0) return false;
    hand.splice(i, 1);
    return true;
  }

  // 条/筒的排布坐标（针对 52x76 的牌面）
  var LAYOUT = {
    1: [[26, 40]],
    2: [[16, 40], [36, 40]],
    3: [[10, 40], [26, 40], [42, 40]],
    4: [[16, 28], [36, 28], [16, 52], [36, 52]],
    5: [[16, 25], [36, 25], [26, 40], [16, 55], [36, 55]],
    6: [[16, 25], [36, 25], [16, 40], [36, 40], [16, 55], [36, 55]],
    7: [[12, 23], [26, 23], [40, 23], [12, 40], [26, 40], [40, 40], [26, 56]],
    8: [[12, 23], [26, 23], [40, 23], [12, 40], [26, 40], [40, 40], [19, 56], [33, 56]],
    9: [[12, 22], [26, 22], [40, 22], [12, 39], [26, 39], [40, 39], [12, 56], [26, 56], [40, 56]]
  };

  function corner(rank) {
    return '<text x="4" y="11" font-size="10" font-weight="700" fill="#9a8f72" ' +
      'font-family="Microsoft YaHei,PingFang SC,sans-serif">' + rank + '</text>';
  }

  // 万子：黑/墨绿汉字数字 + 红色「萬」
  function charsSVG(rank) {
    return corner(rank) +
      '<text x="26" y="38" text-anchor="middle" font-size="28" font-weight="700" fill="#1c3b4a" ' +
      'font-family="Songti SC,SimSun,STSong,Microsoft YaHei,serif">' + CN[rank] + '</text>' +
      '<text x="26" y="66" text-anchor="middle" font-size="20" font-weight="700" fill="#c0392b" ' +
      'font-family="Songti SC,SimSun,STSong,Microsoft YaHei,serif">萬</text>';
  }

  // 条子：竹节竖条；1 条特殊（雀鸟意象），9 条点缀红色
  function bamsSVG(rank) {
    var s = corner(rank);
    if (rank === 1) {
      s += '<ellipse cx="26" cy="42" rx="9" ry="15" fill="#2f8a5e" stroke="#145436" stroke-width="1.5"/>';
      s += '<path d="M26 27 Q34 34 26 42 Q18 34 26 27Z" fill="#d8483c"/>';
      s += '<circle cx="22" cy="37" r="2" fill="#f7f2e3"/><circle cx="30" cy="37" r="2" fill="#f7f2e3"/>';
      s += '<path d="M26 56 L20 64 M26 56 L32 64" stroke="#c0392b" stroke-width="2" fill="none"/>';
      return s;
    }
    var pos = LAYOUT[rank];
    for (var i = 0; i < pos.length; i++) {
      var x = pos[i][0], y = pos[i][1];
      var col = (rank === 9 && i % 3 === 1) ? '#c0392b' : (i % 2 ? '#3a9a68' : '#1f7050');
      s += '<rect x="' + (x - 3.5) + '" y="' + (y - 9) + '" width="7" height="18" rx="3.5" ' +
        'fill="' + col + '" stroke="#123f2c" stroke-width="1"/>';
      s += '<rect x="' + (x - 2) + '" y="' + (y - 3) + '" width="4" height="2" rx="1" fill="rgba(255,255,255,.45)"/>';
    }
    return s;
  }

  // 筒子：同心圆点；1 筒为大圆
  function dotsSVG(rank) {
    var s = corner(rank);
    if (rank === 1) {
      s += '<circle cx="26" cy="42" r="17" fill="#2b6f9c" stroke="#133f5c" stroke-width="2"/>';
      s += '<circle cx="26" cy="42" r="11" fill="none" stroke="#f7f2e3" stroke-width="2" opacity=".8"/>';
      s += '<circle cx="26" cy="42" r="5" fill="#d8483c"/>';
      return s;
    }
    var colors = ['#2b6f9c', '#c0392b', '#2f8a5e'];
    var pos = LAYOUT[rank], r = rank >= 7 ? 6.5 : 7.5;
    for (var i = 0; i < pos.length; i++) {
      var x = pos[i][0], y = pos[i][1];
      s += '<circle cx="' + x + '" cy="' + y + '" r="' + r + '" fill="' + colors[i % 3] +
        '" stroke="#123a4e" stroke-width="1"/>';
      s += '<circle cx="' + (x - r * 0.3) + '" cy="' + (y - r * 0.3) + '" r="' + (r * 0.28) +
        '" fill="rgba(255,255,255,.55)"/>';
    }
    return s;
  }

  function faceSVG(id) {
    if (id === undefined || id === null || id < 0) return '';
    var rank = rankOf(id), suit = suitOf(id);
    var body = suit === 0 ? charsSVG(rank) : (suit === 1 ? bamsSVG(rank) : dotsSVG(rank));
    return '<svg viewBox="0 0 52 76" preserveAspectRatio="xMidYMid meet" ' +
      'xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' + body + '</svg>';
  }

  /* 生成一张牌的 DOM 字符串。
     opts: {size, mine, lack, selected, drawn, dim, back, silent} */
  function tileHTML(id, opts) {
    opts = opts || {};
    var cls = ['tile'];
    var size = opts.size || 'normal';
    if (size !== 'normal') cls.push(size);
    if (opts.back) {
      cls.push('back');
      return '<div class="' + cls.join(' ') + '"></div>';
    }
    if (opts.mine) cls.push('mine');
    if (opts.lack) cls.push('lack');
    if (opts.selected) cls.push('selected');
    if (opts.drawn) cls.push('just-drawn');
    if (opts.dim) cls.push('dim');
    var badge = opts.lack ? '<span class="lack-badge">缺</span>' : '';
    return '<div class="' + cls.join(' ') + '" data-tile="' + id + '">' + badge + faceSVG(id) + '</div>';
  }

  // 碰/杠副的展示（tid 为主牌，n 为张数）
  function meldHTML(tid, n, type) {
    var out = '<div class="meld" title="' + (type || '') + '">';
    for (var i = 0; i < n; i++) out += tileHTML(tid, { size: 'tiny' });
    return out + '</div>';
  }

  return {
    KINDS: KINDS, WALL_SIZE: WALL_SIZE, SUIT_NAMES: SUIT_NAMES,
    suitOf: suitOf, rankOf: rankOf, tileName: tileName, isLack: isLack,
    makeWall: makeWall, shuffle: shuffle, sortHand: sortHand,
    toCounts: toCounts, countsToHand: countsToHand, hasLack: hasLack,
    removeOne: removeOne, faceSVG: faceSVG, tileHTML: tileHTML, meldHTML: meldHTML
  };
});
