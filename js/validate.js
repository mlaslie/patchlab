// Finds what would stop the lab working, each with a fix the student can act on.
// Severity: error (traffic fails), warn (works but wrong or fragile), info (worth knowing).
(function (PL) {
  'use strict';

  const { MODELS, shortName, portSpeed, portNum } = PL.catalog;
  const N = PL.net;
  const M = PL.model;
  const S = PL.simulate;

  function validate(p, sim) {
    const issues = [];
    const add = (sev, msg, fix, target) => issues.push({ sev, msg, fix: fix || '', ...target });

    checkDevices(p, sim, add);
    checkAddressing(p, sim, add);
    checkLinks(p, sim, add);
    checkVlans(p, sim, add);
    checkAcls(p, add);
    checkRouting(p, sim, add);
    checkDhcp(p, sim, add);
    checkStp(p, sim, add);
    checkHsrp(p, sim, add);
    checkNat(p, sim, add);
    checkSecurity(p, sim, add);
    checkIpv6(p, sim, add);

    const order = { error: 0, warn: 1, info: 2 };
    return issues.sort((a, b) => order[a.sev] - order[b.sev]);
  }

  function checkDevices(p, sim, add) {
    p.devices.forEach((d) => {
      const links = M.linksOf(p, d.id);
      const t = { devId: d.id };
      if (!links.length) add('warn', `${d.name} is not connected to anything.`, 'Connect it to the rest of the topology.', t);
      if (M.isHost(d)) {
        const c = d.ports.Ethernet0 || {};
        if (!links.length) return;
        if (d.ipMode === 'dhcp') {
          const lease = sim.leases[d.id];
          if (lease && !lease.ok) add('error', `${d.name} gets no DHCP lease. ${lease.reason}`, 'Add a pool on the router or Layer 3 switch for this subnet (DHCP tab), or an ip helper-address on the gateway pointing at the server.', t);
          else if (lease && !lease.gateway) add('warn', `${d.name}: pool ${lease.pool} on ${lease.server} hands out no default router.`, 'Set the default router in the pool so clients can leave their subnet.', t);
          return;
        }
        if (!c.ip && d.ip6Mode !== 'none') return;
        if (!c.ip) add('error', `${d.name} has no IP address.`, 'Select it and set an address, or use Auto-address hosts on the VLANs tab.', t);
        else if (!d.gateway) add('warn', `${d.name} has no default gateway, so it only reaches its own subnet.`, 'Set the gateway to the router or SVI address on its subnet.', t);
        else {
          const ifc = sim.byDev[d.id].find((i) => i.ip);
          if (ifc && N.ip2n(d.gateway) !== null && !N.inNet(d.gateway, ifc.net, ifc.mask)) {
            add('error', `${d.name}: gateway ${d.gateway} is outside its own subnet ${ifc.net}/${ifc.len}.`, 'A gateway must be on the same subnet as the host.', t);
          } else if (ifc && ifc.up && !sim.ifaces.some((i) => i.ip === d.gateway && i.up && i.domain === ifc.domain) && !sim.vips.some((i) => i.ip === d.gateway && i.domain === ifc.domain)) {
            add('error', `${d.name}: nothing answers at gateway ${d.gateway} in its VLAN.`, 'Check the VLAN on its access port, and the SVI or sub-interface that should hold this address.', t);
          }
        }
      }
      if (M.isSwitch(d) && !M.canRoute(d) && d.svis.some((s) => s.ip) && !d.gateway) {
        add('info', `${d.name} has a management SVI but no ip default-gateway.`, 'Without it, remote subnets cannot manage this switch.', t);
      }
      if (M.isL3Switch(d) && d.routing.bgp.enabled) {
        add('info', `${d.name}: BGP on a ${MODELS[d.model].label} depends on the installed license.`, 'Check with "show license" or "show version". Base feature sets often exclude it.', t);
      }
    });
  }

  function checkDhcp(p, sim, add) {
    p.devices.filter(M.canRoute).forEach((d) => {
      const t = { devId: d.id };
      const names = new Set();
      d.dhcp.pools.forEach((pl) => {
        const label = `${d.name} DHCP pool ${pl.name || '(unnamed)'}`;
        if (!pl.name) add('error', `${label} has no name.`, 'Give every pool a name.', t);
        else if (names.has(pl.name)) add('error', `${label} is defined twice.`, 'Pool names must be unique on a device.', t);
        names.add(pl.name);
        const len = N.maskToLen(pl.mask);
        if (N.ip2n(pl.network) === null || len === null) {
          add('error', `${label} has no valid network and mask.`, 'Enter the subnet the pool serves, e.g. 192.168.10.0 255.255.255.0.', t);
          return;
        }
        if (N.network(pl.network, pl.mask) !== pl.network) {
          add('error', `${label}: ${pl.network} is not a network address for /${len}.`, `Use ${N.network(pl.network, pl.mask)}.`, t);
        }
        if (!pl.gateway) add('warn', `${label} has no default router.`, 'Clients get an address but no gateway, so they only reach their own subnet.', t);
        else if (!N.inNet(pl.gateway, pl.network, pl.mask)) add('error', `${label}: default router ${pl.gateway} is outside ${pl.network}/${len}.`, 'The default router must be on the subnet the pool serves.', t);
        const served = M.gatewaysOf(p, d).some((g) => N.inNet(g.cfg.ip, pl.network, pl.mask));
        const relayed = sim.ifaces.some((i) => (i.cfg.helper || '').trim() && N.inNet(i.ip, pl.network, pl.mask));
        if (!served && !relayed) add('warn', `${label}: no interface on ${d.name} is in ${pl.network}/${len}, and no relay forwards from it.`, 'Pools only answer requests that arrive on a matching interface, or through an ip helper-address on that subnet\'s gateway.', t);
      });
    });
    sim.ifaces.forEach((i) => {
      const h = (i.cfg.helper || '').trim();
      if (!h) return;
      const t = { devId: i.devId };
      if (N.ip2n(h) === null) add('error', `${i.dev.name} ${shortName(i.name)}: helper address "${h}" is not an IP address.`, 'Enter the DHCP server\'s address.', t);
      else if (!sim.ifaces.some((j) => j.ip === h && M.canRoute(j.dev) && j.dev.dhcp.pools.length)) {
        add('warn', `${i.dev.name} ${shortName(i.name)}: no device in the lab runs DHCP at ${h}.`, 'Point the helper at an interface or loopback of the router that holds the pools.', t);
      }
    });
  }

  function checkAddressing(p, sim, add) {
    const seen = {};
    const eachAddr = (fn) => p.devices.forEach((d) => {
      Object.entries(d.ports).forEach(([name, c]) => {
        fn(d, name, c);
        (c.subifs || []).forEach((s) => fn(d, `${name}.${s.num}`, s));
      });
      d.svis.forEach((s) => fn(d, `Vlan${s.vlan}`, s));
      d.loopbacks.forEach((s) => fn(d, `Loopback${s.num}`, s));
    });
    eachAddr((d, name, c) => {
      const t = { devId: d.id };
      const label = `${d.name} ${shortName(name)}`;
      if (!c.ip && !c.mask) return;
      if (N.ip2n(c.ip) === null) return add('error', `${label}: "${c.ip}" is not a valid IP address.`, 'Use dotted decimal, such as 192.168.10.1.', t);
      if (N.maskToLen(c.mask) === null) return add('error', `${label}: mask "${c.mask}" is not valid.`, 'Use a mask such as 255.255.255.0.', t);
      if (!N.isHostAddr(c.ip, c.mask)) add('error', `${label}: ${c.ip} is the network or broadcast address of its subnet.`, 'Choose a usable host address.', t);
      if (seen[c.ip]) add('error', `Duplicate address ${c.ip} on ${seen[c.ip]} and ${label}.`, 'Every interface needs its own address.', t);
      seen[c.ip] = label;
    });

    // Overlapping subnets on one router cannot both be configured.
    p.devices.forEach((d) => {
      const list = (sim.byDev[d.id] || []).filter((i) => i.ip);
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i];
          const b = list[j];
          const short = a.len <= b.len ? a : b;
          if (N.inNet(a.ip, b.ip, short.mask) && N.inNet(b.ip, a.ip, short.mask) && M.canRoute(d)) {
            add('error', `${d.name}: ${shortName(a.name)} and ${shortName(b.name)} overlap (${a.net}/${a.len}, ${b.net}/${b.len}).`, 'IOS refuses overlapping subnets on one device. Give each interface its own subnet.', { devId: d.id });
          }
        }
      }
    });
  }

  function checkLinks(p, sim, add) {
    p.links.forEach((l) => {
      const a = M.dev(p, l.a);
      const b = M.dev(p, l.b);
      const t = { linkId: l.id };
      const label = `${a.name} to ${b.name}`;

      if (l.ec) {
        const mixed = ['a', 'b'].some((s) => new Set(l.members.map((m) => portSpeed(m[s]))).size > 1);
        if (mixed) add('error', `${label}: EtherChannel mixes port speeds.`, 'All members on a switch must run at the same speed.', t);
        if (l.members.length < 2) add('warn', `${label}: EtherChannel has one member.`, 'Add a second link for redundancy, or turn the bundle off.', t);
        if (M.isRouter(a) || M.isRouter(b)) add('info', `${label}: router EtherChannel support depends on the IOS release.`, 'Multilayer switches are the safer choice for this in a lab.', t);
      }

      const l3a = M.isL3End(p, l, l.a);
      const l3b = M.isL3End(p, l, l.b);

      // Directly cabled L3 ends must agree on a subnet.
      if (l3a && l3b) {
        const ca = M.port(a, M.endIf(l, a.id));
        const cb = M.port(b, M.endIf(l, b.id));
        if (ca.subifs.length === 0 && cb.subifs.length === 0) {
          const v6only = !ca.ip && !cb.ip && (ca.ip6 || cb.ip6);
          if (!v6only && (!ca.ip || !cb.ip)) add('error', `${label}: ${!ca.ip ? a.name : b.name} ${shortName(M.endIf(l, !ca.ip ? a.id : b.id))} has no IP address.`, 'Assign both ends an address. The link panel can fill in a /30.', t);
          else if (N.ip2n(ca.ip) !== null && N.ip2n(cb.ip) !== null && N.maskToLen(ca.mask) !== null && N.maskToLen(cb.mask) !== null) {
            if (!N.inNet(ca.ip, cb.ip, ca.mask) || ca.mask !== cb.mask) add('error', `${label}: ${ca.ip} and ${cb.ip} are not on the same subnet.`, 'Both ends of a routed link must share a subnet and mask.', t);
          }
        }
      }

      const routerEnd = (d, l3) => l3 && M.isRouter(d);
      [[a, l3a], [b, l3b]].forEach(([d, l3]) => {
        if (!routerEnd(d, l3)) return;
        const name = M.endIf(l, d.id);
        const c = M.port(d, name);
        if (l.mode === 'trunk') {
          if (!c.subifs.length && M.isSwitch(M.dev(p, M.peerOf(l, d.id)))) {
            add('error', `${d.name} ${shortName(name)} is on a trunk but has no sub-interfaces.`, 'Create one sub-interface per VLAN. The link panel can add them for you.', { ...t, devId: d.id });
          }
          if (c.ip && c.subifs.length) add('warn', `${d.name} ${shortName(name)} has an IP on the parent and sub-interfaces.`, 'The parent address only carries untagged traffic. Usually only the sub-interfaces need addresses.', { devId: d.id });
          const allowed = M.allowedVlans(p, l);
          c.subifs.forEach((s) => {
            if (!allowed.includes(s.vlan)) add('error', `${d.name} ${shortName(name)}.${s.num}: VLAN ${s.vlan} is not allowed on the trunk.`, 'Add it to the trunk allowed list.', t);
            if (s.vlan === l.nativeVlan && !s.native) add('error', `${d.name} ${shortName(name)}.${s.num}: VLAN ${s.vlan} is the trunk native VLAN, so its frames arrive untagged.`, 'Tick "native" on this sub-interface.', { devId: d.id });
            if (s.native && s.vlan !== l.nativeVlan) add('error', `${d.name} ${shortName(name)}.${s.num} is marked native, but the trunk native VLAN is ${l.nativeVlan}.`, 'Match the native VLAN on both sides.', { devId: d.id });
          });
        }
        if (l.mode === 'access' && c.subifs.length) {
          add('error', `${d.name} ${shortName(name)} has sub-interfaces but its link is an access port.`, 'Change the link to a trunk.', t);
        }
      });

      if (l.mode === 'trunk') {
        const allowed = M.allowedVlans(p, l);
        if (!allowed.includes(l.nativeVlan) && l.allowed !== 'all') add('warn', `${label}: native VLAN ${l.nativeVlan} is not in the allowed list.`, 'Untagged control traffic and any native-VLAN hosts will be dropped.', t);
      }
    });

    // Redundant switch paths mean STP will block something, which students should expect.
    const switches = p.devices.filter(M.isSwitch);
    const parent = {};
    const find = (x) => { while (parent[x] && parent[x] !== x) x = parent[x]; return x; };
    let loops = 0;
    p.links.forEach((l) => {
      if (!M.isSwitch(M.dev(p, l.a)) || !M.isSwitch(M.dev(p, l.b)) || l.mode === 'routed') return;
      const x = find(l.a);
      const y = find(l.b);
      if (x === y) loops++;
      else parent[x] = y;
    });
    if (loops && switches.length) add('info', 'Redundant switch links form a loop.', 'Spanning tree blocks one port per loop in each VLAN (the red marks on the canvas). That port is normal, not a fault. The STP tab on each switch shows why.', {});
  }

  function checkVlans(p, sim, add) {
    const known = new Set(p.vlans.map((v) => v.id));
    const need = (id, t, where) => {
      if (!known.has(id)) add('warn', `${where} uses VLAN ${id}, which is not on the VLANs tab.`, 'Add it so it gets a name and is created on every switch.', t);
    };
    p.links.forEach((l) => {
      const label = `${M.dev(p, l.a).name} to ${M.dev(p, l.b).name}`;
      if (l.mode === 'access') need(l.vlan, { linkId: l.id }, label);
      if (l.mode === 'trunk' && l.nativeVlan !== 1) need(l.nativeVlan, { linkId: l.id }, label);
    });
    p.devices.forEach((d) => {
      d.svis.forEach((s) => {
        need(s.vlan, { devId: d.id }, `${d.name} SVI`);
        const ifc = sim.byDev[d.id].find((i) => i.name === `Vlan${s.vlan}`);
        if (ifc && !ifc.up && !s.shutdown) add('error', `${d.name} Vlan${s.vlan} will stay down.`, `No active port on ${d.name} carries VLAN ${s.vlan}. Add an access port or a trunk that allows it.`, { devId: d.id });
      });
    });

    // Hosts sharing a VLAN but not a subnet never reach each other.
    const byDomain = {};
    sim.ifaces.filter((i) => M.isHost(i.dev) && i.ip && i.domain).forEach((i) => {
      (byDomain[i.domain] = byDomain[i.domain] || []).push(i);
    });
    Object.values(byDomain).forEach((list) => {
      const nets = [...new Set(list.map((i) => `${i.net}/${i.len}`))];
      if (nets.length > 1) add('warn', `Hosts in one VLAN use different subnets: ${nets.join(', ')}.`, 'Keep one subnet per VLAN.', { devId: list[0].devId });
    });

    // Same subnet in two broadcast domains is the classic wrong-VLAN mistake.
    const netDomains = {};
    sim.ifaces.filter((i) => i.ip && i.domain && i.kind !== 'loopback').forEach((i) => {
      const k = `${i.net}/${i.len}`;
      (netDomains[k] = netDomains[k] || new Map()).set(i.domain, i);
    });
    Object.entries(netDomains).forEach(([k, m]) => {
      if (m.size > 1) add('error', `Subnet ${k} is split across ${m.size} separate VLANs or segments.`, `Check the access VLAN on ${[...m.values()].map((i) => i.dev.name).join(' and ')}.`, { devId: [...m.values()][0].devId });
    });
  }

  function checkAcls(p, add) {
    p.devices.forEach((d) => {
      const t = { devId: d.id };
      d.acls.forEach((a) => {
        const label = `${d.name} ACL ${a.name}`;
        if (/^\d+$/.test(a.name)) {
          const n = +a.name;
          const std = (n >= 1 && n <= 99) || (n >= 1300 && n <= 1999);
          const ext = (n >= 100 && n <= 199) || (n >= 2000 && n <= 2699);
          if (a.type === 'standard' && !std) add('error', `${label}: standard lists use 1 to 99 or 1300 to 1999.`, 'Renumber it, or use a name.', t);
          if (a.type === 'extended' && !ext) add('error', `${label}: extended lists use 100 to 199 or 2000 to 2699.`, 'Renumber it, or use a name.', t);
        } else if (!/^[A-Za-z][\w-]*$/.test(a.name)) {
          add('error', `${label}: names must start with a letter and contain no spaces.`, 'Use something like BLOCK_GUEST.', t);
        }
        const rules = a.rules.filter((r) => r.remark === undefined);
        if (!rules.length) add('warn', `${label} has no rules.`, 'IOS treats an empty applied list as permit all, which is rarely what you meant.', t);
        else if (!rules.some((r) => r.action === 'permit')) add('error', `${label} has no permit line, so the implicit deny blocks everything.`, 'Add a permit, such as "permit ip any any".', t);
        rules.forEach((r, i) => {
          if (!N.parseAclAddr(r.src)) add('error', `${label} line ${i + 1}: cannot read source "${r.src}".`, 'Use any, host 10.0.0.1, 10.0.0.0 0.0.0.255 or 10.0.0.0/24.', t);
          if (a.type === 'extended' && !N.parseAclAddr(r.dst)) add('error', `${label} line ${i + 1}: cannot read destination "${r.dst}".`, 'Use any, host 10.0.0.1, 10.0.0.0 0.0.0.255 or 10.0.0.0/24.', t);
          if (a.type === 'extended' && (r.proto === 'tcp' || r.proto === 'udp')) {
            [['source', r.srcOp, r.srcPort, r.srcPort2], ['destination', r.op, r.port, r.port2]].forEach(([side, op, lo, hi]) => {
              if (!op || op === 'any' || String(lo === undefined ? '' : lo).trim() === '') return;
              const where = `${label} line ${i + 1}`;
              if (portNum(r.proto, lo) === null) return add('error', `${where}: "${lo}" is not a ${r.proto.toUpperCase()} ${side} port.`, 'Use a number from 0 to 65535, or an IOS keyword such as www or domain.', t);
              if (op !== 'range') return;
              if (portNum(r.proto, hi) === null) return add('error', `${where}: the ${side} port range needs an upper port.`, 'Fill both ends, such as range 1024 65535.', t);
              if (portNum(r.proto, hi) < portNum(r.proto, lo)) add('error', `${where}: the ${side} port range runs backwards.`, 'Put the lower port first.', t);
            });
          }
          const isAny = (s) => (N.parseAclAddr(s) || {}).kind === 'any';
          const catchAll = isAny(r.src) && (a.type === 'standard' || (isAny(r.dst) && r.proto === 'ip'));
          if (catchAll && i < rules.length - 1) add('warn', `${label}: line ${i + 1} matches everything, so the lines after it never run.`, 'Move specific rules above catch-all rules.', t);
        });
      });

      const defined = new Set(d.acls.map((a) => a.name));
      const refs = [];
      Object.entries(d.ports).forEach(([name, c]) => {
        [c, ...(c.subifs || [])].forEach((x) => [x.aclIn, x.aclOut].forEach((a) => a && refs.push([a, name])));
      });
      d.svis.forEach((s) => [s.aclIn, s.aclOut].forEach((a) => a && refs.push([a, `Vlan${s.vlan}`])));
      refs.forEach(([a, where]) => {
        if (!defined.has(a)) add('warn', `${d.name} ${shortName(where)} applies ACL ${a}, which does not exist.`, 'IOS permits everything on an undefined list. Create it or remove the reference.', t);
      });
      d.acls.forEach((a) => {
        if (!refs.some(([n]) => n === a.name) && d.vtyAcl !== a.name && !(d.nat && d.nat.pat && d.nat.pat.acl === a.name)) add('info', `${d.name} ACL ${a.name} is not applied to any interface.`, 'A list does nothing until it is applied with ip access-group.', t);
      });
    });
  }

  function reportAclBlocks(st, d, proto, add) {
    (st.aclBlocks || []).filter((b) => b.what.startsWith(proto)).forEach((b) => {
      add('error', `${d.name} ${shortName(b.at.name)} inbound ACL ${b.at.aclIn} drops ${b.what} from ${b.from.dev.name} (${b.from.ip}).`,
        `Add "${b.fix}" above the deny lines, or the implicit deny at the end of the list blocks it.`, { devId: d.id });
    });
  }

  function checkRouting(p, sim, add) {
    const routers = p.devices.filter(M.canRoute);
    const rids = {};
    routers.forEach((d) => {
      const t = { devId: d.id };
      const r = d.routing;
      const st = sim.rt[d.id];
      const active = sim.ifaces.filter((i) => i.devId === d.id && i.up && i.ip);

      if (r.ospf.enabled) {
        if (!r.ospf.networks.length) add('error', `${d.name} OSPF has no network statements.`, 'Use Add connected networks on the Routing tab.', t);
        if (st.ospfRid) {
          if (rids[st.ospfRid]) add('error', `Duplicate OSPF router ID ${st.ospfRid} on ${rids[st.ospfRid]} and ${d.name}.`, 'Router IDs must be unique, or adjacencies fail. Set router-id on one of them.', t);
          rids[st.ospfRid] = d.name;
        } else {
          add('error', `${d.name} has no OSPF router ID.`, 'Set a router ID, or give the router an up interface with an address.', t);
        }
        st.ospfIfs.forEach(({ i, area, passive }) => {
          if (i.kind === 'loopback' || passive) return;
          S.peersOn(sim, i).forEach((j) => {
            const peer = sim.rt[j.devId];
            if (!peer) return;
            const them = peer.ospfIfs.find((x) => x.i === j);
            if (!them) {
              if (j.dev.routing.ospf.enabled) add('error', `${j.dev.name} ${shortName(j.name)} is not in OSPF, so ${d.name} cannot form an adjacency.`, `Add a network statement on ${j.dev.name} covering ${j.ip}.`, { devId: j.devId });
              return;
            }
            if (them.passive) add('warn', `${j.dev.name} ${shortName(j.name)} is passive, so ${d.name} forms no adjacency there.`, 'Remove passive-interface on links facing other routers.', { devId: j.devId });
            if (them.area !== area && d.id < j.devId) add('error', `OSPF area mismatch between ${d.name} (area ${area}) and ${j.dev.name} (area ${them.area}).`, 'Both ends of a link must be in the same area.', t);
          });
        });
        const areas = new Set(st.ospfIfs.map((x) => x.area));
        reportAclBlocks(st, d, 'OSPF', add);
        if (areas.size && !areas.has('0') && areas.size > 1) add('warn', `${d.name} joins several OSPF areas but none is area 0.`, 'Non-backbone areas must connect through area 0.', t);
      }

      if (r.rip.enabled) {
        if (!r.rip.networks.length) add('error', `${d.name} RIP has no network statements.`, 'Use Add connected networks on the Routing tab.', t);
        st.ripIfs.forEach(({ i, passive }) => {
          if (passive) return;
          S.peersOn(sim, i).forEach((j) => {
            const peer = sim.rt[j.devId];
            if (peer && j.dev.routing.rip.enabled && !peer.ripIfs.some((x) => x.i === j)) {
              add('error', `${j.dev.name} ${shortName(j.name)} is not in RIP, so ${d.name} hears nothing from it.`, `Add network ${N.classfulNet(j.ip)} on ${j.dev.name}.`, { devId: j.devId });
            }
          });
        });
        reportAclBlocks(st, d, 'RIP', add);
      }

      if (r.bgp.enabled) {
        if (!r.bgp.asn) add('error', `${d.name} BGP has no AS number.`, 'Set the local AS on the Routing tab.', t);
        if (!r.bgp.neighbors.length) add('error', `${d.name} BGP has no neighbors.`, 'Add the peer address and its AS number.', t);
        st.bgpSessions.forEach((s) => {
          if (s.state !== 'Established') add('error', `${d.name} BGP peer ${s.neighbor.ip} will not establish. ${s.reason}`, '', t);
        });
        r.bgp.networks.forEach((n) => {
          const len = N.maskToLen(n.mask);
          if (len === null || N.ip2n(n.net) === null) return add('error', `${d.name} BGP network ${n.net} ${n.mask} is not valid.`, '', t);
          if (!st.rib[`${N.network(n.net, n.mask)}/${len}`]) add('error', `${d.name} BGP network ${n.net}/${len} has no exact match in the routing table.`, 'BGP only advertises prefixes already routed, with an identical mask.', t);
        });
        Object.entries(st.bgp).forEach(([k, e]) => {
          if (e.valid === false) add('error', `${d.name} learns ${k} over iBGP, but next hop ${e.nh} is unreachable.`, 'Set next-hop-self on the iBGP peer that learned it from eBGP.', t);
        });
      }

      r.static.forEach((s) => {
        const bad = N.ip2n(s.net) === null || N.maskToLen(s.mask) === null;
        if (bad) return add('error', `${d.name} static route ${s.net} ${s.mask} is not valid.`, '', t);
        if (N.ip2n(s.via) !== null) {
          if (!active.some((i) => N.inNet(s.via, i.net, i.mask)) && !S.resolve(sim, d.id, N.ip2n(s.via))) {
            add('error', `${d.name} static route via ${s.via}: the next hop is not reachable.`, 'The next hop must sit on a connected subnet or already be routed.', t);
          }
        } else if (!active.some((i) => i.name === s.via)) {
          add('error', `${d.name} static route exits ${s.via}, which is down or has no address.`, '', t);
        }
      });
    });

    // One line on the most useful fact: a multi-router lab with nothing routing.
    if (routers.length > 1 && routers.every((d) => !d.routing.ospf.enabled && !d.routing.rip.enabled && !d.routing.bgp.enabled && !d.routing.static.length && !d.routing.ospf3.enabled && !d.routing.static6.length)) {
      add('warn', 'Routers have no routes to each other\'s subnets.', 'Add static routes or enable OSPF, RIP or BGP on the Routing tab.', {});
    }
  }

  function checkStp(p, sim, add) {
    Object.values(sim.stp.byVlan).forEach((r) => {
      r.groups.filter((g) => g.members.length > 1).forEach((g) => {
        const root = M.dev(p, g.root);
        const loops = r.blocked.length > 0;
        if (g.tieOnMac && loops) {
          add('info', `VLAN ${r.vlan}: ${root.name} is root bridge only because of its MAC address.`, `Every switch has the same priority, so the lowest MAC wins, and real hardware will pick differently. Set a lower priority (Ports tab, Spanning tree) on the switch you want as root.`, { devId: root.id });
        }
        if (root && !M.isL3Switch(root) && p.devices.some((d) => g.members.includes(d.id) && M.isL3Switch(d)) && loops) {
          add('info', `VLAN ${r.vlan}: the root bridge is ${root.name}, not a distribution switch.`, 'The root is usually the multilayer switch, so traffic takes the shortest path to the gateway.', { devId: root.id });
        }
      });
    });
  }

  function checkHsrp(p, sim, add) {
    const seen = new Set();
    sim.hsrp.forEach((h) => {
      const t = { devId: h.devId };
      const cfg = h.iface.cfg.hsrp;
      if (cfg.vip && N.ip2n(cfg.vip) === null) add('error', `${h.dev.name} ${shortName(h.ifName)}: HSRP virtual IP ${cfg.vip} is not valid.`, '', t);
      else if (cfg.vip && !N.inNet(cfg.vip, h.iface.net, h.iface.mask)) add('error', `${h.dev.name} ${shortName(h.ifName)}: virtual IP ${cfg.vip} is outside ${h.iface.net}/${h.iface.len}.`, 'The virtual IP must be on the interface subnet.', t);
      else if (cfg.vip === h.iface.ip) add('error', `${h.dev.name} ${shortName(h.ifName)}: the virtual IP is the interface's own address.`, 'Use a free address, often .1 or .254, for the virtual gateway.', t);
      const key = `${h.iface.domain}|${h.group}`;
      if (seen.has(key)) return;
      seen.add(key);
      const vips = new Set([h, ...h.peers.map((x) => sim.hsrp.find((y) => y.iface === x))].map((x) => x.iface.cfg.hsrp.vip).filter(Boolean));
      if (vips.size > 1) add('error', `HSRP group ${h.group}: routers disagree on the virtual IP (${[...vips].join(', ')}).`, 'Every router in a group must use the same virtual IP.', t);
      if (!h.peers.length) add('warn', `${h.dev.name} ${shortName(h.ifName)}: HSRP group ${h.group} has no standby router.`, 'Configure the same group and virtual IP on a second router on this subnet.', t);
      const active = sim.hsrp.find((x) => x.iface.domain === h.iface.domain && x.group === h.group && x.state === 'Active');
      if (active && h.peers.length && !active.preempt && sim.hsrp.some((x) => x !== active && x.iface.domain === h.iface.domain && x.group === h.group && x.priority > active.priority)) {
        add('info', `HSRP group ${h.group}: ${active.dev.name} wins only at a cold start.`, 'Without preempt, a higher-priority router that comes up later does not take over.', t);
      }
      const hi = sim.hsrp.filter((x) => x.iface.domain === h.iface.domain && x.group === h.group).sort((a, b) => b.priority - a.priority)[0];
      if (hi && !hi.preempt && h.peers.length) add('info', `HSRP group ${h.group}: ${hi.dev.name} has the highest priority but no preempt.`, 'Add "standby preempt" so it takes back the active role after a reboot.', { devId: hi.devId });
    });
    // Hosts and pools should point at the virtual IP, not a physical interface.
    sim.hsrp.filter((h) => h.state === 'Active' && h.vip).forEach((h) => {
      p.devices.filter((d) => M.isHost(d) && d.ipMode === 'static' && d.gateway && sim.hsrp.some((x) => x.iface.domain === h.iface.domain && x.iface.ip === d.gateway)).forEach((d) => {
        add('warn', `${d.name} uses ${d.gateway}, a physical HSRP router address, as its gateway.`, `Point it at the virtual IP ${h.vip} so it survives a router failure.`, { devId: d.id });
      });
    });
  }

  function checkNat(p, sim, add) {
    p.devices.filter(M.canRoute).forEach((d) => {
      const t = { devId: d.id };
      const n = d.nat;
      const ifs = (sim.byDev[d.id] || []).filter((i) => i.cfg.nat);
      const inside = ifs.filter((i) => i.cfg.nat === 'inside');
      const outside = ifs.filter((i) => i.cfg.nat === 'outside');
      const rules = n.pat || n.statics.length;
      if (!rules && ifs.length) add('warn', `${d.name} marks interfaces NAT inside or outside but has no translation rule.`, 'Add PAT (overload) or a static entry on the NAT tab.', t);
      if (rules && !inside.length) add('error', `${d.name} has NAT rules but no "ip nat inside" interface.`, 'Mark the LAN-facing interfaces inside.', t);
      if (rules && !outside.length) add('error', `${d.name} has NAT rules but no "ip nat outside" interface.`, 'Mark the internet-facing interface outside.', t);
      if (n.pat) {
        if (!n.pat.acl || !d.acls.some((a) => a.name === n.pat.acl)) add('error', `${d.name}: PAT uses ACL ${n.pat.acl || '(none)'}, which does not exist, so nothing is translated.`, 'Create a standard ACL that permits the inside subnets.', t);
        if (n.pat.iface && !outside.some((i) => i.name === n.pat.iface)) add('error', `${d.name}: PAT overloads ${shortName(n.pat.iface)}, which is not an outside interface.`, 'Overload the interface marked ip nat outside.', t);
      }
      n.statics.forEach((s) => {
        if (N.ip2n(s.local) === null || N.ip2n(s.global) === null) add('error', `${d.name}: static NAT ${s.local} to ${s.global} is not valid.`, '', t);
        else if (outside.some((i) => i.ip === s.global)) add('warn', `${d.name}: static NAT uses the outside interface address ${s.global}.`, 'That address is also used by PAT and by the router itself. Pick another public address.', t);
      });
    });
  }

  function checkSecurity(p, sim, add) {
    sim.portSec.filter((x) => x.violated).forEach((x) => {
      const d = M.dev(p, x.devId);
      add(x.violation === 'shutdown' ? 'error' : 'warn', `${d.name} ${shortName(x.ifName)}: port security allows ${x.max} MAC address${x.max > 1 ? 'es' : ''} but sees ${x.count} (${x.hosts.join(', ')}).`,
        x.violation === 'shutdown' ? 'The port goes err-disabled and carries nothing. Raise the maximum, or move the extra devices to their own ports.' : `With "${x.violation}", the extra devices are dropped.`, { devId: d.id, linkId: x.linkId });
    });
    p.devices.filter(M.isSwitch).forEach((d) => {
      const sn = d.snooping;
      if (!sn || !sn.on) return;
      const t = { devId: d.id };
      if (!N.expandList(sn.vlans).length) add('warn', `${d.name}: DHCP snooping is on but no VLANs are listed.`, 'Snooping only acts on VLANs named in "ip dhcp snooping vlan".', t);
      if (!Object.values(d.ports).some((c) => c.trust)) add('warn', `${d.name}: DHCP snooping is on with no trusted port.`, 'Trust the uplink toward the DHCP server, or every offer is dropped.', t);
    });
  }

  function checkIpv6(p, sim, add) {
    const v6 = sim.v6;
    if (!v6) return;
    const X = PL.ipv6;
    const seen = {};
    v6.ifaces.forEach((i) => {
      const t = { devId: i.devId };
      if (i.cfg.ip6 && i.addr === null && !i.slaac) add('error', `${i.dev.name} ${shortName(i.name)}: "${i.cfg.ip6}" is not an IPv6 prefix.`, 'Use the form 2001:db8:1::1/64.', t);
      if (i.addr === null) return;
      const k = X.format(i.addr);
      if (seen[k] && seen[k] !== i.dev) add('error', `IPv6 address ${k} is on both ${seen[k].name} and ${i.dev.name}.`, '', t);
      seen[k] = i.dev;
    });
    v6.ifaces.filter((i) => i.addr !== null && i.domain && i.kind !== 'loopback').forEach((i) => {
      v6.ifaces.filter((j) => j.devId !== i.devId && j.domain === i.domain && j.addr !== null && M.canRoute(j.dev) && M.canRoute(i.dev) && i.devId < j.devId).forEach((j) => {
        if (X.netOf(i.addr, Math.min(i.len, j.len)) !== X.netOf(j.addr, Math.min(i.len, j.len)) || i.len !== j.len) {
          add('error', `${i.dev.name} ${shortName(i.name)} and ${j.dev.name} ${shortName(j.name)} share a segment but not an IPv6 prefix.`, 'Both ends need addresses in the same prefix, such as 2001:db8:12::1/64 and 2001:db8:12::2/64.', { devId: i.devId });
        }
      });
    });
    p.devices.filter(M.canRoute).forEach((d) => {
      const st = v6.rt[d.id];
      const t = { devId: d.id };
      if (d.routing.ospf3.enabled && !st.rid) add('error', `${d.name}: OSPFv3 has no router ID, so it does not start.`, 'With no IPv4 address on the router, set a router ID such as 1.1.1.1 under OSPFv3.', t);
      (st.nbrs || []).filter((n) => !n.ok).forEach((n) => add('error', `${d.name}: no OSPFv3 adjacency with ${n.them.dev.name} on ${shortName(n.me.name)}.`, n.reason, t));
      if (d.routing.ospf3.enabled && !st.ospfIfs.length) add('warn', `${d.name}: OSPFv3 is on but no interface is in an area.`, 'Set an OSPFv3 area on each interface that should take part.', t);
    });
    p.devices.filter((d) => M.isHost(d) && d.ipMode !== 'none' && d.ip6Mode !== 'none').forEach((d) => {
      const h = v6.hosts[d.id];
      if (h && !h.ok) add('error', `${d.name} gets no IPv6 address. ${h.reason}`, '', { devId: d.id });
    });
  }

  PL.validate = { validate };
})(typeof window !== 'undefined' ? (window.PL = window.PL || {}) : (globalThis.PL = globalThis.PL || {}));
