// A model of how the configured network would behave: L2 broadcast domains, routing protocol
// convergence, and hop-by-hop packet walks with ACL checks. It works from the project data,
// so it answers "would this work" without running IOS.
(function (PL) {
  'use strict';

  const { shortName, ospfCost, portNum } = PL.catalog;
  const N = PL.net;
  const M = PL.model;

  const AD = { C: 0, S: 1, eBGP: 20, O: 110, R: 120, iBGP: 200 };
  const ikey = (id, name) => `i:${id}:${name}`;
  const vkey = (id, vlan) => `v:${id}:${vlan}`;

  function makeIface(d, name, c, kind, extra) {
    const ok = N.ip2n(c.ip) !== null && N.maskToLen(c.mask) !== null;
    return {
      dev: d, devId: d.id, name, kind, cfg: c, key: ikey(d.id, name), up: false,
      ip: ok ? c.ip.trim() : '', mask: ok ? c.mask.trim() : '', len: ok ? N.maskToLen(c.mask) : null,
      net: ok ? N.network(c.ip, c.mask) : '', aclIn: c.aclIn || '', aclOut: c.aclOut || '', domain: null, ...extra,
    };
  }

  // What each end of a link does with untagged (u) and tagged (t) frames.
  function tagMap(p, l, d) {
    if (M.isL3End(p, l, d.id)) {
      const name = M.endIf(l, d.id);
      const c = M.port(d, name);
      const map = { u: ikey(d.id, name), t: {} };
      c.subifs.forEach((s) => {
        const key = ikey(d.id, `${name}.${s.num}`);
        if (s.native) map.u = key;
        else map.t[s.vlan] = key;
      });
      return map;
    }
    if (l.mode === 'access') return { u: vkey(d.id, l.vlan), t: {} };
    const map = { u: null, t: {} };
    M.allowedVlans(p, l).forEach((v) => {
      if (v === l.nativeVlan) map.u = vkey(d.id, v);
      else map.t[v] = vkey(d.id, v);
    });
    return map;
  }

  // Shut down at either end, or err-disabled by a port security violation.
  function linkIsUp(sim, l) {
    const p = sim.project;
    return !sim.down.has(l.id) && [l.a, l.b].every((id) => !M.port(M.dev(p, id), M.endIf(l, id)).shutdown);
  }

  // End devices and router ports behind one switch port: every MAC the port would learn.
  function macsBehind(p, sw, l) {
    const seen = new Set([sw.id]);
    const stack = [M.peerOf(l, sw.id)];
    const found = [];
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      const d = M.dev(p, id);
      if (!M.isSwitch(d)) found.push(d);
      else M.linksOf(p, id).forEach((x) => stack.push(M.peerOf(x, id)));
    }
    return found;
  }

  // Port security counts the MACs behind each secured access port. Over the maximum,
  // "shutdown" err-disables the port; "restrict" and "protect" drop the extra senders.
  function portSecurity(sim) {
    const p = sim.project;
    sim.portSec = [];
    p.devices.filter(M.isSwitch).forEach((sw) => M.linksOf(p, sw.id).forEach((l) => {
      if (l.mode !== 'access' || M.isL3End(p, l, sw.id)) return;
      const name = M.endIf(l, sw.id);
      const ps = (sw.ports[name] || {}).portSec;
      if (!ps) return;
      const macs = macsBehind(p, sw, l).sort((a, b) => PL.catalog.naturalCompare(a.name, b.name));
      const max = +ps.max || 1;
      const entry = { devId: sw.id, ifName: name, linkId: l.id, max, count: macs.length, violation: ps.violation || 'shutdown', sticky: !!ps.sticky, hosts: macs.map((d) => d.name) };
      sim.portSec.push(entry);
      if (macs.length > max) {
        entry.violated = true;
        if (entry.violation === 'shutdown') sim.down.add(l.id);
        else entry.dropped = macs.slice(max).map((d) => d.id);
      }
    }));
  }

  function buildL2(sim) {
    const p = sim.project;
    const adj = sim.adj;
    const edge = (x, y, link) => {
      (adj[x] = adj[x] || []).push({ to: y, link });
      (adj[y] = adj[y] || []).push({ to: x, link });
    };
    p.links.forEach((l) => {
      if (!linkIsUp(sim, l)) return;
      const a = tagMap(p, l, M.dev(p, l.a));
      const b = tagMap(p, l, M.dev(p, l.b));
      // Spanning tree blocks a redundant switch-to-switch cable per VLAN.
      const blocked = (v) => sim.stp.isBlocked(l.id, +v);
      const untagged = l.mode === 'access' ? l.vlan : l.nativeVlan;
      if (a.u && b.u && !(l.mode !== 'routed' && blocked(untagged))) edge(a.u, b.u, l.id);
      Object.keys(a.t).forEach((v) => b.t[v] && !blocked(v) && edge(a.t[v], b.t[v], l.id));
    });
    p.devices.forEach((d) => d.svis.forEach((s) => {
      if (!s.shutdown) edge(ikey(d.id, `Vlan${s.vlan}`), vkey(d.id, s.vlan), null);
    }));
    // Connected components are the broadcast domains.
    let next = 1;
    const seen = {};
    Object.keys(adj).forEach((start) => {
      if (seen[start]) return;
      const id = next++;
      const stack = [start];
      seen[start] = id;
      while (stack.length) {
        (adj[stack.pop()] || []).forEach((e) => {
          if (!seen[e.to]) {
            seen[e.to] = id;
            stack.push(e.to);
          }
        });
      }
    });
    sim.domainOf = seen;
  }

  function buildIfaces(sim) {
    const p = sim.project;
    const add = (ifc) => {
      sim.ifaces.push(ifc);
      (sim.byDev[ifc.devId] = sim.byDev[ifc.devId] || []).push(ifc);
    };
    p.devices.forEach((d) => {
      sim.byDev[d.id] = [];
      M.linksOf(p, d.id).forEach((l) => {
        if (!M.isL3End(p, l, d.id)) return;
        const name = M.endIf(l, d.id);
        const c = M.port(d, name);
        const up = linkIsUp(sim, l);
        // DHCP clients get their address later, from assignLeases.
        if (M.isHost(d) && d.ipMode === 'dhcp') return;
        if (c.ip) add({ ...makeIface(d, name, c, 'port', { link: l.id }), up });
        c.subifs.forEach((s) => add({ ...makeIface(d, `${name}.${s.num}`, s, 'sub', { link: l.id, vlan: s.vlan }), up }));
      });
      d.loopbacks.forEach((lo) => {
        const ifc = makeIface(d, `Loopback${lo.num}`, lo, 'loopback', {});
        ifc.up = true;
        add(ifc);
      });
      d.svis.forEach((s) => {
        const ifc = makeIface(d, `Vlan${s.vlan}`, s, 'svi', { vlan: s.vlan });
        // An SVI stays down until a port in its VLAN is up.
        ifc.up = !s.shutdown && (sim.adj[vkey(d.id, s.vlan)] || []).some((e) => e.link);
        add(ifc);
      });
    });
    sim.ifaces.forEach((i) => { i.domain = sim.domainOf[i.key] || null; });
  }

  // HSRP: on each subnet and group the highest priority wins, then the highest address.
  // The active router answers for the virtual IP. Assumes the routers started together;
  // without preempt, whichever came up first stays active.
  function electHsrp(sim) {
    sim.vips = [];
    sim.hsrp = [];
    const groups = {};
    sim.ifaces.forEach((i) => {
      const h = i.cfg && i.cfg.hsrp;
      if (!h || !i.up || !i.domain || !M.canRoute(i.dev)) return;
      const k = `${i.domain}|${h.group}`;
      (groups[k] = groups[k] || []).push(i);
    });
    Object.values(groups).forEach((list) => {
      list.sort((a, b) => (+b.cfg.hsrp.priority || 100) - (+a.cfg.hsrp.priority || 100) || N.ip2n(b.ip) - N.ip2n(a.ip));
      const vip = (list.find((i) => N.ip2n(i.cfg.hsrp.vip) !== null) || {}).cfg;
      list.forEach((i, n) => {
        const h = i.cfg.hsrp;
        const state = n === 0 ? 'Active' : n === 1 ? 'Standby' : 'Listen';
        const entry = { devId: i.devId, dev: i.dev, ifName: i.name, group: +h.group, priority: +h.priority || 100, preempt: !!h.preempt, vip: h.vip || (vip ? vip.hsrp.vip : ''), state, iface: i, peers: list.filter((x) => x !== i) };
        sim.hsrp.push(entry);
        if (n === 0 && N.ip2n(entry.vip) !== null) sim.vips.push({ ...i, ip: entry.vip, kind: 'vip', hsrp: entry });
      });
    });
  }

  // Static NAT globals on an outside subnet are answered by the NAT router (proxy ARP).
  function natGlobals(sim) {
    sim.project.devices.filter(M.canRoute).forEach((d) => {
      (d.nat ? d.nat.statics : []).forEach((s) => {
        const out = sim.byDev[d.id].find((i) => i.up && i.ip && i.cfg.nat === 'outside' && N.ip2n(s.global) !== null && N.inNet(s.global, i.net, i.mask));
        if (out && s.global !== out.ip) sim.vips.push({ ...out, ip: s.global, kind: 'vip', natStatic: s });
      });
    });
  }

  const pfxKey = (net, len) => `${net}/${len}`;
  const upIfaces = (sim, d) => sim.byDev[d.id].filter((i) => i.up && i.ip);
  const ownerOf = (sim, ip) => sim.ifaces.find((i) => i.ip === ip);

  function peersOn(sim, i) {
    if (!i.domain) return [];
    return sim.ifaces.filter((j) => j.domain === i.domain && j.devId !== i.devId && j.up && j.ip && j.net === i.net);
  }

  function ospfIfaces(sim, d) {
    const o = d.routing.ospf;
    if (!o.enabled) return [];
    const out = [];
    upIfaces(sim, d).forEach((i) => {
      const hit = o.networks.find((n) => {
        const wild = N.ip2n(n.wild);
        return N.ip2n(n.net) !== null && wild !== null && N.wildMatch(N.ip2n(i.ip), { net: N.ip2n(n.net), wild });
      });
      if (hit) out.push({ i, area: String(hit.area), passive: o.passive.includes(i.name) });
    });
    return out;
  }

  function ripIfaces(sim, d) {
    const r = d.routing.rip;
    if (!r.enabled) return [];
    const nets = r.networks.filter((n) => N.ip2n(n) !== null).map((n) => N.classfulNet(n));
    return upIfaces(sim, d).filter((i) => nets.includes(N.classfulNet(i.ip))).map((i) => ({ i, passive: r.passive.includes(i.name) }));
  }

  // IOS takes the router-id command first, then the highest up loopback address, then the
  // highest address on any other up interface.
  function ospfRouterId(sim, d) {
    const set = (d.routing.ospf.routerId || '').trim();
    if (N.ip2n(set) !== null) return set;
    const highest = (list) => list.map((i) => i.ip).sort((a, b) => N.ip2n(b) - N.ip2n(a))[0];
    const ups = upIfaces(sim, d);
    return highest(ups.filter((i) => i.kind === 'loopback')) || highest(ups) || '';
  }

  // Why two OSPF interfaces on the same subnet would not become neighbors, or '' if they would.
  function ospfMismatch(sim, me, them, j) {
    const peer = j.dev.name;
    if (!them) return `${peer} ${shortName(j.name)} is not in OSPF. No network statement on ${peer} covers ${j.ip}.`;
    if (them.passive) return `${peer} ${shortName(j.name)} is passive, so it sends no hellos.`;
    if (them.area !== me.area) return `Area mismatch: area ${me.area} here, area ${them.area} on ${peer}.`;
    if (them.i.len !== me.i.len) return `Subnet mask mismatch: /${me.i.len} here, /${them.i.len} on ${peer}.`;
    const rid = sim.rt[me.i.devId].ospfRid;
    if (rid && rid === sim.rt[j.devId].ospfRid) return `Both routers use router ID ${rid}. Router IDs must be unique.`;
    const hello = (from) => ({ src: from.ip, dst: '224.0.0.5', proto: 'ospf' });
    if (!admits(me.i, hello(j))) return `Inbound ACL ${me.i.aclIn} on ${shortName(me.i.name)} drops hellos from ${peer}.`;
    if (!admits(j, hello(me.i))) return `Inbound ACL ${j.aclIn} on ${peer} ${shortName(j.name)} drops hellos from this router.`;
    return '';
  }

  // Ethernet is a broadcast network type: the highest router ID on each subnet becomes DR and
  // the next becomes BDR (every priority is the default 1). DROTHERs stay 2WAY with each other.
  function electDrs(sim, routers) {
    routers.forEach((d) => {
      const st = sim.rt[d.id];
      st.ospfRoles = {};
      const byIf = {};
      st.ospfNbrs.filter((n) => n.ok).forEach((n) => { (byIf[n.me.name] = byIf[n.me.name] || []).push(n); });
      Object.entries(byIf).forEach(([name, nbrs]) => {
        const ranked = [{ devId: d.id, rid: st.ospfRid }, ...nbrs.map((n) => ({ devId: n.them.devId, rid: n.rid }))]
          .sort((a, b) => N.ip2n(b.rid) - N.ip2n(a.rid));
        const role = (devId) => (ranked[0].devId === devId ? 'DR' : ranked[1].devId === devId ? 'BDR' : 'DROTHER');
        st.ospfRoles[name] = role(d.id);
        nbrs.forEach((n) => {
          n.role = role(n.them.devId);
          n.state = st.ospfRoles[name] === 'DROTHER' && n.role === 'DROTHER' ? '2WAY' : 'FULL';
        });
      });
    });
  }

  function computeAdjacencies(sim, routers) {
    routers.forEach((d) => {
      const st = sim.rt[d.id];
      st.ospfIfs = ospfIfaces(sim, d);
      st.ripIfs = ripIfaces(sim, d);
      st.ospfRid = d.routing.ospf.enabled ? ospfRouterId(sim, d) : '';
    });
    routers.forEach((d) => {
      const st = sim.rt[d.id];
      st.ospfAdj = [];
      st.ospfNbrs = [];
      st.ripAdj = [];
      st.aclBlocks = [];
      st.ospfIfs.forEach((me) => {
        if (me.passive) return;
        peersOn(sim, me.i).forEach((j) => {
          const peer = sim.rt[j.devId];
          if (!peer || !j.dev.routing.ospf.enabled) return;
          const them = peer.ospfIfs.find((x) => x.i === j);
          const reason = ospfMismatch(sim, me, them, j);
          st.ospfNbrs.push({ me: me.i, them: j, rid: peer.ospfRid, ok: !reason, reason });
          if (!reason) st.ospfAdj.push({ me: me.i, them: j });
          else if (reason.startsWith(`Inbound ACL ${me.i.aclIn} on`)) st.aclBlocks.push({ what: 'OSPF hellos', at: me.i, from: j, fix: 'permit ospf any any' });
        });
      });
      st.ripIfs.forEach((me) => {
        peersOn(sim, me.i).forEach((j) => {
          const peer = sim.rt[j.devId];
          const them = peer && peer.ripIfs.find((x) => x.i === j);
          if (!them || them.passive) return;
          const update = { src: j.ip, dst: '224.0.0.9', proto: 'udp', sport: 520, dport: 520 };
          if (admits(me.i, update)) st.ripAdj.push({ me: me.i, them: j });
          else st.aclBlocks.push({ what: 'RIP updates', at: me.i, from: j, fix: 'permit udp any any eq 520' });
        });
      });
    });
  }

  // Inbound lists filter routing and DHCP packets like any other traffic. Outbound lists never
  // filter packets the router itself sends, so only the receiving interface matters here.
  function admits(i, pkt) {
    return aclCheck(i.dev, i.aclIn, pkt).ok;
  }

  function longest(sim, id, ipN) {
    const routes = sim.rt[id].sorted;
    return routes.find((r) => r.proto !== 'L' && N.networkN(N.n2ip(ipN), r.mask) === N.ip2n(r.net));
  }

  // Follows recursive next hops down to an exit interface.
  function resolve(sim, id, ipN, depth) {
    if ((depth || 0) > 8) return null;
    const r = longest(sim, id, ipN);
    if (!r) return null;
    if (r.proto === 'C') return { route: r, ifName: r.ifName, nhIp: N.n2ip(ipN) };
    if (!r.nh) return { route: r, ifName: r.ifName, nhIp: N.n2ip(ipN) };
    const inner = resolve(sim, id, N.ip2n(r.nh), (depth || 0) + 1);
    if (!inner) return null;
    return { route: r, ifName: inner.ifName, nhIp: inner.route.proto === 'C' ? r.nh : inner.nhIp };
  }

  function installRib(sim, d) {
    const st = sim.rt[d.id];
    const rib = {};
    const offers = [];
    const offer = (r) => {
      const k = pfxKey(r.net, r.len);
      const cur = rib[k];
      offers.push(r);
      if (!cur || r.ad < cur.ad || (r.ad === cur.ad && r.metric < cur.metric)) rib[k] = r;
    };
    upIfaces(sim, d).forEach((i) => {
      offer({ net: i.net, len: i.len, mask: i.mask, proto: 'C', ad: 0, metric: 0, ifName: i.name, nh: null });
    });
    d.routing.static.forEach((s) => {
      const len = N.maskToLen(s.mask);
      if (len === null || N.ip2n(s.net) === null) return;
      const ad = +s.ad || AD.S;
      const base = { net: N.network(s.net, s.mask), len, mask: s.mask, proto: 'S', ad, metric: 0 };
      if (N.ip2n(s.via) !== null) {
        const via = N.ip2n(s.via);
        if (st.sorted.length && resolve(sim, d.id, via)) offer({ ...base, nh: s.via, ifName: null });
      } else {
        const ifc = sim.byDev[d.id].find((i) => i.name === s.via);
        if (ifc && ifc.up) offer({ ...base, nh: null, ifName: s.via });
      }
    });
    Object.entries(st.ospf).forEach(([k, e]) => {
      if (e.local) return;
      const [net, len] = k.split('/');
      offer({ net, len: +len, mask: N.lenToMask(+len), proto: 'O', ext: e.ext, ad: AD.O, metric: e.metric, nh: e.nh, ifName: e.ifName, fromDev: e.fromDev });
    });
    Object.entries(st.rip).forEach(([k, e]) => {
      if (e.local) return;
      const [net, len] = k.split('/');
      offer({ net, len: +len, mask: N.lenToMask(+len), proto: 'R', ad: AD.R, metric: e.metric, nh: e.nh, ifName: e.ifName, fromDev: e.fromDev });
    });
    Object.entries(st.bgp).forEach(([k, e]) => {
      if (e.local || e.valid === false) return;
      const [net, len] = k.split('/');
      offer({ net, len: +len, mask: N.lenToMask(+len), proto: 'B', ibgp: e.ibgp, path: e.path, ad: e.ibgp ? AD.iBGP : AD.eBGP, metric: 0, nh: e.nh, ifName: null, fromDev: e.fromDev });
    });
    st.rib = rib;
    // Routes a protocol offered that lost to a lower administrative distance or metric.
    st.losers = offers.filter((r) => rib[pfxKey(r.net, r.len)] !== r);
    st.sorted = Object.values(rib).sort((a, b) => b.len - a.len || a.ad - b.ad || a.metric - b.metric);
  }

  // Routes this device feeds into a protocol through "redistribute".
  function redistributed(st, d, list, target) {
    const map = { connected: 'C', static: 'S', ospf: 'O', rip: 'R', bgp: 'B' };
    const out = [];
    (list || []).forEach((src) => {
      if (src === target) return;
      if (src === 'ospf' && !d.routing.ospf.enabled) return;
      if (src === 'rip' && !d.routing.rip.enabled) return;
      if (src === 'bgp' && !d.routing.bgp.enabled) return;
      Object.entries(st.rib).forEach(([k, r]) => { if (r.proto === map[src]) out.push(k); });
    });
    return out;
  }

  function nextOspf(sim, d, tables) {
    const st = sim.rt[d.id];
    const t = {};
    st.ospfIfs.forEach(({ i }) => {
      const k = i.kind === 'loopback' ? pfxKey(i.ip, 32) : pfxKey(i.net, i.len);
      t[k] = { metric: ospfCost(i.name), local: true };
    });
    if (d.routing.ospf.enabled) {
      redistributed(st, d, d.routing.ospf.redistribute, 'ospf').forEach((k) => { if (!t[k]) t[k] = { metric: 20, ext: true, local: true }; });
      const def = st.rib['0.0.0.0/0'];
      if (d.routing.ospf.defaultOriginate && def && def.proto !== 'O') t['0.0.0.0/0'] = { metric: 1, ext: true, local: true };
    }
    st.ospfAdj.forEach(({ me, them }) => {
      Object.entries(tables[them.devId].ospf).forEach(([k, e]) => {
        if (e.fromDev === d.id || (t[k] && t[k].local)) return;
        const metric = e.ext ? e.metric : e.metric + ospfCost(me.name);
        if (!t[k] || metric < t[k].metric) t[k] = { metric, nh: them.ip, ifName: me.name, fromDev: them.devId, ext: e.ext };
      });
    });
    return t;
  }

  function nextRip(sim, d, tables) {
    const st = sim.rt[d.id];
    const t = {};
    st.ripIfs.forEach(({ i }) => { t[pfxKey(i.net, i.len)] = { metric: 0, local: true }; });
    if (d.routing.rip.enabled) {
      redistributed(st, d, d.routing.rip.redistribute, 'rip').forEach((k) => { if (!t[k]) t[k] = { metric: 3, local: true }; });
      const def = st.rib['0.0.0.0/0'];
      if (d.routing.rip.defaultOriginate && def && def.proto !== 'R') t['0.0.0.0/0'] = { metric: 1, local: true };
    }
    st.ripAdj.forEach(({ me, them }) => {
      Object.entries(tables[them.devId].rip).forEach(([k, e]) => {
        if (e.fromDev === d.id || (t[k] && t[k].local)) return;
        const metric = e.metric + 1;
        if (metric > 15) return;
        if (!t[k] || metric < t[k].metric) t[k] = { metric, nh: them.ip, ifName: me.name, fromDev: them.devId };
      });
    });
    return t;
  }

  function bgpSourceIp(sim, d, n) {
    if (n.updateSource) {
      const ifc = sim.byDev[d.id].find((i) => i.name === n.updateSource);
      return ifc ? ifc.ip : '';
    }
    const r = resolve(sim, d.id, N.ip2n(n.ip));
    const ifc = r && sim.byDev[d.id].find((i) => i.name === r.ifName);
    return ifc ? ifc.ip : '';
  }

  function bgpState(sim, d, n) {
    const peerIf = ownerOf(sim, n.ip);
    const fail = (reason) => ({ state: 'Idle', reason });
    if (N.ip2n(n.ip) === null) return fail('Neighbor address is not valid.');
    if (!peerIf || !peerIf.up) return fail(`No active interface owns ${n.ip}.`);
    const peer = peerIf.dev;
    if (!peer.routing || !peer.routing.bgp.enabled) return fail(`${peer.name} is not running BGP.`);
    if (String(peer.routing.bgp.asn) !== String(n.remoteAs)) return fail(`${peer.name} is in AS ${peer.routing.bgp.asn}, not AS ${n.remoteAs}.`);
    const back = peer.routing.bgp.neighbors.find((x) => {
      const o = ownerOf(sim, x.ip);
      return o && o.devId === d.id;
    });
    if (!back) return fail(`${peer.name} has no neighbor statement pointing back at ${d.name}.`);
    if (String(back.remoteAs) !== String(d.routing.bgp.asn)) return fail(`${peer.name} expects remote-as ${back.remoteAs}, but ${d.name} is in AS ${d.routing.bgp.asn}.`);
    const fwd = resolve(sim, d.id, N.ip2n(n.ip));
    const rev = resolve(sim, peer.id, N.ip2n(back.ip));
    if (!fwd || !rev) return fail(`${d.name} and ${peer.name} cannot reach each other's peering address yet.`);
    const ebgp = String(d.routing.bgp.asn) !== String(peer.routing.bgp.asn);
    if (ebgp && fwd.route.proto !== 'C') return fail(`eBGP peers must be directly connected unless ebgp-multihop is set. ${n.ip} is not on a connected subnet.`);
    const srcMine = bgpSourceIp(sim, d, n);
    const srcTheirs = bgpSourceIp(sim, peer, back);
    if (srcMine !== back.ip && srcTheirs !== n.ip) {
      return fail(`${peer.name} expects ${d.name} to peer from ${back.ip}, but ${d.name} sources from ${srcMine}. Set update-source.`);
    }
    // Either side may open the TCP session to port 179; the answer comes back from port 179.
    const inOn = (dev, r) => (sim.byDev[dev.id] || []).find((i) => i.name === r.ifName);
    const myIn = inOn(d, fwd);
    const theirIn = inOn(peer, rev);
    const opens = (toIf, fromIp, toIp, backIf) => (!toIf || admits(toIf, { src: fromIp, dst: toIp, proto: 'tcp', sport: 49152, dport: 179 }))
      && (!backIf || admits(backIf, { src: toIp, dst: fromIp, proto: 'tcp', sport: 179, dport: 49152, established: true }));
    if (!opens(theirIn, back.ip, n.ip, myIn) && !opens(myIn, n.ip, back.ip, theirIn)) {
      const where = [myIn && myIn.aclIn ? `${d.name} ${shortName(myIn.name)} (${myIn.aclIn})` : '', theirIn && theirIn.aclIn ? `${peer.name} ${shortName(theirIn.name)} (${theirIn.aclIn})` : ''].filter(Boolean).join(' or ');
      return fail(`An inbound ACL on ${where} drops BGP's TCP port 179 traffic. Permit tcp port 179 between the peers.`);
    }
    return { state: 'Established', peer, back, ebgp };
  }

  function nextBgp(sim, d, tables) {
    const st = sim.rt[d.id];
    const b = d.routing.bgp;
    const t = {};
    st.bgpSessions = [];
    if (!b.enabled) return t;
    b.networks.forEach((n) => {
      const len = N.maskToLen(n.mask);
      if (len === null || N.ip2n(n.net) === null) return;
      const k = pfxKey(N.network(n.net, n.mask), len);
      if (st.rib[k] && st.rib[k].proto !== 'B') t[k] = { path: [], local: true };
    });
    redistributed(st, d, b.redistribute, 'bgp').forEach((k) => { if (!t[k]) t[k] = { path: [], local: true }; });
    b.neighbors.forEach((n) => {
      const res = bgpState(sim, d, n);
      st.bgpSessions.push({ neighbor: n, state: res.state, reason: res.reason || '' });
      if (res.state !== 'Established') return;
      Object.entries(tables[res.peer.id].bgp).forEach(([k, e]) => {
        if (!res.ebgp && e.ibgp) return;
        if (res.ebgp && e.path.map(String).includes(String(b.asn))) return;
        if (e.fromDev === d.id || (t[k] && t[k].local)) return;
        const path = res.ebgp ? [res.peer.routing.bgp.asn, ...e.path] : e.path;
        const nh = res.ebgp || e.local || res.back.nextHopSelf ? n.ip : e.nh;
        const valid = !!resolve(sim, d.id, N.ip2n(nh));
        const cand = { path, nh, ibgp: !res.ebgp, fromDev: res.peer.id, valid };
        const cur = t[k];
        if (!cur || (valid && !cur.valid) || (valid === cur.valid && (path.length < cur.path.length || (path.length === cur.path.length && cur.ibgp && !cand.ibgp)))) t[k] = cand;
      });
    });
    return t;
  }

  function converge(sim) {
    const routers = sim.project.devices.filter(M.canRoute);
    routers.forEach((d) => {
      sim.rt[d.id] = { rib: {}, sorted: [], ospf: {}, rip: {}, bgp: {}, bgpSessions: [] };
    });
    computeAdjacencies(sim, routers);
    electDrs(sim, routers);
    let last = '';
    for (let round = 0; round < 40; round++) {
      routers.forEach((d) => installRib(sim, d));
      const tables = {};
      routers.forEach((d) => { tables[d.id] = sim.rt[d.id]; });
      const next = routers.map((d) => ({ d, ospf: nextOspf(sim, d, tables), rip: nextRip(sim, d, tables), bgp: nextBgp(sim, d, tables) }));
      next.forEach((n) => Object.assign(sim.rt[n.d.id], { ospf: n.ospf, rip: n.rip, bgp: n.bgp }));
      const snap = JSON.stringify(next.map((n) => [n.ospf, n.rip, n.bgp, sim.rt[n.d.id].rib]));
      if (snap === last) break;
      last = snap;
    }
    routers.forEach((d) => installRib(sim, d));
  }

  // A pool on server that covers addr, the client's subnet as the server sees it.
  const poolFor = (server, addr) => server.dhcp.pools.find((pl) => {
    const len = N.maskToLen(pl.mask);
    return N.ip2n(pl.network) !== null && len !== null && N.inNet(addr, pl.network, pl.mask);
  });

  function excludedOn(server, n) {
    return server.dhcp.excluded.some((e) => {
      const a = N.ip2n(e.from);
      const b = N.ip2n(e.to || e.from);
      return a !== null && b !== null && n >= Math.min(a, b) && n <= Math.max(a, b);
    });
  }

  // Finds a DHCP server for one client: a pool on a router in the client's broadcast domain,
  // or a relay (ip helper-address) on the client's gateway pointing at a reachable server.
  // DHCP snooping drops server messages (OFFER, ACK) that arrive on an untrusted port, so
  // every snooping switch between client and server must trust its port toward the server.
  function snoopingBlock(sim, clientKey, g) {
    const p = sim.project;
    const path = l2Steps(sim, clientKey, g.key);
    if (!path) return '';
    for (let i = 0; i < path.length; i++) {
      const m = /^v:([^:]+):(\d+)$/.exec(path[i].key);
      if (!m) continue;
      const sw = M.dev(p, m[1]);
      const sn = sw && sw.snooping;
      if (!sn || !sn.on || !N.expandList(sn.vlans).includes(+m[2])) continue;
      const next = path[i + 1];
      if (!next || !next.link) continue;
      const l = p.links.find((x) => x.id === next.link);
      const name = M.endIf(l, sw.id);
      if (!(sw.ports[name] || {}).trust) return `DHCP snooping on ${sw.name} drops ${g.dev.name}'s offers arriving on untrusted ${shortName(name)}. Add "ip dhcp snooping trust" there if ${g.dev.name} is the real server`;
    }
    return '';
  }

  function findServer(sim, dom, clientKey) {
    const all = sim.ifaces.filter((i) => i.domain === dom && i.up && i.ip && M.canRoute(i.dev));
    // A client's DISCOVER is a broadcast from udp 68 to 67; an inbound list must let it in.
    const discover = { src: '0.0.0.0', dst: '255.255.255.255', proto: 'udp', sport: 68, dport: 67 };
    const why = [];
    const gws = all.filter((g) => {
      if (!admits(g, discover)) {
        why.push(`inbound ACL ${g.aclIn} on ${g.dev.name} ${shortName(g.name)} drops DHCP requests (udp 67). Add "permit udp any any eq 67" above any deny`);
        return false;
      }
      const snoop = clientKey && (poolFor(g.dev, g.ip) || (g.cfg.helper || '').trim()) ? snoopingBlock(sim, clientKey, g) : '';
      if (snoop) {
        why.push(snoop);
        return false;
      }
      return true;
    });
    for (const g of gws) {
      const pool = poolFor(g.dev, g.ip);
      if (pool) return { server: g.dev, pool, giaddr: g.ip };
    }
    for (const g of gws) {
      const helper = (g.cfg.helper || '').trim();
      if (!helper) continue;
      const target = ownerOf(sim, helper);
      if (!target) {
        why.push(`the helper address ${helper} on ${g.dev.name} ${shortName(g.name)} belongs to no device`);
        continue;
      }
      const server = target.dev;
      if (!resolve(sim, g.devId, N.ip2n(helper)) && server !== g.dev) {
        why.push(`${g.dev.name} has no route to the DHCP server ${helper}`);
        continue;
      }
      if (server !== g.dev && !resolve(sim, server.id, N.ip2n(g.ip))) {
        why.push(`${server.name} has no route back to the relay address ${g.ip}`);
        continue;
      }
      const pool = poolFor(server, g.ip);
      if (!pool) {
        why.push(`${server.name} has no pool covering ${g.net}/${g.len}`);
        continue;
      }
      return { server, pool, giaddr: g.ip, relay: g.dev };
    }
    if (why.length) return { reason: `DHCP fails: ${why.join('; ')}.` };
    if (!gws.length) return { reason: 'No router or Layer 3 switch has an address in this VLAN to serve or relay DHCP.' };
    const g = gws[0];
    return { reason: `No DHCP pool for ${g.net}/${g.len} on ${g.dev.name}, and no ip helper-address on ${shortName(g.name)}.` };
  }

  function assignLeases(sim) {
    const p = sim.project;
    sim.leases = {};
    const used = new Set(sim.ifaces.filter((i) => i.ip).map((i) => N.ip2n(i.ip)));
    p.devices.filter((d) => M.isHost(d) && d.ipMode === 'dhcp').forEach((d) => {
      const l = M.linksOf(p, d.id)[0];
      if (!l) return (sim.leases[d.id] = { ok: false, reason: 'Not cabled to anything.' });
      if (sim.down.has(l.id)) return (sim.leases[d.id] = { ok: false, reason: 'Port security err-disabled the switch port this device is plugged into.' });
      if (!linkIsUp(sim, l)) return (sim.leases[d.id] = { ok: false, reason: 'The cable is shut down.' });
      const ps = sim.portSec.find((x) => x.dropped && x.dropped.includes(d.id));
      if (ps) return (sim.leases[d.id] = { ok: false, reason: `Port security (${ps.violation}) on ${M.dev(p, ps.devId).name} ${shortName(ps.ifName)} drops this device: the port already learned its maximum of ${ps.max} MAC address${ps.max > 1 ? 'es' : ''}.` });
      const dom = sim.domainOf[ikey(d.id, 'Ethernet0')];
      const found = dom ? findServer(sim, dom, ikey(d.id, 'Ethernet0')) : { reason: 'The cable does not reach any VLAN.' };
      if (!found.server) return (sim.leases[d.id] = { ok: false, reason: found.reason });
      const { server, pool } = found;
      const base = N.ip2n(pool.network);
      const size = 2 ** (32 - N.maskToLen(pool.mask));
      let pick = null;
      for (let n = base + 1; n < base + size - 1; n++) {
        if (!used.has(n) && !excludedOn(server, n)) {
          pick = n;
          break;
        }
      }
      if (pick === null) return (sim.leases[d.id] = { ok: false, reason: `Pool ${pool.name} on ${server.name} has no free addresses.` });
      used.add(pick);
      const lease = {
        ok: true, ip: N.n2ip(pick), mask: pool.mask, gateway: pool.gateway || '', dns: pool.dns || '',
        server: server.name, pool: pool.name, relay: found.relay ? found.relay.name : '',
      };
      sim.leases[d.id] = lease;
      const ifc = makeIface(d, 'Ethernet0', { ip: lease.ip, mask: lease.mask }, 'port', { link: l.id });
      ifc.up = true;
      ifc.domain = dom;
      sim.ifaces.push(ifc);
      sim.byDev[d.id].push(ifc);
    });
  }

  // The gateway a host uses: from its DHCP lease, or typed in.
  const gatewayOf = (sim, d) => (sim.leases[d.id] ? sim.leases[d.id].gateway : d.gateway);

  function simulate(project) {
    const sim = { project, adj: {}, domainOf: {}, ifaces: [], byDev: {}, rt: {}, leases: {}, down: new Set(), vips: [], hsrp: [] };
    portSecurity(sim);
    sim.stp = PL.stp.compute(project, sim.down);
    buildL2(sim);
    buildIfaces(sim);
    electHsrp(sim);
    natGlobals(sim);
    converge(sim);
    assignLeases(sim);
    if (PL.ipv6) sim.v6 = PL.ipv6.simulate(sim);
    return sim;
  }

  // Shortest L2 path between two interfaces, returning the links and switches crossed.
  function l2Path(sim, from, to) {
    const prev = { [from]: null };
    const queue = [from];
    while (queue.length) {
      const cur = queue.shift();
      if (cur === to) break;
      (sim.adj[cur] || []).forEach((e) => {
        if (!(e.to in prev)) {
          prev[e.to] = { from: cur, link: e.link };
          queue.push(e.to);
        }
      });
    }
    if (!(to in prev)) return null;
    const links = [];
    const switches = [];
    for (let k = to; prev[k]; k = prev[k].from) {
      if (prev[k].link) links.unshift(prev[k].link);
      if (k.startsWith('v:')) switches.unshift(k.split(':')[1]);
    }
    return { links, switches: [...new Set(switches)] };
  }

  // The broadcast-domain keys from one interface to another, each with the cable it was reached by.
  function l2Steps(sim, from, to) {
    const prev = { [from]: null };
    const queue = [from];
    while (queue.length) {
      const cur = queue.shift();
      if (cur === to) break;
      (sim.adj[cur] || []).forEach((e) => {
        if (!(e.to in prev)) {
          prev[e.to] = { from: cur, link: e.link };
          queue.push(e.to);
        }
      });
    }
    if (!(to in prev)) return null;
    const out = [];
    for (let k = to; k; k = prev[k] ? prev[k].from : null) out.unshift({ key: k, link: prev[k] ? prev[k].link : null });
    return out;
  }

  // A blank port box matches any port, as an ACL line without a port clause does.
  function portHit(proto, op, a, b, port) {
    if (!op || op === 'any' || String(a === undefined || a === null ? '' : a).trim() === '') return true;
    const lo = portNum(proto, a);
    if (lo === null || port === undefined) return false;
    if (op === 'eq') return port === lo;
    if (op === 'neq') return port !== lo;
    if (op === 'gt') return port > lo;
    if (op === 'lt') return port < lo;
    const hi = portNum(proto, b);
    return op === 'range' && hi !== null && port >= lo && port <= hi;
  }

  function aclCheck(d, name, pkt) {
    if (!name) return { ok: true };
    const acl = d.acls.find((a) => a.name === name);
    if (!acl) return { ok: true, note: `ACL ${name} is not defined, so IOS permits everything.` };
    const src = N.ip2n(pkt.src);
    const dst = N.ip2n(pkt.dst);
    for (let i = 0; i < acl.rules.length; i++) {
      const r = acl.rules[i];
      if (r.remark !== undefined) continue;
      const a = N.parseAclAddr(r.src);
      if (!a || !N.wildMatch(src, a)) continue;
      if (acl.type === 'extended') {
        const b = N.parseAclAddr(r.dst);
        if (!b || !N.wildMatch(dst, b)) continue;
        if (r.proto !== 'ip' && r.proto !== pkt.proto) continue;
        if (r.proto === 'tcp' || r.proto === 'udp') {
          if (!portHit(r.proto, r.srcOp, r.srcPort, r.srcPort2, pkt.sport)) continue;
          if (!portHit(r.proto, r.op, r.port, r.port2, pkt.dport)) continue;
        }
        if (r.proto === 'tcp' && r.established && !pkt.established) continue;
        if (r.proto === 'icmp' && r.icmpType && r.icmpType !== pkt.icmp) continue;
      }
      return { ok: r.action === 'permit', line: i + 1, acl, rule: r };
    }
    return { ok: false, implicit: true, acl };
  }

  function aclText(check, name, dir, ifName) {
    const where = `ACL ${name} ${dir} on ${shortName(ifName)}`;
    return check.implicit ? `${where}: dropped by the implicit deny at the end of the list.` : `${where}: dropped by line ${check.line}.`;
  }

  // Walks one packet from srcDev toward pkt.dst, returning hops and the links crossed.
  // Inside-to-outside: static entries first, then PAT for sources the overload list permits.
  function natOut(sim, d, ingress, egress, pkt, nat) {
    if (!d.nat || !ingress || ingress.cfg.nat !== 'inside' || egress.cfg.nat !== 'outside') return '';
    const st = d.nat.statics.find((s) => s.local === pkt.src);
    if (st) {
      nat.push({ dev: d.id, local: pkt.src, global: st.global, kind: 'static' });
      pkt.src = st.global;
      return `NAT: source ${st.local} becomes ${st.global} (static)`;
    }
    const pat = d.nat.pat;
    if (!pat || pat.iface !== egress.name || !d.acls.some((a) => a.name === pat.acl)) return '';
    if (!aclCheck(d, pat.acl, { src: pkt.src, dst: pkt.dst, proto: pkt.proto }).ok) return '';
    nat.push({ dev: d.id, local: pkt.src, global: egress.ip, kind: 'pat', port: pkt.sport });
    const from = pkt.src;
    pkt.src = egress.ip;
    return `NAT: source ${from} becomes ${egress.ip} (PAT overload)`;
  }

  // Outside-to-inside: un-translate replies, and let outside hosts in through static entries.
  function natIn(sim, d, ingress, pkt, nat) {
    if (!d.nat || !ingress || ingress.cfg.nat !== 'outside') return '';
    const hit = nat.slice().reverse().find((x) => x.dev === d.id && x.global === pkt.dst);
    const st = hit || d.nat.statics.find((s) => s.global === pkt.dst);
    if (!st) return '';
    pkt.dst = st.local;
    return `NAT: destination ${st.global} becomes ${st.local}${hit && hit.kind === 'pat' ? ' (PAT entry)' : ' (static)'}`;
  }

  function walk(sim, srcDev, pkt, nat) {
    const p = sim.project;
    nat = nat || [];
    const hops = [];
    const links = [];
    const done = (ok, reason, endDev) => ({ ok, reason, hops, links, endDev });
    const owns = (d) => (sim.byDev[d.id] || []).find((i) => i.ip === pkt.dst && i.up) || sim.vips.find((i) => i.devId === d.id && i.ip === pkt.dst && !i.natStatic);
    let cur = srcDev;
    let ingress = null;
    let dstN = N.ip2n(pkt.dst);
    if (dstN === null) return done(false, `${pkt.dst} is not a valid address.`);
    for (let ttl = 0; ttl < 32; ttl++) {
      const hop = { dev: cur.name, devId: cur.id, in: ingress ? ingress.name : '', out: '', via: [] };
      hops.push(hop);
      if (ingress) {
        const chk = aclCheck(cur, ingress.aclIn, pkt);
        if (!chk.ok) {
          hop.fail = aclText(chk, ingress.aclIn, 'in', ingress.name);
          return done(false, `${cur.name}: ${hop.fail}`);
        }
      }
      if (M.canRoute(cur)) {
        const t = natIn(sim, cur, ingress, pkt, nat);
        if (t) {
          hop.nat = t;
          dstN = N.ip2n(pkt.dst);
        }
      }
      if (owns(cur)) return done(true, '', cur);
      const drop = sim.portSec.find((x) => x.dropped && x.dropped.includes(cur.id));
      if (!ingress && drop) {
        hop.fail = `Port security (${drop.violation}) on ${M.dev(p, drop.devId).name} ${shortName(drop.ifName)} drops frames from ${cur.name}.`;
        return done(false, hop.fail);
      }
      if (ingress && !M.canRoute(cur)) {
        hop.fail = `${cur.name} received the packet but does not route.`;
        return done(false, hop.fail);
      }
      let egress;
      let nhIp;
      if (M.canRoute(cur)) {
        const r = resolve(sim, cur.id, dstN);
        if (!r) {
          hop.fail = `No route to ${pkt.dst}.`;
          return done(false, `${cur.name} has no route to ${pkt.dst}.`);
        }
        egress = sim.byDev[cur.id].find((i) => i.name === r.ifName);
        nhIp = r.nhIp;
        hop.route = r.route;
      } else {
        egress = sim.byDev[cur.id].find((i) => i.ip && i.up) || sim.byDev[cur.id].find((i) => i.ip);
        if (!egress) {
          hop.fail = 'No IP address configured.';
          return done(false, `${cur.name} has no IP address.`);
        }
        if (!egress.up) {
          hop.fail = `${shortName(egress.name)} is down.`;
          return done(false, `${cur.name}: ${hop.fail}`);
        }
        if (N.inNet(pkt.dst, egress.net, egress.mask)) nhIp = pkt.dst;
        else {
          nhIp = gatewayOf(sim, cur);
          if (!nhIp) {
            hop.fail = 'No default gateway set.';
            return done(false, `${cur.name} has no default gateway, so it cannot reach ${pkt.dst}.`);
          }
        }
      }
      hop.out = egress.name;
      if (!pkt.src) pkt.src = egress.ip;
      if (M.canRoute(cur)) {
        const t = natOut(sim, cur, ingress, egress, pkt, nat);
        if (t) hop.nat = t;
      }
      if (ingress) {
        const chk = aclCheck(cur, egress.aclOut, pkt);
        if (!chk.ok) {
          hop.fail = aclText(chk, egress.aclOut, 'out', egress.name);
          return done(false, `${cur.name}: ${hop.fail}`);
        }
      }
      const target = sim.ifaces.find((i) => i.ip === nhIp && i.up && i.domain && i.domain === egress.domain)
        || sim.vips.find((i) => i.ip === nhIp && i.domain === egress.domain);
      if (!target) {
        hop.fail = `ARP for ${nhIp} gets no answer on ${shortName(egress.name)}.`;
        return done(false, `${cur.name}: ${hop.fail}`);
      }
      const path = l2Path(sim, egress.key, target.key);
      if (path) {
        links.push(...path.links);
        hop.via = path.switches.map((id) => M.dev(p, id)).filter(Boolean).map((d) => d.name);
      }
      ingress = target;
      cur = target.dev;
    }
    return done(false, 'TTL expired. There is a routing loop.');
  }

  function ping(sim, fromId, toIp, svc) {
    const src = M.dev(sim.project, fromId);
    const proto = (svc && svc.proto) || 'icmp';
    const dport = (svc && +svc.port) || 0;
    // Clients send from an ephemeral port; the reply comes back from the service port.
    const sport = proto === 'icmp' ? undefined : 49152;
    const pkt = { src: '', dst: String(toIp || '').trim(), proto, sport, dport, icmp: 'echo', established: false };
    const nat = [];
    const fwd = walk(sim, src, pkt, nat);
    if (!fwd.ok) return { ok: false, fwd, reason: fwd.reason, nat };
    const reply = { src: pkt.dst, dst: pkt.src, proto, sport: dport || undefined, dport: sport, icmp: 'echo-reply', established: true };
    const back = walk(sim, fwd.endDev, reply, nat);
    return { ok: back.ok, fwd, back, nat, reason: back.ok ? '' : `Return path failed. ${back.reason}` };
  }

  function hostAddr(sim, d) {
    const i = (sim.byDev[d.id] || []).find((x) => x.ip);
    return i ? i.ip : '';
  }

  function matrix(sim) {
    const hosts = sim.project.devices.filter(M.isHost);
    const rows = hosts.map((a) => hosts.map((b) => {
      if (a === b) return null;
      const to = hostAddr(sim, b);
      if (!hostAddr(sim, a) || !to) {
        const bad = !hostAddr(sim, a) ? a : b;
        const lease = sim.leases[bad.id];
        return { ok: false, reason: lease ? `${bad.name} gets no DHCP lease. ${lease.reason}` : `${bad.name} has no IP address.` };
      }
      const r = ping(sim, a.id, to);
      return { ok: r.ok, reason: r.reason };
    }));
    return { hosts, rows };
  }

  function showRoutes(sim, d) {
    const st = sim.rt[d.id];
    if (!st) return [];
    const lines = [];
    upIfaces(sim, d).forEach((i) => {
      if (i.len < 32) {
        lines.push({ sort: [N.ip2n(i.ip), 32], code: 'L', proto: 'L', net: i.ip, len: 32, ifName: i.name, text: `${i.ip}/32 is directly connected, ${shortName(i.name)}` });
      }
    });
    st.sorted.forEach((r) => lines.push(routeLine(sim, d, r)));
    return lines.sort((a, b) => a.sort[0] - b.sort[0] || a.sort[1] - b.sort[1]);
  }

  // One route as "show ip route" prints it, plus the fields the Routes view needs: the exit
  // interface for recursive routes and the device the route was learned from.
  function routeLine(sim, d, r) {
    const code = (r.proto === 'O' && r.ext ? 'O E2' : r.proto) + (r.len === 0 ? '*' : '');
    const where = r.proto === 'C'
      ? `is directly connected, ${shortName(r.ifName)}`
      : `[${r.ad}/${r.metric}] ${r.nh ? `via ${r.nh}` : 'is directly connected'}${r.ifName ? `, ${shortName(r.ifName)}` : ''}`;
    const exit = r.ifName || (r.nh && (resolve(sim, d.id, N.ip2n(r.nh)) || {}).ifName) || '';
    const owner = r.fromDev ? M.dev(sim.project, r.fromDev) : r.nh ? (ownerOf(sim, r.nh) || {}).dev : null;
    return {
      sort: [N.ip2n(r.net), r.len], code, text: `${r.net}/${r.len} ${where}`,
      proto: r.proto, net: r.net, len: r.len, ad: r.ad, metric: r.metric, nh: r.nh || '', ifName: exit,
      from: owner ? owner.name : '', path: r.path || null,
    };
  }

  // Routes each protocol offered that the table did not install, with the route that beat them.
  function hiddenRoutes(sim, d) {
    const st = sim.rt[d.id];
    if (!st) return [];
    return (st.losers || []).map((r) => ({ ...routeLine(sim, d, r), winner: routeLine(sim, d, st.rib[`${r.net}/${r.len}`]) }))
      .sort((a, b) => a.sort[0] - b.sort[0] || a.sort[1] - b.sort[1]);
  }

  // The predicted "show ip bgp" table: every prefix in the BGP table, local ones included.
  function bgpTable(sim, d) {
    const st = sim.rt[d.id];
    if (!st || !d.routing.bgp.enabled) return [];
    return Object.entries(st.bgp).map(([k, e]) => {
      const [net, len] = k.split('/');
      const from = e.fromDev ? M.dev(sim.project, e.fromDev) : null;
      const best = !e.local && st.rib[k] && st.rib[k].proto === 'B';
      return { net, len: +len, nh: e.local ? '0.0.0.0' : e.nh, path: e.path || [], local: !!e.local, ibgp: !!e.ibgp, valid: e.valid !== false, best: e.local || best, from: from ? from.name : '' };
    }).sort((a, b) => N.ip2n(a.net) - N.ip2n(b.net) || a.len - b.len);
  }

  PL.simulate = { simulate, ping, matrix, showRoutes, hiddenRoutes, bgpTable, hostAddr, peersOn, resolve, aclCheck, ospfIfaces, gatewayOf, l2Steps, l2Path, linkIsUp, ikey, vkey };
})(typeof window !== 'undefined' ? (window.PL = window.PL || {}) : (globalThis.PL = globalThis.PL || {}));
