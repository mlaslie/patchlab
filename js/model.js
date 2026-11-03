// The project document: devices, links, VLANs, plus the helpers that keep them consistent.
// A link owns its L2 settings (mode, VLAN, native, allowed list), so both ends of a cable
// always agree. Port-level L3 settings live on the device under ports[interfaceName].
(function (PL) {
  'use strict';

  const { MODELS, portSpeed, naturalCompare } = PL.catalog;
  const N = PL.net;

  const EC_PRESETS = {
    'lacp-aa': { proto: 'lacp', label: 'LACP (active / active)', a: 'active', b: 'active' },
    'lacp-ap': { proto: 'lacp', label: 'LACP (active / passive)', a: 'active', b: 'passive' },
    'pagp-dd': { proto: 'pagp', label: 'PAgP (desirable / desirable)', a: 'desirable', b: 'desirable' },
    'pagp-da': { proto: 'pagp', label: 'PAgP (desirable / auto)', a: 'desirable', b: 'auto' },
    'on': { proto: 'on', label: 'Static (on / on)', a: 'on', b: 'on' },
  };

  const uid = (() => {
    let n = 0;
    return (p) => `${p}${Date.now().toString(36)}${(n++).toString(36)}`;
  })();

  function newProject(name) {
    return {
      version: 1,
      name: name || 'Untitled lab',
      vlans: [{ id: 1, name: 'default', subnet: '', mask: '' }],
      devices: [],
      links: [],
      settings: {
        enableSecret: 'class', consolePassword: 'cisco', vtyPassword: 'cisco',
        banner: 'Authorized access only', domainName: '', ssh: false, shutUnused: false,
        portfastHosts: true, nonegotiate: true,
      },
    };
  }

  function newRouting() {
    return {
      static: [],
      ospf: { enabled: false, pid: 1, routerId: '', networks: [], passive: [], redistribute: [], defaultOriginate: false },
      rip: { enabled: false, networks: [], passive: [], redistribute: [], defaultOriginate: false },
      bgp: { enabled: false, asn: '', routerId: '', neighbors: [], networks: [], redistribute: [] },
      static6: [],
      ospf3: { enabled: false, pid: 1, routerId: '' },
    };
  }

  // A DHCP server's pools and excluded ranges. Relays are "helper" on each interface.
  function newDhcp() {
    return { pools: [], excluded: [] };
  }

  // A stable made-up burned-in MAC, in Cisco dotted form. Spanning tree breaks priority ties
  // on it and IPv6 builds EUI-64 addresses from it; real hardware will have its own.
  function macFor(id) {
    let h = 2166136261;
    for (const ch of String(id)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    const hex = (h.toString(16) + '00000000').slice(0, 8);
    return `0050.${hex.slice(0, 2)}${hex.slice(2, 4)}.${hex.slice(4, 8)}`;
  }

  const newExtras = (id) => ({
    stp: { priority: {}, mac: macFor(id) }, nat: { pat: null, statics: [] }, snooping: { on: false, vlans: '' },
    ip6Mode: 'none', gateway6: '',
  });

  const dev = (p, id) => p.devices.find((d) => d.id === id);
  const kindOf = (d) => MODELS[d.model].kind;
  const isRouter = (d) => kindOf(d) === 'router';
  const isHost = (d) => kindOf(d) === 'host';
  const isL3Switch = (d) => kindOf(d) === 'l3switch';
  const isSwitch = (d) => kindOf(d) === 'l2switch' || isL3Switch(d);
  const canRoute = (d) => isRouter(d) || isL3Switch(d);

  function nextName(p, prefix) {
    const used = new Set(p.devices.map((d) => d.name));
    for (let i = 1; ; i++) if (!used.has(`${prefix}${i}`)) return `${prefix}${i}`;
  }

  function addDevice(p, model, x, y, name) {
    const d = {
      id: uid('d'), model, name: name || nextName(p, MODELS[model].prefix), x, y,
      ports: {}, svis: [], loopbacks: [], gateway: '', dns: '', acls: [], vtyAcl: '', routing: newRouting(),
      ipMode: 'static', dhcp: newDhcp(),
    };
    Object.assign(d, newExtras(d.id));
    p.devices.push(d);
    return d;
  }

  function port(d, name) {
    if (!d.ports[name]) d.ports[name] = { desc: '', shutdown: false, ip: '', mask: '', aclIn: '', aclOut: '', subifs: [] };
    return d.ports[name];
  }

  const side = (l, id) => (l.a === id ? 'a' : 'b');
  const otherSide = (s) => (s === 'a' ? 'b' : 'a');
  const linksOf = (p, id) => p.links.filter((l) => l.a === id || l.b === id);
  const peerOf = (l, id) => (l.a === id ? l.b : l.a);

  function linkOnPort(p, id, name) {
    return p.links.find((l) => (l.a === id || l.b === id) && l.members.some((m) => m[side(l, id)] === name));
  }

  const freePorts = (p, d) => MODELS[d.model].ports.filter((n) => !linkOnPort(p, d.id, n));

  // The interface that carries L3 and L2 settings for this end: the Port-channel when bundled.
  function endIf(l, id) {
    const s = side(l, id);
    return l.ec ? `Port-channel${s === 'a' ? l.ec.groupA : l.ec.groupB}` : l.members[0][s];
  }

  // True when this end of the link is a routed interface rather than a switchport.
  function isL3End(p, l, id) {
    const d = dev(p, id);
    return !isSwitch(d) || (isL3Switch(d) && l.mode === 'routed');
  }

  function allowedModes(a, b) {
    const sw = [a, b].filter(isSwitch).length;
    if (sw === 0) return ['routed'];
    if (sw === 2) return canRoute(a) && canRoute(b) ? ['trunk', 'routed', 'access'] : ['trunk', 'access'];
    const other = isSwitch(a) ? b : a;
    const swDev = isSwitch(a) ? a : b;
    if (isHost(other)) return ['access'];
    return isL3Switch(swDev) ? ['trunk', 'access', 'routed'] : ['trunk', 'access'];
  }

  // Picks the fastest free port pair, so uplinks land on Gigabit ports.
  function pickPorts(p, a, b) {
    const rank = (list) => list.slice().sort((x, y) => (portSpeed(y) || 0) - (portSpeed(x) || 0) || naturalCompare(x, y));
    const pa = rank(freePorts(p, a));
    const pb = rank(freePorts(p, b));
    return pa.length && pb.length ? { a: pa[0], b: pb[0] } : null;
  }

  // Access edge ports keep to the low numbers rather than burning the uplinks.
  function pickHostPort(p, sw) {
    const free = freePorts(p, sw);
    const slowest = Math.min(...free.map((n) => portSpeed(n) || 1e9));
    const pool = MODELS[sw.model].ports.length > 8 && free.some((n) => /\/\d+$/.test(n))
      ? free.filter((n) => (portSpeed(n) || 0) === slowest)
      : free;
    return pool[0] || free[0];
  }

  // Side a is the source end (where the cable was drawn from), side b the destination.
  function addLink(p, aId, bId) {
    const a = dev(p, aId);
    const b = dev(p, bId);
    if (!a || !b || a === b) return { error: 'Pick two different devices to connect.' };
    const modes = allowedModes(a, b);
    let pair = pickPorts(p, a, b);
    if (pair && isHost(a) && isSwitch(b)) pair = { a: pair.a, b: pickHostPort(p, b) };
    if (pair && isHost(b) && isSwitch(a)) pair = { a: pickHostPort(p, a), b: pair.b };
    if (!pair) return { error: `No free Ethernet port on ${!freePorts(p, a).length ? a.name : b.name}.` };

    const hasVlans = p.vlans.length > 1;
    let mode = modes[0];
    if (modes.includes('trunk') && !hasVlans && !(isSwitch(a) && isSwitch(b))) mode = 'access';
    const usable = p.vlans.filter((v) => v.id !== 1);
    const lastAccess = [...p.links].reverse().find((l) => l.mode === 'access');
    const link = {
      id: uid('l'), a: aId, b: bId, members: [pair], mode,
      vlan: lastAccess ? lastAccess.vlan : usable.length ? usable[0].id : 1, nativeVlan: 1, allowed: 'all', ec: null,
    };
    p.links.push(link);
    port(a, pair.a);
    port(b, pair.b);
    return { link };
  }

  function removeLink(p, id) {
    p.links = p.links.filter((l) => l.id !== id);
  }

  function removeDevice(p, id) {
    p.links = p.links.filter((l) => l.a !== id && l.b !== id);
    p.devices = p.devices.filter((d) => d.id !== id);
  }

  function renameCfg(d, from, to) {
    if (from === to) return;
    if (d.ports[from]) {
      d.ports[to] = d.ports[from];
      delete d.ports[from];
    }
    if (d.routing) {
      for (const proto of [d.routing.ospf, d.routing.rip]) proto.passive = proto.passive.map((n) => (n === from ? to : n));
    }
  }

  function nextChannelGroup(p, id) {
    const used = new Set(linksOf(p, id).filter((l) => l.ec).map((l) => (l.a === id ? l.ec.groupA : l.ec.groupB)));
    for (let i = 1; ; i++) if (!used.has(i)) return i;
  }

  // Default channel preset that both ends of this link can run.
  function ecPresetFor(a, b) {
    const shared = MODELS[a.model].ec.filter((x) => MODELS[b.model].ec.includes(x));
    if (shared.includes('lacp')) return 'lacp-aa';
    if (shared.includes('on')) return 'on';
    return null;
  }

  function ecPresetsFor(a, b) {
    const shared = MODELS[a.model].ec.filter((x) => MODELS[b.model].ec.includes(x));
    return Object.keys(EC_PRESETS).filter((k) => shared.includes(EC_PRESETS[k].proto));
  }

  // Turning a channel on bundles this cable; unless opts.single, a second member is added too.
  function setChannel(p, l, on, opts) {
    const a = dev(p, l.a);
    const b = dev(p, l.b);
    if (on && !l.ec) {
      const preset = ecPresetFor(a, b);
      if (!preset) return { error: `${MODELS[a.model].label} and ${MODELS[b.model].label} have no channel protocol in common.` };
      const fromA = l.members[0].a;
      const fromB = l.members[0].b;
      l.ec = { preset, groupA: nextChannelGroup(p, l.a), groupB: nextChannelGroup(p, l.b) };
      renameCfg(a, fromA, endIf(l, l.a));
      renameCfg(b, fromB, endIf(l, l.b));
      port(a, fromA);
      port(b, fromB);
      if (opts && opts.single) return {};
      const added = addMember(p, l);
      return added.error ? { warning: added.error } : {};
    }
    if (!on && l.ec) {
      const toA = l.members[0].a;
      const toB = l.members[0].b;
      const poA = endIf(l, l.a);
      const poB = endIf(l, l.b);
      l.ec = null;
      l.members = l.members.slice(0, 1);
      delete a.ports[toA];
      delete b.ports[toB];
      renameCfg(a, poA, toA);
      renameCfg(b, poB, toB);
    }
    return {};
  }

  // Adds the next free port pair matching the existing member speed.
  function addMember(p, l) {
    if (l.members.length >= 8) return { error: 'An EtherChannel bundles at most 8 links.' };
    const a = dev(p, l.a);
    const b = dev(p, l.b);
    const pick = (d, s) => {
      const speed = portSpeed(l.members[0][s]);
      return freePorts(p, d).find((n) => portSpeed(n) === speed);
    };
    const pa = pick(a, 'a');
    const pb = pick(b, 'b');
    if (!pa || !pb) return { error: `No free matching port on ${!pa ? a.name : b.name} for another bundle member.` };
    l.members.push({ a: pa, b: pb });
    port(a, pa);
    port(b, pb);
    return {};
  }

  // Other bundles between the same two devices that this cable could join.
  function channelsFor(p, l) {
    return p.links.filter((x) => x !== l && x.ec && [x.a, x.b].sort().join() === [l.a, l.b].sort().join());
  }

  // Moves a single cable into an existing bundle between the same devices. Member ports carry
  // no config of their own, so anything set on them is dropped.
  function joinChannel(p, l, target) {
    if (l.ec) return { error: 'This cable is already part of a bundle.' };
    if (!channelsFor(p, l).includes(target)) return { error: 'The bundle must join the same two devices.' };
    if (target.members.length >= 8) return { error: 'An EtherChannel bundles at most 8 links.' };
    const m = l.members[0];
    const member = target.a === l.a ? { a: m.a, b: m.b } : { a: m.b, b: m.a };
    [[l.a, m.a], [l.b, m.b]].forEach(([id, name]) => {
      const d = dev(p, id);
      d.ports[name] = { ...port(d, name), ip: '', mask: '', aclIn: '', aclOut: '', subifs: [] };
      for (const proto of [d.routing.ospf, d.routing.rip]) proto.passive = proto.passive.filter((n) => n !== name);
    });
    p.links = p.links.filter((x) => x !== l);
    target.members.push(member);
    return { link: target };
  }

  // Takes one member out of a bundle and leaves it as its own cable with the bundle's L2 settings.
  function splitMember(p, l, i) {
    if (!l.ec || l.members.length < 2) return { error: 'Only a bundle with two or more members can be split.' };
    const [m] = l.members.splice(i, 1);
    const link = { ...clone(l), id: uid('l'), members: [m], ec: null };
    p.links.push(link);
    return { link };
  }

  const allowedVlans = (p, l) => (l.allowed === 'all' || !l.allowed ? p.vlans.map((v) => v.id) : N.expandList(l.allowed));

  // VLANs this switch must have in its database, including ones it only carries.
  function vlansOnSwitch(p, d) {
    const set = new Set();
    linksOf(p, d.id).forEach((l) => {
      if (l.mode === 'access') set.add(l.vlan);
      if (l.mode === 'trunk') {
        allowedVlans(p, l).forEach((v) => set.add(v));
        set.add(l.nativeVlan);
      }
    });
    d.svis.forEach((s) => set.add(s.vlan));
    return [...set].filter((v) => v !== 1).sort((a, b) => a - b);
  }

  // A small free /30 from 10.255.x.0, for quick point-to-point addressing.
  function nextP2P(p, used) {
    const taken = new Set(used || []);
    p.devices.forEach((d) => Object.values(d.ports).forEach((c) => c.ip && N.ip2n(c.ip) !== null && taken.add(N.network(c.ip, '255.255.255.252'))));
    for (let i = 0; i < 65536; i += 4) {
      const net = `10.255.${Math.floor(i / 256)}.${i % 256}`;
      if (!taken.has(net)) return { net, a: N.n2ip(N.ip2n(net) + 1), b: N.n2ip(N.ip2n(net) + 2), mask: '255.255.255.252' };
    }
    return null;
  }

  // Creates one sub-interface per VLAN on a trunk, using .1 of each VLAN subnet that has one.
  function subifsFromVlans(p, d, ifName, link) {
    const cfg = port(d, ifName);
    const have = new Set(cfg.subifs.map((s) => s.vlan));
    let added = 0;
    allowedVlans(p, link).forEach((id) => {
      if (id === 1 || have.has(id)) return;
      const v = p.vlans.find((x) => x.id === id);
      const gw = v && v.subnet ? N.n2ip(N.ip2n(v.subnet) + 1) : '';
      cfg.subifs.push({
        num: id, vlan: id, ip: gw, mask: v && v.subnet ? v.mask : '', native: id === link.nativeVlan,
        desc: v ? v.name : '', aclIn: '', aclOut: '',
      });
      added++;
    });
    cfg.subifs.sort((a, b) => a.num - b.num);
    return added;
  }

  // Gateway addresses this device owns, for building DHCP pools from: SVIs, sub-interfaces and
  // routed ports, each with the VLAN it serves when there is one.
  function gatewaysOf(p, d) {
    const out = [];
    d.svis.forEach((s) => s.ip && out.push({ ifName: `Vlan${s.vlan}`, cfg: s, vlan: s.vlan }));
    linksOf(p, d.id).forEach((l) => {
      if (!isL3End(p, l, d.id)) return;
      const name = endIf(l, d.id);
      const c = port(d, name);
      const peer = dev(p, peerOf(l, d.id));
      if (c.ip) out.push({ ifName: name, cfg: c, vlan: isSwitch(peer) && l.mode === 'access' ? l.vlan : null });
      c.subifs.forEach((s) => s.ip && out.push({ ifName: `${name}.${s.num}`, cfg: s, vlan: s.vlan }));
    });
    return out.filter((g) => N.ip2n(g.cfg.ip) !== null && N.maskToLen(g.cfg.mask) !== null);
  }

  // One pool per gateway subnet that has no pool yet, excluding the first ten addresses.
  function dhcpPoolsFromGateways(p, d) {
    let added = 0;
    gatewaysOf(p, d).forEach((g) => {
      const net = N.network(g.cfg.ip, g.cfg.mask);
      if (d.dhcp.pools.some((x) => x.network === net)) return;
      const v = g.vlan && p.vlans.find((x) => x.id === g.vlan);
      const base = N.ip2n(net);
      const name = v && v.id !== 1 ? v.name : `NET-${net.replace(/\./g, '-')}`;
      d.dhcp.pools.push({ name, network: net, mask: g.cfg.mask, gateway: g.cfg.ip, dns: '', domain: '' });
      if (N.maskToLen(g.cfg.mask) <= 28) d.dhcp.excluded.push({ from: N.n2ip(base + 1), to: N.n2ip(base + 10) });
      added++;
    });
    return added;
  }

  // Every end-host in a VLAN with a subnet gets the next free address and that VLAN's gateway.
  function autoAddressHosts(p) {
    const used = new Set();
    p.devices.forEach((d) => {
      Object.values(d.ports).forEach((c) => {
        if (c.ip) used.add(c.ip);
        (c.subifs || []).forEach((s) => s.ip && used.add(s.ip));
      });
      d.svis.forEach((s) => s.ip && used.add(s.ip));
    });
    const gatewayFor = (v) => {
      for (const d of p.devices) {
        for (const s of d.svis) if (s.vlan === v.id && s.ip && !isHost(d) && canRoute(d)) return s.ip;
        for (const c of Object.values(d.ports)) for (const s of c.subifs || []) if (s.vlan === v.id && s.ip) return s.ip;
      }
      return v.subnet ? N.n2ip(N.ip2n(v.subnet) + 1) : '';
    };
    let changed = 0;
    p.devices.filter(isHost).forEach((d) => {
      if (d.ipMode === 'dhcp') return;
      const l = linksOf(p, d.id)[0];
      if (!l || l.mode !== 'access') return;
      const v = p.vlans.find((x) => x.id === l.vlan);
      if (!v || !v.subnet || !v.mask) return;
      const cfg = port(d, 'Ethernet0');
      if (cfg.ip) return;
      const gw = gatewayFor(v);
      let n = N.ip2n(v.subnet) + 10;
      while (used.has(N.n2ip(n)) || N.n2ip(n) === gw) n++;
      if (!N.isHostAddr(N.n2ip(n), v.mask)) return;
      cfg.ip = N.n2ip(n);
      cfg.mask = v.mask;
      d.gateway = gw;
      used.add(cfg.ip);
      changed++;
    });
    return changed;
  }

  function clone(o) {
    return JSON.parse(JSON.stringify(o));
  }

  // Fills fields missing from older or hand-edited saves so the rest of the app can trust the shape.
  function normalize(p) {
    const base = newProject(p.name);
    p.settings = { ...base.settings, ...(p.settings || {}) };
    p.vlans = p.vlans || base.vlans;
    p.links = p.links || [];
    // What a student typed in the CLI lab, per device. Kept with the lab so it saves and reopens.
    p.practice = p.practice && p.practice.devices ? { devices: p.practice.devices, hosts: p.practice.hosts || {} } : { devices: {}, hosts: {} };
    p.devices = (p.devices || []).filter((d) => MODELS[d.model]);
    p.devices.forEach((d) => {
      d.ports = d.ports || {};
      d.svis = d.svis || [];
      d.loopbacks = d.loopbacks || [];
      d.acls = d.acls || [];
      d.ipMode = d.ipMode === 'dhcp' ? 'dhcp' : 'static';
      d.dhcp = { ...newDhcp(), ...(d.dhcp || {}) };
      const x = newExtras(d.id);
      d.stp = { ...x.stp, ...(d.stp || {}) };
      d.stp.priority = d.stp.priority || {};
      d.nat = { ...x.nat, ...(d.nat || {}) };
      d.snooping = { ...x.snooping, ...(d.snooping || {}) };
      d.ip6Mode = ['slaac', 'static'].includes(d.ip6Mode) ? d.ip6Mode : 'none';
      d.gateway6 = d.gateway6 || '';
      const r = newRouting();
      d.routing = { ...r, ...(d.routing || {}) };
      for (const key of ['ospf', 'rip', 'bgp', 'ospf3']) d.routing[key] = { ...r[key], ...d.routing[key] };
      d.routing.static6 = d.routing.static6 || [];
    });
    const ids = new Set(p.devices.map((d) => d.id));
    p.links = p.links.filter((l) => ids.has(l.a) && ids.has(l.b) && Array.isArray(l.members) && l.members.length);
    // Serial WAN cables are no longer offered; older saves lose them and their port settings.
    const serial = (n) => /^Serial/.test(n);
    p.links = p.links.filter((l) => !l.members.some((m) => serial(m.a) || serial(m.b)));
    p.links.forEach((l) => ['medium', 'dce', 'clockRate', 'encap'].forEach((k) => delete l[k]));
    p.devices.forEach((d) => Object.keys(d.ports).filter(serial).forEach((n) => delete d.ports[n]));
    return p;
  }

  PL.model = {
    EC_PRESETS, uid, newProject, addDevice, addLink, removeLink, removeDevice, addMember, setChannel, channelsFor,
    joinChannel, splitMember, port, dev, kindOf,
    isRouter, isHost, isSwitch, isL3Switch, canRoute, side, otherSide, linksOf, peerOf, linkOnPort, freePorts,
    endIf, isL3End, allowedModes, ecPresetsFor, allowedVlans, vlansOnSwitch, nextP2P, subifsFromVlans, autoAddressHosts,
    renameCfg, nextName, clone, normalize, newDhcp, newRouting, macFor, gatewaysOf, dhcpPoolsFromGateways,
  };
})(typeof window !== 'undefined' ? (window.PL = window.PL || {}) : (globalThis.PL = globalThis.PL || {}));
