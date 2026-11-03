// Worked labs, fully configured. The campus lab blocks some traffic on purpose with an ACL.
(function (PL) {
  'use strict';

  const M = PL.model;

  function setIp(d, name, ip, mask) {
    Object.assign(M.port(d, name), { ip, mask });
  }

  function host(p, model, x, y, name, sw, vlan, ip, mask, gw) {
    const d = M.addDevice(p, model, x, y, name);
    const { link } = M.addLink(p, sw.id, d.id);
    link.mode = 'access';
    link.vlan = vlan;
    setIp(d, 'Ethernet0', ip, mask);
    d.gateway = gw;
    return { d, link };
  }

  function wire(p, a, b, opts) {
    const { link } = M.addLink(p, a.id, b.id);
    Object.assign(link, opts || {});
    return link;
  }

  function routerOnAStick() {
    const p = M.newProject('Router on a stick');
    p.vlans.push(
      { id: 10, name: 'STUDENTS', subnet: '192.168.10.0', mask: '255.255.255.0' },
      { id: 20, name: 'STAFF', subnet: '192.168.20.0', mask: '255.255.255.0' },
      { id: 99, name: 'NATIVE', subnet: '', mask: '' },
    );
    const r1 = M.addDevice(p, 'isr2911', 480, 120, 'R1');
    const sw1 = M.addDevice(p, 'c2960_24tt', 480, 300, 'SW1');
    const trunk = wire(p, r1, sw1, { mode: 'trunk', nativeVlan: 99, allowed: '10,20,99' });
    const gi = trunk.members[0].a;
    M.port(r1, gi).subifs.push(
      { num: 10, vlan: 10, ip: '192.168.10.1', mask: '255.255.255.0', native: false, desc: 'STUDENTS', aclIn: '', aclOut: '' },
      { num: 20, vlan: 20, ip: '192.168.20.1', mask: '255.255.255.0', native: false, desc: 'STAFF', aclIn: '', aclOut: '' },
      { num: 99, vlan: 99, ip: '', mask: '', native: true, desc: 'NATIVE', aclIn: '', aclOut: '' },
    );
    host(p, 'pc', 300, 470, 'PC1', sw1, 10, '192.168.10.10', '255.255.255.0', '192.168.10.1');
    host(p, 'pc', 480, 470, 'PC2', sw1, 10, '192.168.10.11', '255.255.255.0', '192.168.10.1');
    host(p, 'laptop', 660, 470, 'Staff1', sw1, 20, '192.168.20.10', '255.255.255.0', '192.168.20.1');
    return p;
  }

  function campus() {
    const p = M.newProject('Campus core with OSPF');
    p.vlans.push(
      { id: 10, name: 'STUDENTS', subnet: '10.10.10.0', mask: '255.255.255.0' },
      { id: 20, name: 'STAFF', subnet: '10.10.20.0', mask: '255.255.255.0' },
      { id: 30, name: 'SERVERS', subnet: '10.10.30.0', mask: '255.255.255.0' },
      { id: 99, name: 'NATIVE', subnet: '', mask: '' },
    );
    const mask = '255.255.255.0';
    const r1 = M.addDevice(p, 'isr4321', 520, 70, 'R1');
    const core = M.addDevice(p, 'c3650_24ps', 520, 240, 'CORE1');
    const sw1 = M.addDevice(p, 'c2960_24tt', 260, 400, 'SW1');
    const sw2 = M.addDevice(p, 'c2960_24tt', 780, 400, 'SW2');

    const up = wire(p, r1, core, { mode: 'routed' });
    setIp(r1, up.members[0].a, '10.255.0.1', '255.255.255.252');
    setIp(core, up.members[0].b, '10.255.0.2', '255.255.255.252');
    r1.loopbacks.push({ num: 0, ip: '1.1.1.1', mask: '255.255.255.255', desc: 'Router ID' });

    [sw1, sw2].forEach((sw) => {
      const l = wire(p, core, sw, { mode: 'trunk', nativeVlan: 99, allowed: '10,20,30,99' });
      M.setChannel(p, l, true);
    });

    core.svis.push(
      { vlan: 10, ip: '10.10.10.1', mask, desc: '', shutdown: false, aclIn: '', aclOut: '' },
      { vlan: 20, ip: '10.10.20.1', mask, desc: '', shutdown: false, aclIn: '', aclOut: '' },
      { vlan: 30, ip: '10.10.30.1', mask, desc: '', shutdown: false, aclIn: '', aclOut: 'PROTECT_SERVERS' },
    );
    core.acls.push(
      {
        id: M.uid('a'), name: 'PROTECT_SERVERS', type: 'extended', rules: [
          { remark: 'Students reach the web server only' },
          { action: 'permit', proto: 'tcp', src: '10.10.10.0/24', dst: 'host 10.10.30.10', op: 'eq', port: '80' },
          { action: 'deny', proto: 'ip', src: '10.10.10.0/24', dst: '10.10.30.0/24' },
          { action: 'permit', proto: 'ip', src: 'any', dst: 'any' },
        ],
      },
    );

    const ro = core.routing.ospf;
    Object.assign(ro, {
      enabled: true, pid: 1, routerId: '2.2.2.2',
      networks: [
        { net: '10.10.0.0', wild: '0.0.255.255', area: 0 },
        { net: '10.255.0.0', wild: '0.0.0.3', area: 0 },
      ],
      passive: ['Vlan10', 'Vlan20', 'Vlan30'],
    });
    Object.assign(r1.routing.ospf, {
      enabled: true, pid: 1, routerId: '1.1.1.1',
      networks: [{ net: '10.255.0.0', wild: '0.0.0.3', area: 0 }, { net: '1.1.1.1', wild: '0.0.0.0', area: 0 }],
    });

    host(p, 'pc', 120, 560, 'PC1', sw1, 10, '10.10.10.10', mask, '10.10.10.1');
    host(p, 'laptop', 300, 560, 'Staff1', sw1, 20, '10.10.20.10', mask, '10.10.20.1');
    host(p, 'pc', 660, 560, 'PC2', sw2, 10, '10.10.10.11', mask, '10.10.10.1');
    host(p, 'server', 860, 560, 'WEB1', sw2, 30, '10.10.30.10', mask, '10.10.30.1');
    return p;
  }

  function wanBgp() {
    const p = M.newProject('Two sites over BGP');
    const lan = '255.255.255.0';
    const p2p = '255.255.255.252';
    const r1 = M.addDevice(p, 'isr2911', 220, 180, 'R1');
    const r2 = M.addDevice(p, 'isr2911', 520, 180, 'ISP1');
    const r3 = M.addDevice(p, 'isr2911', 820, 180, 'R3');

    const s1 = wire(p, r1, r2, { mode: 'routed' });
    setIp(r1, s1.members[0].a, '203.0.113.1', p2p);
    setIp(r2, s1.members[0].b, '203.0.113.2', p2p);
    const s2 = wire(p, r2, r3, { mode: 'routed' });
    setIp(r2, s2.members[0].a, '203.0.113.5', p2p);
    setIp(r3, s2.members[0].b, '203.0.113.6', p2p);

    const sa = M.addDevice(p, 'c2960_24tt', 220, 360, 'SW-A');
    const sc = M.addDevice(p, 'c2960_24tt', 820, 360, 'SW-C');
    const la = wire(p, r1, sa, { mode: 'access', vlan: 1 });
    setIp(r1, la.members[0].a, '172.16.1.1', lan);
    const lc = wire(p, r3, sc, { mode: 'access', vlan: 1 });
    setIp(r3, lc.members[0].a, '172.16.3.1', lan);
    host(p, 'pc', 220, 520, 'PC-A', sa, 1, '172.16.1.10', lan, '172.16.1.1');
    host(p, 'server', 820, 520, 'SRV-C', sc, 1, '172.16.3.10', lan, '172.16.3.1');

    Object.assign(r1.routing.bgp, {
      enabled: true, asn: '65001', routerId: '1.1.1.1',
      neighbors: [{ ip: '203.0.113.2', remoteAs: '64500', desc: 'ISP1', updateSource: '', nextHopSelf: false }],
      networks: [{ net: '172.16.1.0', mask: lan }],
    });
    Object.assign(r2.routing.bgp, {
      enabled: true, asn: '64500', routerId: '2.2.2.2',
      neighbors: [
        { ip: '203.0.113.1', remoteAs: '65001', desc: 'Site A', updateSource: '', nextHopSelf: false },
        { ip: '203.0.113.6', remoteAs: '65003', desc: 'Site C', updateSource: '', nextHopSelf: false },
      ],
    });
    Object.assign(r3.routing.bgp, {
      enabled: true, asn: '65003', routerId: '3.3.3.3',
      neighbors: [{ ip: '203.0.113.5', remoteAs: '64500', desc: 'ISP1', updateSource: '', nextHopSelf: false }],
      networks: [{ net: '172.16.3.0', mask: lan }],
    });
    return p;
  }

  function ripTriangle() {
    const p = M.newProject('RIP triangle');
    const lan = '255.255.255.0';
    const p2p = '255.255.255.252';
    const r1 = M.addDevice(p, 'isr1941', 500, 110, 'R1');
    const r2 = M.addDevice(p, 'isr2911', 280, 330, 'R2');
    const r3 = M.addDevice(p, 'isr2911', 720, 330, 'R3');
    [[r1, r2, '10.0.12'], [r1, r3, '10.0.13'], [r2, r3, '10.0.23']].forEach(([a, b, net]) => {
      const l = wire(p, a, b, { mode: 'routed' });
      setIp(a, l.members[0].a, `${net}.1`, p2p);
      setIp(b, l.members[0].b, `${net}.2`, p2p);
    });
    const sw1 = M.addDevice(p, 'c2960_24tt', 160, 480, 'SW1');
    const sw2 = M.addDevice(p, 'c2960_24tt', 840, 480, 'SW2');
    const l1 = wire(p, r2, sw1, { mode: 'access', vlan: 1 });
    setIp(r2, l1.members[0].a, '192.168.2.1', lan);
    const l2 = wire(p, r3, sw2, { mode: 'access', vlan: 1 });
    setIp(r3, l2.members[0].a, '192.168.3.1', lan);
    host(p, 'pc', 160, 620, 'PC1', sw1, 1, '192.168.2.10', lan, '192.168.2.1');
    host(p, 'pc', 840, 620, 'PC2', sw2, 1, '192.168.3.10', lan, '192.168.3.1');
    Object.assign(r1.routing.rip, { enabled: true, networks: ['10.0.0.0'] });
    Object.assign(r2.routing.rip, { enabled: true, networks: ['10.0.0.0', '192.168.2.0'], passive: [l1.members[0].a] });
    Object.assign(r3.routing.rip, { enabled: true, networks: ['10.0.0.0', '192.168.3.0'], passive: [l2.members[0].a] });
    return p;
  }

  // A central DHCP server on R1; the multilayer switch relays requests from both VLANs to it.
  function dhcpRelay() {
    const p = M.newProject('DHCP server and relay');
    p.vlans.push(
      { id: 10, name: 'STUDENTS', subnet: '10.1.10.0', mask: '255.255.255.0' },
      { id: 20, name: 'STAFF', subnet: '10.1.20.0', mask: '255.255.255.0' },
    );
    const mask = '255.255.255.0';
    const r1 = M.addDevice(p, 'isr4321', 480, 80, 'R1');
    const mls = M.addDevice(p, 'c3650_24ps', 480, 250, 'MLS1');
    const sw = M.addDevice(p, 'c2960_24tt', 480, 410, 'SW1');
    const up = wire(p, r1, mls, { mode: 'routed' });
    setIp(r1, up.members[0].a, '10.0.0.1', '255.255.255.252');
    setIp(mls, up.members[0].b, '10.0.0.2', '255.255.255.252');
    r1.loopbacks.push({ num: 0, ip: '1.1.1.1', mask: '255.255.255.255', desc: 'DHCP server' });
    wire(p, mls, sw, { mode: 'trunk' });
    mls.svis.push(
      { vlan: 10, ip: '10.1.10.1', mask, desc: '', shutdown: false, aclIn: '', aclOut: '', helper: '1.1.1.1' },
      { vlan: 20, ip: '10.1.20.1', mask, desc: '', shutdown: false, aclIn: '', aclOut: '', helper: '1.1.1.1' },
    );
    r1.dhcp.excluded.push({ from: '10.1.10.1', to: '10.1.10.10' }, { from: '10.1.20.1', to: '10.1.20.10' });
    r1.dhcp.pools.push(
      { name: 'STUDENTS', network: '10.1.10.0', mask, gateway: '10.1.10.1', dns: '8.8.8.8', domain: 'lab.local' },
      { name: 'STAFF', network: '10.1.20.0', mask, gateway: '10.1.20.1', dns: '8.8.8.8', domain: 'lab.local' },
    );
    Object.assign(r1.routing.ospf, { enabled: true, routerId: '1.1.1.1', networks: [{ net: '10.0.0.0', wild: '0.0.0.3', area: 0 }, { net: '1.1.1.1', wild: '0.0.0.0', area: 0 }] });
    Object.assign(mls.routing.ospf, {
      enabled: true, routerId: '2.2.2.2', passive: ['Vlan10', 'Vlan20'],
      networks: [{ net: '10.0.0.0', wild: '0.0.0.3', area: 0 }, { net: '10.1.0.0', wild: '0.0.255.255', area: 0 }],
    });
    [['pc', 220, 'PC1', 10], ['pc', 390, 'PC2', 10], ['laptop', 570, 'Staff1', 20], ['laptop', 740, 'Staff2', 20]].forEach(([model, x, name, vlan]) => {
      const d = M.addDevice(p, model, x, 570, name);
      const { link } = M.addLink(p, sw.id, d.id);
      Object.assign(link, { mode: 'access', vlan });
      d.ipMode = 'dhcp';
    });
    return p;
  }

  // Two distribution switches and an access switch in a triangle, so spanning tree has a
  // loop to break; HSRP on both gateways; PAT out to the Internet cloud.
  function redundantEdge() {
    const p = M.newProject('Redundant edge: STP, HSRP and NAT');
    const mask = '255.255.255.0';
    p.vlans.push({ id: 10, name: 'USERS', subnet: '10.10.10.0', mask });
    const net = M.addDevice(p, 'internet', 560, 20, 'ISP');
    const r1 = M.addDevice(p, 'isr2911', 560, 170, 'EDGE');
    const d1 = M.addDevice(p, 'c3650_24ps', 360, 330, 'DIST1');
    const d2 = M.addDevice(p, 'c3650_24ps', 760, 330, 'DIST2');
    const acc = M.addDevice(p, 'c2960_24tt', 560, 480, 'ACC1');
    setIp(net, 'Ethernet0', '203.0.113.2', '255.255.255.248');
    net.gateway = '203.0.113.1';
    net.loopbacks.push({ num: 0, ip: '8.8.8.8', mask: '255.255.255.255', desc: '' });
    const wan = wire(p, r1, net);
    setIp(r1, M.endIf(wan, r1.id), '203.0.113.1', '255.255.255.248');
    const u1 = wire(p, r1, d1, { mode: 'routed' });
    const u2 = wire(p, r1, d2, { mode: 'routed' });
    setIp(r1, M.endIf(u1, r1.id), '10.255.0.1', '255.255.255.252');
    setIp(d1, M.endIf(u1, d1.id), '10.255.0.2', '255.255.255.252');
    setIp(r1, M.endIf(u2, r1.id), '10.255.0.5', '255.255.255.252');
    setIp(d2, M.endIf(u2, d2.id), '10.255.0.6', '255.255.255.252');
    [[d1, d2], [d1, acc], [d2, acc]].forEach(([a, b]) => wire(p, a, b, { mode: 'trunk' }));
    d1.stp.priority = { 1: 4096, 10: 4096 };
    d2.stp.priority = { 1: 8192, 10: 8192 };
    d1.svis.push({ vlan: 10, ip: '10.10.10.2', mask, desc: '', shutdown: false, aclIn: '', aclOut: '', hsrp: { group: 10, vip: '10.10.10.1', priority: 110, preempt: true } });
    d2.svis.push({ vlan: 10, ip: '10.10.10.3', mask, desc: '', shutdown: false, aclIn: '', aclOut: '', hsrp: { group: 10, vip: '10.10.10.1', priority: 100, preempt: true } });
    [['pc', 440, 'PC1', '10.10.10.11'], ['pc', 680, 'PC2', '10.10.10.12']].forEach(([model, x, name, ip]) => host(p, model, x, 630, name, acc, 10, ip, mask, '10.10.10.1'));
    M.port(r1, M.endIf(wan, r1.id)).nat = 'outside';
    M.port(r1, M.endIf(u1, r1.id)).nat = 'inside';
    M.port(r1, M.endIf(u2, r1.id)).nat = 'inside';
    r1.acls.push({ id: M.uid('a'), name: '1', type: 'standard', rules: [{ action: 'permit', src: '10.10.0.0 0.0.255.255' }] });
    r1.nat.pat = { acl: '1', iface: M.endIf(wan, r1.id) };
    Object.assign(r1.routing.ospf, { enabled: true, routerId: '1.1.1.1', defaultOriginate: true, networks: [{ net: '10.255.0.0', wild: '0.0.0.255', area: 0 }] });
    r1.routing.static.push({ net: '0.0.0.0', mask: '0.0.0.0', via: '203.0.113.2', ad: 1 });
    [[d1, '2.2.2.2'], [d2, '3.3.3.3']].forEach(([d, rid]) => Object.assign(d.routing.ospf, {
      enabled: true, routerId: rid, passive: ['Vlan10'], networks: [{ net: '10.255.0.0', wild: '0.0.0.255', area: 0 }, { net: '10.10.10.0', wild: '0.0.0.255', area: 0 }],
    }));
    return p;
  }

  // Dual-stack is not needed: the routers run IPv6 only, so OSPFv3 needs set router IDs.
  function ipv6Lab() {
    const p = M.newProject('IPv6 with SLAAC and OSPFv3');
    const r1 = M.addDevice(p, 'isr4321', 300, 160, 'R1');
    const r2 = M.addDevice(p, 'isr4321', 700, 160, 'R2');
    const sw = M.addDevice(p, 'c2960_24tt', 300, 360, 'SW1');
    const wan = wire(p, r1, r2);
    const lan = wire(p, r1, sw, { mode: 'access', vlan: 1 });
    Object.assign(M.port(r1, M.endIf(wan, r1.id)), { ip6: '2001:db8:12::1/64', ospf3: '0' });
    Object.assign(M.port(r2, M.endIf(wan, r2.id)), { ip6: '2001:db8:12::2/64', ospf3: '0' });
    Object.assign(M.port(r1, M.endIf(lan, r1.id)), { ip6: '2001:db8:1::1/64', ospf3: '0' });
    r1.routing.ospf3 = { enabled: true, pid: 1, routerId: '1.1.1.1' };
    r2.routing.ospf3 = { enabled: true, pid: 1, routerId: '2.2.2.2' };
    ['PC1', 'PC2'].forEach((name, i) => {
      const d = M.addDevice(p, 'pc', 200 + i * 200, 540, name);
      M.addLink(p, sw.id, d.id).link.mode = 'access';
      d.ip6Mode = 'slaac';
    });
    const srv = M.addDevice(p, 'server', 700, 380, 'SRV1');
    const sl = wire(p, r2, srv);
    Object.assign(M.port(r2, M.endIf(sl, r2.id)), { ip6: '2001:db8:2::1/64', ospf3: '0' });
    srv.ip6Mode = 'static';
    M.port(srv, 'Ethernet0').ip6 = '2001:db8:2::10/64';
    srv.gateway6 = '2001:db8:2::1';
    return p;
  }

  PL.samples = [
    { id: 'campus', title: 'Campus core with OSPF', blurb: 'Layer 3 core, LACP trunks, SVIs, OSPF and an ACL protecting servers.', build: campus },
    { id: 'stick', title: 'Router on a stick', blurb: 'One router trunk serving two VLANs through sub-interfaces.', build: routerOnAStick },
    { id: 'bgp', title: 'Two sites over BGP', blurb: 'Ethernet WAN links with eBGP between three autonomous systems.', build: wanBgp },
    { id: 'dhcp', title: 'DHCP server and relay', blurb: 'R1 serves two VLANs; the Layer 3 switch relays with ip helper-address.', build: dhcpRelay },
    { id: 'rip', title: 'RIP triangle', blurb: 'Three routers in a loop running RIPv2 with passive LAN interfaces.', build: ripTriangle },
    { id: 'edge', title: 'Redundant edge: STP, HSRP and NAT', blurb: 'Two distribution switches share a virtual gateway; spanning tree blocks the loop; PAT to the Internet.', build: redundantEdge },
    { id: 'ipv6', title: 'IPv6 with SLAAC and OSPFv3', blurb: 'Hosts configure themselves from Router Advertisements; OSPFv3 carries the prefixes.', build: ipv6Lab },
  ];
})(typeof window !== 'undefined' ? (window.PL = window.PL || {}) : (globalThis.PL = globalThis.PL || {}));
