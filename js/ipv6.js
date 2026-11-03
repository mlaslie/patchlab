// IPv6: address maths, SLAAC, static routes, OSPFv3 and ping. It reuses the IPv4 model's
// broadcast domains, so VLANs, trunks and spanning tree apply unchanged. No ACLs or NAT. No DOM.
(function (PL) {
  'use strict';

  const { shortName, ospfCost } = PL.catalog;
  const N = PL.net;
  const M = PL.model;

  const ALL = (1n << 128n) - 1n;

  function parse(text) {
    let s = String(text || '').trim().toLowerCase();
    if (!s || /[^0-9a-f:]/.test(s) || (s.match(/::/g) || []).length > 1) return null;
    const [head, tail] = s.includes('::') ? s.split('::') : [s, null];
    const h = head ? head.split(':') : [];
    const t = tail ? tail.split(':') : [];
    if (tail === null && h.length !== 8) return null;
    if (tail !== null && h.length + t.length > 7) return null;
    const groups = tail === null ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
    if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
    return groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n);
  }

  // RFC 5952: lower case, leading zeros dropped, the longest run of zero groups as "::".
  function format(n) {
    const g = [];
    for (let i = 7; i >= 0; i--) g.push(Number((n >> BigInt(i * 16)) & 0xffffn));
    let best = [-1, 0];
    for (let i = 0; i < 8;) {
      if (g[i] !== 0) { i++; continue; }
      let j = i;
      while (j < 8 && g[j] === 0) j++;
      if (j - i > best[1] && j - i > 1) best = [i, j - i];
      i = j;
    }
    const hex = g.map((x) => x.toString(16));
    if (best[0] < 0) return hex.join(':');
    return `${hex.slice(0, best[0]).join(':')}::${hex.slice(best[0] + best[1]).join(':')}`;
  }

  const maskN = (len) => (len === 0 ? 0n : (ALL << BigInt(128 - len)) & ALL);
  const netOf = (a, len) => a & maskN(len);

  // "2001:db8:1::1/64" into its parts, or null.
  function parsePrefix(text) {
    const m = /^\s*([0-9a-fA-F:]+)\/(\d{1,3})\s*$/.exec(String(text || ''));
    if (!m || +m[2] > 128) return null;
    const addr = parse(m[1]);
    if (addr === null) return null;
    return { addr, len: +m[2], net: netOf(addr, +m[2]) };
  }

  // Modified EUI-64 interface ID: split the MAC, insert FFFE, flip the universal/local bit.
  function eui64(mac) {
    const hex = String(mac || '').replace(/[^0-9a-f]/gi, '').padStart(12, '0').slice(0, 12);
    const b = hex.match(/../g).map((x) => parseInt(x, 16));
    b[0] ^= 0x02;
    const bytes = [...b.slice(0, 3), 0xff, 0xfe, ...b.slice(3)];
    return bytes.reduce((acc, x) => (acc << 8n) | BigInt(x), 0n);
  }

  const linkLocal = (mac) => (0xfe80n << 112n) | eui64(mac);
  const isLinkLocal = (a) => (a >> 118n) === (0xfe80n >> 6n);

  const AD = { C: 0, S: 1, O: 110 };

  function simulate(sim) {
    const p = sim.project;
    const S = PL.simulate;
    const v6 = { ifaces: [], byDev: {}, rt: {}, hosts: {} };
    const add = (i) => {
      v6.ifaces.push(i);
      (v6.byDev[i.devId] = v6.byDev[i.devId] || []).push(i);
    };
    const mk = (d, name, c, kind, up, extra) => {
      const pf = parsePrefix(c.ip6);
      const key = S.ikey(d.id, name);
      return {
        dev: d, devId: d.id, name, kind, cfg: c, key, domain: kind === 'loopback' ? null : sim.domainOf[key] || null, up,
        addr: pf ? pf.addr : null, len: pf ? pf.len : null, net: pf ? pf.net : null, ll: linkLocal(d.stp ? d.stp.mac : d.id), ospf3: c.ospf3 || '', ...extra,
      };
    };
    p.devices.forEach((d) => {
      v6.byDev[d.id] = [];
      if (M.isHost(d)) return;
      M.linksOf(p, d.id).forEach((l) => {
        if (!M.isL3End(p, l, d.id)) return;
        const name = M.endIf(l, d.id);
        const c = M.port(d, name);
        const up = S.linkIsUp(sim, l);
        if (c.ip6) add(mk(d, name, c, 'port', up));
        c.subifs.forEach((s) => { if (s.ip6) add(mk(d, `${name}.${s.num}`, s, 'sub', up)); });
      });
      d.loopbacks.forEach((lo) => { if (lo.ip6) add(mk(d, `Loopback${lo.num}`, lo, 'loopback', true)); });
      d.svis.forEach((s) => {
        if (!s.ip6) return;
        const up = !s.shutdown && (sim.adj[S.vkey(d.id, s.vlan)] || []).some((e) => e.link);
        add(mk(d, `Vlan${s.vlan}`, s, 'svi', up));
      });
    });

    // Hosts: a typed address, or SLAAC from a router advertising a /64 on the host's segment.
    p.devices.filter(M.isHost).forEach((d) => {
      if (d.ip6Mode === 'none') return;
      const l = M.linksOf(p, d.id)[0];
      const key = S.ikey(d.id, 'Ethernet0');
      const dom = sim.domainOf[key];
      const c = M.port(d, 'Ethernet0');
      const up = !!l && S.linkIsUp(sim, l);
      const base = { dev: d, devId: d.id, name: 'Ethernet0', kind: 'port', cfg: c, key, domain: dom || null, up, ll: linkLocal(d.stp ? d.stp.mac : d.id), ospf3: '' };
      if (d.ip6Mode === 'static') {
        const pf = parsePrefix(c.ip6);
        const gw = parse(d.gateway6);
        add({ ...base, addr: pf ? pf.addr : null, len: pf ? pf.len : null, net: pf ? pf.net : null, gateway: gw });
        v6.hosts[d.id] = pf ? { ok: true, how: 'static', addr: format(pf.addr), len: pf.len, gateway: gw !== null ? format(gw) : '' } : { ok: false, reason: 'No valid IPv6 address typed in.' };
        return;
      }
      const ra = v6.ifaces.find((i) => i.domain && i.domain === dom && i.up && i.addr !== null && i.len === 64 && M.canRoute(i.dev));
      if (!up || !dom) { v6.hosts[d.id] = { ok: false, reason: 'Not cabled to a working segment.' }; return; }
      if (!ra) {
        const other = v6.ifaces.find((i) => i.domain === dom && i.addr !== null && M.canRoute(i.dev));
        v6.hosts[d.id] = { ok: false, reason: other ? `SLAAC needs a /64 prefix. ${other.dev.name} ${shortName(other.name)} has /${other.len}.` : 'No router on this segment has an IPv6 address, so nothing sends Router Advertisements.' };
        return;
      }
      const addr = ra.net | eui64(d.stp ? d.stp.mac : d.id);
      add({ ...base, addr, len: 64, net: ra.net, gateway: ra.ll, slaac: true });
      v6.hosts[d.id] = { ok: true, how: 'slaac', addr: format(addr), len: 64, gateway: format(ra.ll), router: ra.dev.name, ifName: ra.name };
    });

    const routers = p.devices.filter(M.canRoute);
    const upIfs = (d) => (v6.byDev[d.id] || []).filter((i) => i.up && i.addr !== null);
    const peers = (i) => (i.domain ? v6.ifaces.filter((j) => j !== i && j.devId !== i.devId && j.domain === i.domain && j.up) : []);
    const enabled = (d) => d.routing.ospf3.enabled && upIfs(d).length > 0;
    routers.forEach((d) => {
      const o = d.routing.ospf3;
      const v4ups = (sim.byDev[d.id] || []).filter((i) => i.up && i.ip && i.kind !== 'vip');
      const highest = (list) => list.map((i) => i.ip).sort((a, b) => N.ip2n(b) - N.ip2n(a))[0];
      const rid = N.ip2n(o.routerId) !== null ? o.routerId : highest(v4ups.filter((i) => i.kind === 'loopback')) || highest(v4ups) || '';
      v6.rt[d.id] = { rid, ospfIfs: o.enabled ? upIfs(d).filter((i) => i.ospf3 !== '') : [], nbrs: [], rib: {}, sorted: [], ospf: {} };
    });
    routers.forEach((d) => {
      const st = v6.rt[d.id];
      if (!enabled(d) || !st.rid) return;
      st.ospfIfs.forEach((me) => {
        if (me.kind === 'loopback') return;
        peers(me).filter((j) => M.canRoute(j.dev)).forEach((j) => {
          const pst = v6.rt[j.devId];
          const them = pst && pst.ospfIfs.find((x) => x === j);
          let reason = '';
          if (!j.dev.routing.ospf3.enabled || !them) reason = `${j.dev.name} ${shortName(j.name)} is not in OSPFv3.`;
          else if (!pst.rid) reason = `${j.dev.name} has no router ID, so OSPFv3 cannot start there.`;
          else if (them.ospf3 !== me.ospf3) reason = `Area mismatch: area ${me.ospf3} here, area ${them.ospf3} on ${j.dev.name}.`;
          else if (pst.rid === st.rid) reason = `Both routers use router ID ${st.rid}.`;
          st.nbrs.push({ me, them: j, rid: pst ? pst.rid : '', ok: !reason, reason });
        });
      });
    });

    const pk = (net, len) => `${net.toString(16)}/${len}`;
    function install(d) {
      const st = v6.rt[d.id];
      const rib = {};
      const offer = (r) => {
        const k = pk(r.net, r.len);
        if (!rib[k] || r.ad < rib[k].ad || (r.ad === rib[k].ad && r.metric < rib[k].metric)) rib[k] = r;
      };
      upIfs(d).forEach((i) => offer({ net: i.net, len: i.len, proto: 'C', ad: 0, metric: 0, ifName: i.name, nh: null }));
      d.routing.static6.forEach((s) => {
        const pf = parsePrefix(s.net);
        if (!pf) return;
        const via = parse(s.via);
        if (via !== null) {
          if (lookup(d, via, st.sorted, 0)) offer({ net: pf.net, len: pf.len, proto: 'S', ad: +s.ad || AD.S, metric: 0, nh: via, ifName: isLinkLocal(via) ? s.exit || null : null });
        } else {
          const ifc = upIfs(d).find((i) => i.name === s.via);
          if (ifc) offer({ net: pf.net, len: pf.len, proto: 'S', ad: +s.ad || AD.S, metric: 0, nh: null, ifName: s.via });
        }
      });
      Object.entries(st.ospf).forEach(([k, e]) => {
        if (e.local) return;
        offer({ net: e.net, len: e.len, proto: 'O', ad: AD.O, metric: e.metric, nh: e.nh, ifName: e.ifName, fromDev: e.fromDev });
      });
      st.rib = rib;
      st.sorted = Object.values(rib).sort((a, b) => b.len - a.len || a.ad - b.ad);
    }
    function lookup(d, addr, sorted) {
      return (sorted || v6.rt[d.id].sorted).find((r) => netOf(addr, r.len) === r.net);
    }
    function nextOspf(d) {
      const st = v6.rt[d.id];
      const t = {};
      if (!enabled(d) || !st.rid) return t;
      st.ospfIfs.forEach((i) => {
        const len = i.kind === 'loopback' ? 128 : i.len;
        const net = i.kind === 'loopback' ? i.addr : i.net;
        t[pk(net, len)] = { net, len, metric: ospfCost(i.name), local: true };
      });
      st.nbrs.filter((n) => n.ok).forEach(({ me, them }) => {
        Object.entries(v6.rt[them.devId].ospf).forEach(([k, e]) => {
          if (e.fromDev === d.id || (t[k] && t[k].local)) return;
          const metric = e.metric + ospfCost(me.name);
          if (!t[k] || metric < t[k].metric) t[k] = { net: e.net, len: e.len, metric, nh: them.ll, ifName: me.name, fromDev: them.devId };
        });
      });
      return t;
    }
    let last = '';
    for (let round = 0; round < 40; round++) {
      routers.forEach(install);
      const next = routers.map((d) => [d, nextOspf(d)]);
      next.forEach(([d, t]) => { v6.rt[d.id].ospf = t; });
      const snap = JSON.stringify(next.map(([, t]) => Object.keys(t).sort().map((k) => [k, t[k].metric])));
      if (snap === last) break;
      last = snap;
    }
    routers.forEach(install);
    return v6;
  }

  // Walks a packet like the IPv4 walk: hosts send off-link traffic to their gateway, routers
  // follow the longest match, and the next hop must answer neighbor discovery on the segment.
  function walk(sim, src, dst) {
    const v6 = sim.v6;
    const S = PL.simulate;
    const hops = [];
    const links = [];
    const done = (ok, reason, endDev) => ({ ok, reason, hops, links, endDev });
    let cur = src;
    let ingress = null;
    for (let ttl = 0; ttl < 32; ttl++) {
      const mine = (v6.byDev[cur.id] || []).filter((i) => i.up);
      const hop = { dev: cur.name, devId: cur.id, in: ingress ? ingress.name : '', out: '', via: [] };
      hops.push(hop);
      if (mine.some((i) => i.addr === dst || (i.kind !== 'loopback' && i.ll === dst))) return done(true, '', cur);
      if (ingress && !M.canRoute(cur)) {
        hop.fail = `${cur.name} received the packet but does not route.`;
        return done(false, hop.fail);
      }
      let egress;
      let nh;
      if (M.canRoute(cur)) {
        const r = (v6.rt[cur.id].sorted || []).find((x) => netOf(dst, x.len) === x.net);
        if (!r) {
          hop.fail = `No IPv6 route to ${format(dst)}.`;
          return done(false, `${cur.name} has no IPv6 route to ${format(dst)}.`);
        }
        hop.route = { net: format(r.net), len: r.len, proto: r.proto };
        let exit = r.ifName;
        nh = r.nh;
        if (!exit && nh !== null) {
          const inner = (v6.rt[cur.id].sorted || []).find((x) => x.proto === 'C' && netOf(nh, x.len) === x.net);
          exit = inner && inner.ifName;
        }
        egress = mine.find((i) => i.name === exit);
        if (r.proto === 'C' || nh === null) nh = dst;
      } else {
        egress = mine.find((i) => i.addr !== null);
        if (!egress) {
          hop.fail = 'No IPv6 address.';
          return done(false, `${cur.name} has no IPv6 address.`);
        }
        if (netOf(dst, egress.len) === egress.net) nh = dst;
        else if (egress.gateway !== null && egress.gateway !== undefined) nh = egress.gateway;
        else {
          hop.fail = 'No IPv6 default gateway.';
          return done(false, `${cur.name} has no IPv6 default gateway.`);
        }
      }
      if (!egress) {
        hop.fail = 'The exit interface is down.';
        return done(false, `${cur.name}: ${hop.fail}`);
      }
      hop.out = egress.name;
      const target = v6.ifaces.find((i) => i.up && i.domain && i.domain === egress.domain && i !== egress && (i.addr === nh || i.ll === nh));
      if (!target) {
        hop.fail = `Neighbor discovery for ${format(nh)} gets no answer on ${shortName(egress.name)}.`;
        return done(false, `${cur.name}: ${hop.fail}`);
      }
      const path = S.l2Steps(sim, egress.key, target.key);
      if (path) {
        path.forEach((s) => { if (s.link) links.push(s.link); });
        hop.via = [...new Set(path.filter((s) => s.key.startsWith('v:')).map((s) => s.key.split(':')[1]))].map((id) => M.dev(sim.project, id)).filter(Boolean).map((d) => d.name);
      }
      ingress = target;
      cur = target.dev;
    }
    return done(false, 'Hop limit exceeded. There is a routing loop.');
  }

  function ping(sim, fromId, toText) {
    const dst = parse(toText);
    if (dst === null) return { ok: false, reason: `${toText} is not an IPv6 address.` };
    const src = M.dev(sim.project, fromId);
    const own = (sim.v6.byDev[fromId] || []).find((i) => i.up && i.addr !== null);
    if (!own) return { ok: false, reason: `${src.name} has no IPv6 address.`, fwd: { hops: [], links: [] } };
    const fwd = walk(sim, src, dst);
    if (!fwd.ok) return { ok: false, fwd, reason: fwd.reason };
    const back = walk(sim, fwd.endDev, own.addr);
    return { ok: back.ok, fwd, back, reason: back.ok ? '' : `Return path failed. ${back.reason}` };
  }

  // The predicted "show ipv6 route" for one router.
  function showRoutes(sim, d) {
    const st = sim.v6 && sim.v6.rt[d.id];
    if (!st) return [];
    const lines = [];
    (sim.v6.byDev[d.id] || []).filter((i) => i.up && i.addr !== null).forEach((i) => {
      if (i.len < 128) lines.push({ code: 'L', proto: 'L', net: format(i.addr), len: 128, ad: 0, metric: 0, nh: '', ifName: i.name, from: '', sortN: i.addr });
    });
    st.sorted.forEach((r) => {
      const from = r.fromDev ? M.dev(sim.project, r.fromDev) : null;
      lines.push({ code: r.proto, proto: r.proto, net: format(r.net), len: r.len, ad: r.ad, metric: r.metric, nh: r.nh !== null && r.nh !== undefined ? format(r.nh) : '', ifName: r.ifName || '', from: from ? from.name : '', sortN: r.net });
    });
    return lines.sort((a, b) => (a.sortN < b.sortN ? -1 : a.sortN > b.sortN ? 1 : a.len - b.len));
  }

  function addrList(sim) {
    const out = [];
    sim.project.devices.forEach((d) => (sim.v6 ? sim.v6.byDev[d.id] || [] : []).filter((i) => i.addr !== null && i.up).forEach((i) => out.push({ dev: d, ifName: i.name, addr: format(i.addr) })));
    return out;
  }

  PL.ipv6 = { parse, format, parsePrefix, eui64, linkLocal, isLinkLocal, netOf, simulate, ping, showRoutes, addrList };
})(typeof window !== 'undefined' ? (window.PL = window.PL || {}) : (globalThis.PL = globalThis.PL || {}));
