// Rapid PVST+ prediction: one spanning tree per VLAN over the switch-to-switch cables that
// carry it. Picks the root bridge, each switch's root port, the designated port on every
// segment, and the alternate (blocking) ports left over. No DOM.
(function (PL) {
  'use strict';

  const { MODELS, portSpeed } = PL.catalog;
  const M = PL.model;

  const DEFAULT_PRIORITY = 32768;
  const PRIORITIES = Array.from({ length: 16 }, (_, i) => i * 4096);

  const macNum = (mac) => parseInt(String(mac).replace(/\./g, ''), 16) || 0;

  // Short path-cost method, the IOS default. Bundles count their combined bandwidth.
  function linkCost(l) {
    const speeds = l.members.map((m) => Math.min(portSpeed(m.a) || 100, portSpeed(m.b) || 100));
    const bw = speeds.reduce((s, x) => s + x, 0);
    if (bw >= 10000) return 2;
    if (bw > 1000) return 3;
    if (bw >= 1000) return 4;
    if (bw > 100) return 12;
    if (bw >= 100) return 19;
    return 100;
  }

  // Port numbers as IOS prints them in "128.N": the port's position on the switch, with
  // Port-channels numbered after the physical ports.
  function portId(d, name) {
    const ports = MODELS[d.model].ports;
    const po = /^Port-channel(\d+)$/.exec(name);
    return po ? ports.length + 64 + +po[1] : ports.indexOf(name) + 1;
  }

  const priorityOf = (d, v) => {
    const x = d.stp && d.stp.priority ? d.stp.priority[v] : undefined;
    return x === undefined || x === '' ? DEFAULT_PRIORITY : +x;
  };

  // Compares bridge IDs: priority (plus the VLAN, the extended system ID), then MAC.
  const bidCmp = (a, b) => a.prio - b.prio || macNum(a.mac) - macNum(b.mac);

  function carries(p, l, v) {
    if (l.mode === 'access') return l.vlan === v;
    if (l.mode === 'trunk') return M.allowedVlans(p, l).includes(v);
    return false;
  }

  function computeVlan(p, v, down) {
    const linkUp = (_, l) => !down.has(l.id) && [l.a, l.b].every((id) => !M.port(M.dev(p, id), M.endIf(l, id)).shutdown);
    const switches = p.devices.filter((d) => M.isSwitch(d) && M.vlansOnSwitch(p, d).concat([1]).includes(v));
    const ids = new Set(switches.map((d) => d.id));
    const segs = p.links.filter((l) => ids.has(l.a) && ids.has(l.b) && !M.isL3End(p, l, l.a) && !M.isL3End(p, l, l.b) && carries(p, l, v) && linkUp(p, l));
    const bridges = {};
    switches.forEach((d) => {
      bridges[d.id] = { dev: d, prio: priorityOf(d, v) + v, base: priorityOf(d, v), mac: d.stp ? d.stp.mac : '', cost: null, rootPort: null, rootDev: null, ports: [] };
    });
    // Connected groups of switches each elect their own root.
    const adj = {};
    segs.forEach((l) => {
      (adj[l.a] = adj[l.a] || []).push(l);
      (adj[l.b] = adj[l.b] || []).push(l);
    });
    const group = {};
    let gn = 0;
    switches.forEach((d) => {
      if (group[d.id] !== undefined) return;
      const stack = [d.id];
      group[d.id] = gn;
      while (stack.length) {
        const cur = stack.pop();
        (adj[cur] || []).forEach((l) => {
          const o = M.peerOf(l, cur);
          if (group[o] === undefined) { group[o] = gn; stack.push(o); }
        });
      }
      gn++;
    });
    const roots = {};
    switches.forEach((d) => {
      const g = group[d.id];
      if (!roots[g] || bidCmp(bridges[d.id], bridges[roots[g]]) < 0) roots[g] = d.id;
    });
    Object.values(roots).forEach((id) => { bridges[id].cost = 0; bridges[id].rootDev = id; });

    // Distance-vector convergence on (root cost, sender bridge ID, sender port ID, own port ID).
    const pid = (id, l) => portId(bridges[id].dev, M.endIf(l, id));
    for (let round = 0; round <= switches.length + 1; round++) {
      let changed = false;
      switches.forEach((d) => {
        const me = bridges[d.id];
        if (roots[group[d.id]] === d.id) return;
        let best = null;
        (adj[d.id] || []).forEach((l) => {
          const nb = M.peerOf(l, d.id);
          const b = bridges[nb];
          if (b.cost === null) return;
          const cand = { cost: b.cost + linkCost(l), nb: b, nbPort: pid(nb, l), myPort: pid(d.id, l), l };
          if (!best || (cand.cost - best.cost || bidCmp(cand.nb, best.nb) || cand.nbPort - best.nbPort || cand.myPort - best.myPort) < 0) best = cand;
        });
        if (best && (me.cost !== best.cost || me.rootPort !== best.l.id)) {
          me.cost = best.cost;
          me.rootPort = best.l.id;
          me.rootDev = roots[group[d.id]];
          changed = true;
        }
      });
      if (!changed) break;
    }

    // Each segment's designated port belongs to the end with the better BPDU.
    const blocked = [];
    segs.forEach((l) => {
      const A = bridges[l.a];
      const B = bridges[l.b];
      const vec = (x, id) => [x.cost, x, pid(id, l)];
      const [ca, ba, pa] = vec(A, l.a);
      const [cb, bb, pb] = vec(B, l.b);
      const cmp = ca - cb || bidCmp(ba, bb) || pa - pb;
      const desig = cmp <= 0 ? l.a : l.b;
      [[l.a, A], [l.b, B]].forEach(([id, x]) => {
        const role = x.rootPort === l.id ? 'root' : id === desig ? 'designated' : 'alternate';
        const peer = M.dev(p, M.peerOf(l, id));
        x.ports.push({ name: M.endIf(l, id), linkId: l.id, role, state: role === 'alternate' ? 'BLK' : 'FWD', cost: linkCost(l), id: pid(id, l), peer: peer.name });
        if (role === 'alternate') blocked.push({ linkId: l.id, devId: id, name: M.endIf(l, id) });
      });
    });
    // Ports to hosts, routers and routed ends are designated and forwarding.
    switches.forEach((d) => {
      M.linksOf(p, d.id).forEach((l) => {
        if (segs.includes(l) || M.isL3End(p, l, d.id) || !carries(p, l, v) || !linkUp(p, l)) return;
        const peer = M.dev(p, M.peerOf(l, d.id));
        bridges[d.id].ports.push({ name: M.endIf(l, d.id), linkId: l.id, role: 'designated', state: 'FWD', cost: linkCost(l), id: pid(d.id, l), peer: peer.name, edge: M.isHost(peer) });
      });
      bridges[d.id].ports.sort((a, b) => a.id - b.id);
    });
    const groups = Object.entries(roots).map(([g, root]) => ({
      root, members: switches.filter((d) => group[d.id] === +g).map((d) => d.id),
      tieOnMac: switches.filter((d) => group[d.id] === +g && d.id !== root && bridges[d.id].prio === bridges[root].prio).length > 0,
    }));
    return { vlan: v, bridges, blocked, groups, segs: segs.map((l) => l.id) };
  }

  // down: ids of cables that are not passing traffic for another reason, such as a port
  // security violation.
  function compute(p, down) {
    down = down || new Set();
    const out = { byVlan: {}, blockedKey: new Set() };
    const vlans = new Set([1]);
    p.devices.filter(M.isSwitch).forEach((d) => M.vlansOnSwitch(p, d).forEach((v) => vlans.add(v)));
    [...vlans].sort((a, b) => a - b).forEach((v) => {
      const r = computeVlan(p, v, down);
      if (!Object.keys(r.bridges).length) return;
      out.byVlan[v] = r;
      r.blocked.forEach((b) => out.blockedKey.add(`${b.linkId}|${v}`));
    });
    out.isBlocked = (linkId, v) => out.blockedKey.has(`${linkId}|${v}`);
    return out;
  }

  // The predicted "show spanning-tree vlan N" for one switch.
  function showLines(stp, d, v) {
    const r = stp.byVlan[v];
    const me = r && r.bridges[d.id];
    if (!me) return [`No spanning tree instance exists for VLAN ${v}.`];
    const root = r.bridges[me.rootDev || d.id];
    const rp = me.ports.find((x) => x.role === 'root');
    const out = [
      `VLAN${String(v).padStart(4, '0')}`,
      '  Spanning tree enabled protocol rstp',
      `  Root ID    Priority    ${root.prio}`,
      `             Address     ${root.mac}`,
    ];
    if (root === me) out.push('             This bridge is the root');
    else out.push(`             Cost        ${me.cost}`, `             Port        ${rp ? `${rp.id} (${rp.name})` : ''}`);
    out.push('', `  Bridge ID  Priority    ${me.prio}  (priority ${me.base} sys-id-ext ${v})`, `             Address     ${me.mac}`, '',
      'Interface           Role Sts Cost      Prio.Nbr Type', '------------------- ---- --- --------- -------- --------------------------------');
    const role = { root: 'Root', designated: 'Desg', alternate: 'Altn' };
    me.ports.forEach((x) => {
      out.push(`${PL.catalog.shortName(x.name).padEnd(20)}${role[x.role]} ${x.state} ${String(x.cost).padEnd(10)}128.${String(x.id).padEnd(5)}${x.edge ? 'P2p Edge' : 'P2p'}`);
    });
    return out;
  }

  PL.stp = { compute, showLines, linkCost, portId, PRIORITIES, DEFAULT_PRIORITY };
})(typeof window !== 'undefined' ? (window.PL = window.PL || {}) : (globalThis.PL = globalThis.PL || {}));
