// IPv4 and list helpers. No DOM, shared by the generator, simulator and UI.
(function (PL) {
  'use strict';

  function ip2n(s) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(s || '').trim());
    if (!m) return null;
    const p = m.slice(1).map(Number);
    if (p.some((x) => x > 255)) return null;
    return p[0] * 16777216 + p[1] * 65536 + p[2] * 256 + p[3];
  }

  function n2ip(n) {
    return [Math.floor(n / 16777216) % 256, Math.floor(n / 65536) % 256, Math.floor(n / 256) % 256, n % 256].join('.');
  }

  function lenToMaskN(len) {
    return len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
  }

  const lenToMask = (len) => n2ip(lenToMaskN(len));

  // Returns the prefix length, or null when the mask is not contiguous.
  function maskToLen(mask) {
    const n = ip2n(mask);
    if (n === null) return null;
    for (let len = 0; len <= 32; len++) if (lenToMaskN(len) === n) return len;
    return null;
  }

  // Accepts "255.255.255.0", "/24" or "24" and returns a dotted mask, or null.
  function normalizeMask(v) {
    const s = String(v || '').trim();
    const m = /^\/?(\d{1,2})$/.exec(s);
    if (m) return +m[1] <= 32 ? lenToMask(+m[1]) : null;
    return maskToLen(s) === null ? null : s;
  }

  const andN = (a, b) => (a & b) >>> 0;
  const notN = (a) => ~a >>> 0;

  function networkN(ip, mask) {
    return andN(ip2n(ip), ip2n(mask));
  }

  const network = (ip, mask) => n2ip(networkN(ip, mask));
  const broadcast = (ip, mask) => n2ip((networkN(ip, mask) | notN(ip2n(mask))) >>> 0);
  const wildcard = (mask) => n2ip(notN(ip2n(mask)));

  function inNet(ip, net, mask) {
    return networkN(ip, mask) === networkN(net, mask);
  }

  // Usable as a host address on this subnet? /31 and /32 have no reserved addresses.
  function isHostAddr(ip, mask) {
    const len = maskToLen(mask);
    if (len === null || ip2n(ip) === null) return false;
    if (len >= 31) return true;
    return ip !== network(ip, mask) && ip !== broadcast(ip, mask);
  }

  // The classful network, which is what a RIP "network" statement takes.
  function classfulNet(ip) {
    const first = Math.floor(ip2n(ip) / 16777216);
    const len = first < 128 ? 8 : first < 192 ? 16 : 24;
    return network(ip, lenToMask(len));
  }

  // Parses "10,20-25,99" into a sorted array of numbers.
  function expandList(s) {
    const out = new Set();
    String(s || '').split(',').forEach((part) => {
      const m = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part);
      if (!m) return;
      const a = +m[1];
      const b = m[2] ? +m[2] : a;
      for (let i = Math.min(a, b); i <= Math.max(a, b) && i <= 4094; i++) out.add(i);
    });
    return [...out].sort((x, y) => x - y);
  }

  // [10,11,12,20] becomes "10-12,20".
  function compressList(list) {
    const v = [...new Set(list)].sort((a, b) => a - b);
    const out = [];
    for (let i = 0; i < v.length; i++) {
      let j = i;
      while (j + 1 < v.length && v[j + 1] === v[j] + 1) j++;
      out.push(j > i + 1 ? `${v[i]}-${v[j]}` : j === i + 1 ? `${v[i]},${v[j]}` : `${v[i]}`);
      i = j;
    }
    return out.join(',');
  }

  // Parses an ACL address: any, host a.b.c.d, a.b.c.d w.x.y.z, a.b.c.d/nn or a bare host address.
  function parseAclAddr(text) {
    const s = String(text || '').trim().toLowerCase();
    if (!s || s === 'any') return { kind: 'any', text: 'any', net: 0, wild: 0xffffffff };
    let m = /^host\s+(\S+)$/.exec(s);
    if (m && ip2n(m[1]) !== null) return { kind: 'host', text: `host ${m[1]}`, net: ip2n(m[1]), wild: 0 };
    m = /^(\S+)\/(\d{1,2})$/.exec(s);
    if (m && ip2n(m[1]) !== null && +m[2] <= 32) {
      const mask = lenToMask(+m[2]);
      const net = network(m[1], mask);
      const wild = wildcard(mask);
      return +m[2] === 32
        ? { kind: 'host', text: `host ${m[1]}`, net: ip2n(m[1]), wild: 0 }
        : { kind: 'net', text: `${net} ${wild}`, net: ip2n(net), wild: ip2n(wild) };
    }
    m = /^(\S+)\s+(\S+)$/.exec(s);
    if (m && ip2n(m[1]) !== null && ip2n(m[2]) !== null) return { kind: 'net', text: `${m[1]} ${m[2]}`, net: ip2n(m[1]), wild: ip2n(m[2]) };
    if (ip2n(s) !== null) return { kind: 'host', text: `host ${s}`, net: ip2n(s), wild: 0 };
    return null;
  }

  function wildMatch(ipN, addr) {
    const care = notN(addr.wild);
    return andN(ipN, care) === andN(addr.net, care);
  }

  PL.net = {
    ip2n, n2ip, lenToMask, maskToLen, normalizeMask, network, networkN, broadcast, wildcard, inNet,
    isHostAddr, classfulNet, expandList, compressList, parseAclAddr, wildMatch,
  };
})(typeof window !== 'undefined' ? (window.PL = window.PL || {}) : (globalThis.PL = globalThis.PL || {}));
