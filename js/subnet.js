// Subnet maths for the calculator and the VLSM planner. No DOM.
(function (PL) {
  'use strict';

  const N = PL.net;

  const PRIVATE = [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16]];

  // Everything a student is asked about one address and mask.
  function calc(ip, maskText) {
    const ipN = N.ip2n(ip);
    const mask = N.normalizeMask(maskText);
    if (ipN === null) return { error: `${ip || 'That'} is not an IPv4 address.` };
    if (!mask) return { error: 'Enter a mask such as 255.255.255.0 or /24.' };
    const len = N.maskToLen(mask);
    const size = 2 ** (32 - len);
    const net = N.networkN(ip, mask);
    const bcast = net + size - 1;
    const first = Number(ipN >>> 24);
    const cls = first < 128 ? 'A' : first < 192 ? 'B' : first < 224 ? 'C' : first < 240 ? 'D (multicast)' : 'E (reserved)';
    const priv = PRIVATE.some(([n, l]) => N.inNet(ip, n, N.lenToMask(l)));
    const hosts = len >= 31 ? size : size - 2;
    return {
      ip, mask, len, wildcard: N.wildcard(mask), network: N.n2ip(net), broadcast: len >= 31 ? '' : N.n2ip(bcast),
      first: N.n2ip(len >= 31 ? net : net + 1), last: N.n2ip(len >= 31 ? bcast : bcast - 1), hosts, size, cls,
      private: priv, isNetwork: ipN === net, isBroadcast: len < 31 && ipN === bcast,
    };
  }

  // Smallest prefix with room for this many hosts plus the network and broadcast addresses.
  function lenFor(hosts) {
    for (let len = 30; len >= 0; len--) if (2 ** (32 - len) - 2 >= hosts) return len;
    return null;
  }

  // Classic VLSM: biggest segment first, each placed at the next aligned free address.
  function vlsm(base, maskText, needs) {
    const mask = N.normalizeMask(maskText);
    if (N.ip2n(base) === null || !mask) return { error: 'Enter the address block to split, such as 192.168.1.0/24.' };
    const len = N.maskToLen(mask);
    const start = N.networkN(base, mask);
    const end = start + 2 ** (32 - len);
    const list = needs.map((n, i) => ({ ...n, i, hosts: Math.max(0, Math.floor(+n.hosts || 0)) })).filter((n) => n.hosts > 0);
    if (!list.length) return { error: 'Add at least one segment with a host count.' };
    const order = list.slice().sort((a, b) => b.hosts - a.hosts || a.i - b.i);
    let cur = start;
    const rows = [];
    for (const n of order) {
      const l = lenFor(n.hosts);
      if (l === null || l < len) return { error: `${n.name || 'A segment'} needs ${n.hosts} hosts, more than ${N.n2ip(start)}/${len} holds.` };
      const size = 2 ** (32 - l);
      cur = Math.ceil(cur / size) * size;
      if (cur + size > end) {
        return { error: `${N.n2ip(start)}/${len} runs out of space at ${n.name || 'a segment'} (${n.hosts} hosts). Use a bigger block or fewer hosts.`, rows };
      }
      rows.push({
        name: n.name || `Segment ${n.i + 1}`, i: n.i, hosts: n.hosts, len: l, mask: N.lenToMask(l), net: N.n2ip(cur), first: N.n2ip(cur + 1),
        last: N.n2ip(cur + size - 2), broadcast: N.n2ip(cur + size - 1), usable: size - 2, size, vlan: n.vlan,
      });
      cur += size;
    }
    const used = rows.reduce((s, r) => s + r.size, 0);
    return { rows, block: `${N.n2ip(start)}/${len}`, used, total: end - start, free: end - start - used, next: cur < end ? N.n2ip(cur) : '' };
  }

  // ---------- IPv6 ----------

  // All eight groups, four digits each, as students write it out before shortening.
  function expand6(n) {
    const g = [];
    for (let i = 7; i >= 0; i--) g.push(((n >> BigInt(i * 16)) & 0xffffn).toString(16).padStart(4, '0'));
    return g.join(':');
  }

  const TYPES6 = [
    ['::1', 128, 'Loopback'], ['::', 128, 'Unspecified'], ['2001:db8::', 32, 'Documentation (2001:db8::/32)'],
    ['fe80::', 10, 'Link-local (fe80::/10)'], ['fc00::', 7, 'Unique local (fc00::/7)'], ['ff00::', 8, 'Multicast (ff00::/8)'],
    ['2000::', 3, 'Global unicast (2000::/3)'],
  ];

  function type6(addr) {
    const X = PL.ipv6;
    const hit = TYPES6.find(([net, len]) => X.netOf(addr, len) === X.parse(net));
    return hit ? hit[2] : 'Reserved';
  }

  // 2^n as a readable count: exact while it fits, otherwise a power of two with its size.
  function count6(bits) {
    const n = 2n ** BigInt(bits);
    if (bits <= 53) return n.toLocaleString('en-US');
    const digits = n.toString();
    return `2^${bits} (about ${digits[0]}.${digits.slice(1, 3)} × 10^${digits.length - 1})`;
  }

  // "2001:db8:acad::1/48", or a bare address taken as a /64.
  function calc6(text) {
    const X = PL.ipv6;
    const s = String(text || '').trim();
    const pf = X.parsePrefix(s.includes('/') ? s : `${s}/64`);
    if (!pf) return { error: 'Enter an IPv6 prefix such as 2001:db8:acad::/48.' };
    const span = 128 - pf.len;
    const last = pf.net | ((1n << BigInt(span)) - 1n);
    return {
      addr: X.format(pf.addr), len: pf.len, network: X.format(pf.net), networkLong: expand6(pf.net), last: X.format(last),
      addresses: count6(span), sixtyFours: pf.len <= 64 ? count6(64 - pf.len) : '', type: type6(pf.addr), isNetwork: pf.addr === pf.net,
      // Prefixes on a 4-bit boundary change whole hex digits, which is much easier to read.
      nibble: pf.len % 4 === 0,
    };
  }

  // Splits a block into equal subnets of newLen and lists `count` of them from index `from`.
  function split6(text, newLen, from, count) {
    const X = PL.ipv6;
    const pf = X.parsePrefix(String(text || '').trim());
    if (!pf) return { error: 'Enter the block to split, such as 2001:db8:acad::/48.' };
    newLen = +newLen;
    if (!(newLen > pf.len && newLen <= 128)) return { error: `The new prefix must be longer than /${pf.len} and at most /128.` };
    const bits = newLen - pf.len;
    const total = 1n << BigInt(bits);
    let start = BigInt(from || 0);
    if (start < 0n) start = 0n;
    if (start >= total) start = total - 1n;
    const size = 1n << BigInt(128 - newLen);
    const rows = [];
    for (let i = start; i < total && i < start + BigInt(count || 8); i++) {
      const net = pf.net + i * size;
      rows.push({ index: i.toString(), net: X.format(net), len: newLen, first: X.format(net), last: X.format(net + size - 1n), subnetId: i.toString(16) });
    }
    return { block: `${X.format(pf.net)}/${pf.len}`, bits, total: total.toString(), totalText: count6(bits), from: start.toString(), rows, nibble: bits % 4 === 0 };
  }

  PL.subnet = { calc, vlsm, lenFor, calc6, split6, expand6 };
})(typeof window !== 'undefined' ? (window.PL = window.PL || {}) : (globalThis.PL = globalThis.PL || {}));
