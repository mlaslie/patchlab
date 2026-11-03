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

  PL.subnet = { calc, vlsm, lenFor };
})(typeof window !== 'undefined' ? (window.PL = window.PL || {}) : (globalThis.PL = globalThis.PL || {}));
