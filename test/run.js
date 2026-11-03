// Run with: node test/run.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.join(__dirname, '..');
['net', 'catalog', 'model', 'configgen', 'stp', 'simulate', 'ipv6', 'subnet', 'export', 'guide', 'importer', 'validate', 'samples', 'practice', 'troubleshoot'].forEach((f) => {
  vm.runInThisContext(fs.readFileSync(path.join(root, 'js', `${f}.js`), 'utf8'), { filename: `${f}.js` });
});

const { net: N, model: M, configgen: C, simulate: S, validate: V, samples, stp: STP, ipv6: V6, subnet: SUB, exporter: X, guide: G, importer: IMP, practice: P, troubleshoot: T } = globalThis.PL;
const sample = (id) => samples.find((s) => s.id === id).build();
const named = (p, n) => p.devices.find((d) => d.name === n);
const cfg = (p, n, o) => C.generate(p, named(p, n), { notes: false, ...o });
const errors = (p) => V.validate(p, S.simulate(p)).filter((i) => i.sev === 'error');
const pingOk = (p, from, to, svc) => {
  const sim = S.simulate(p);
  return S.ping(sim, named(p, from).id, to, svc);
};

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const has = (text, line) => assert(text.split('\n').includes(line), `missing line: "${line}"\n---\n${text}`);
const shortIf = (n) => PL.catalog.shortName(n);
const lacks = (text, line) => assert(!text.split('\n').includes(line), `unexpected line: "${line}"`);

test('net: masks, wildcards, lists', () => {
  assert.equal(N.maskToLen('255.255.255.252'), 30);
  assert.equal(N.maskToLen('255.0.255.0'), null);
  assert.equal(N.normalizeMask('/24'), '255.255.255.0');
  assert.equal(N.wildcard('255.255.255.0'), '0.0.0.255');
  assert.equal(N.network('192.168.10.77', '255.255.255.192'), '192.168.10.64');
  assert.equal(N.broadcast('10.0.0.1', '255.0.0.0'), '10.255.255.255');
  assert.equal(N.classfulNet('172.16.5.1'), '172.16.0.0');
  assert.equal(N.classfulNet('192.168.3.9'), '192.168.3.0');
  assert.equal(N.classfulNet('10.9.8.7'), '10.0.0.0');
  assert.equal(N.isHostAddr('10.0.0.0', '255.255.255.0'), false);
  assert.equal(N.isHostAddr('10.0.0.1', '255.255.255.254'), true);
  assert.deepEqual(N.expandList('10, 20-22,99'), [10, 20, 21, 22, 99]);
  assert.equal(N.compressList([10, 11, 12, 20, 30, 31]), '10-12,20,30,31');
});

test('net: ACL address parsing', () => {
  assert.equal(N.parseAclAddr('any').text, 'any');
  assert.equal(N.parseAclAddr('10.0.0.5').text, 'host 10.0.0.5');
  assert.equal(N.parseAclAddr('10.0.1.9/24').text, '10.0.1.0 0.0.0.255');
  assert.equal(N.parseAclAddr('10.0.0.0 0.0.0.255').kind, 'net');
  assert.equal(N.parseAclAddr('garbage'), null);
  const a = N.parseAclAddr('10.0.0.0 0.0.255.255');
  assert(N.wildMatch(N.ip2n('10.0.9.1'), a));
  assert(!N.wildMatch(N.ip2n('10.1.9.1'), a));
});

test('samples have no blocking errors', () => {
  samples.forEach((s) => {
    const list = errors(s.build());
    assert.deepEqual(list.map((i) => i.msg), [], s.id);
  });
});

test('router on a stick: sub-interfaces, trunk and inter-VLAN ping', () => {
  const p = sample('stick');
  const r = cfg(p, 'R1');
  has(r, 'interface GigabitEthernet0/0.10');
  has(r, ' encapsulation dot1Q 10');
  has(r, ' encapsulation dot1Q 99 native');
  has(r, ' ip address 192.168.10.1 255.255.255.0');
  has(r, ' no ip address');
  const sw = cfg(p, 'SW1');
  has(sw, ' switchport mode trunk');
  has(sw, ' switchport trunk native vlan 99');
  has(sw, ' switchport trunk allowed vlan 10,20,99');
  lacks(sw, ' switchport trunk encapsulation dot1q');
  has(sw, 'vlan 10');
  has(sw, ' name STUDENTS');
  has(sw, ' spanning-tree portfast');
  const ok = pingOk(p, 'PC1', '192.168.20.10');
  assert(ok.ok, ok.reason);
  assert(pingOk(p, 'PC1', '192.168.10.11').ok);
  assert.deepEqual(ok.fwd.hops.map((h) => h.dev), ['PC1', 'R1', 'Staff1']);
});

test('wrong access VLAN breaks the gateway and is reported', () => {
  const p = sample('stick');
  const pc1 = named(p, 'PC1');
  M.linksOf(p, pc1.id)[0].vlan = 20;
  assert(!pingOk(p, 'PC1', '192.168.20.10').ok);
  const msgs = errors(p).map((e) => e.msg).join('\n');
  assert(/nothing answers at gateway/.test(msgs), msgs);
});

test('a VLAN pruned from the trunk stops traffic', () => {
  const p = sample('stick');
  p.links.find((l) => l.mode === 'trunk').allowed = '10,99';
  const r = pingOk(p, 'PC1', '192.168.20.10');
  assert(!r.ok);
  assert(errors(p).some((e) => /not allowed on the trunk/.test(e.msg)));
});

test('native VLAN mismatch on a sub-interface is an error', () => {
  const p = sample('stick');
  const r1 = named(p, 'R1');
  r1.ports['GigabitEthernet0/0'].subifs.find((s) => s.num === 99).native = false;
  assert(errors(p).some((e) => /native VLAN, so its frames arrive untagged/.test(e.msg)));
});

test('campus: LACP bundle, SVIs, ip routing, OSPF', () => {
  const p = sample('campus');
  const core = cfg(p, 'CORE1');
  has(core, 'ip routing');
  has(core, 'interface Port-channel1');
  has(core, ' channel-group 1 mode active');
  has(core, 'interface Vlan10');
  has(core, ' no switchport');
  has(core, 'router ospf 1');
  has(core, ' network 10.10.0.0 0.0.255.255 area 0');
  has(core, ' passive-interface Vlan10');
  has(core, ' ip access-group PROTECT_SERVERS out');
  has(core, 'ip access-list extended PROTECT_SERVERS');
  has(core, ' permit tcp 10.10.10.0 0.0.0.255 host 10.10.30.10 eq 80');
  lacks(core, ' switchport trunk encapsulation dot1q');
  const sim = S.simulate(p);
  const rt = S.showRoutes(sim, named(p, 'R1')).map((r) => `${r.code} ${r.text}`).join('\n');
  assert(/^O 10\.10\.10\.0\/24 \[110\/2\] via 10\.255\.0\.2/m.test(rt), rt);
});

test('3560 needs the trunk encapsulation line, before the mode', () => {
  const p = M.newProject();
  const a = M.addDevice(p, 'c3560_24ps', 0, 0, 'MLS1');
  const b = M.addDevice(p, 'c2960_24tt', 0, 0, 'SW1');
  M.addLink(p, a.id, b.id);
  const t = cfg(p, 'MLS1');
  const lines = t.split('\n');
  assert(lines.indexOf(' switchport trunk encapsulation dot1q') > 0);
  assert(lines.indexOf(' switchport trunk encapsulation dot1q') < lines.indexOf(' switchport mode trunk'));
});

test('campus ACL: students reach port 80, not ICMP or SSH; staff are free', () => {
  const p = sample('campus');
  const web = pingOk(p, 'PC1', '10.10.30.10', { proto: 'tcp', port: 80 });
  assert(web.ok, web.reason);
  const icmp = pingOk(p, 'PC1', '10.10.30.10');
  assert(!icmp.ok);
  assert(/PROTECT_SERVERS out on Vlan30: dropped by line 3/.test(icmp.reason), icmp.reason);
  assert(!pingOk(p, 'PC2', '10.10.30.10', { proto: 'tcp', port: 22 }).ok);
  assert(pingOk(p, 'Staff1', '10.10.30.10').ok);
  assert(pingOk(p, 'PC1', '10.10.20.10').ok);
  assert(pingOk(p, 'PC1', '1.1.1.1').ok);
});

test('ACL with only denies is flagged and matches implicit deny', () => {
  const p = sample('stick');
  const r1 = named(p, 'R1');
  r1.acls.push({ id: 'x', name: '10', type: 'standard', rules: [{ action: 'deny', src: '192.168.10.10' }] });
  r1.ports['GigabitEthernet0/0'].subifs[1].aclOut = '10';
  assert(errors(p).some((e) => /no permit line/.test(e.msg)));
  has(cfg(p, 'R1'), 'access-list 10 deny host 192.168.10.10');
  has(cfg(p, 'R1'), ' ip access-group 10 out');
  const r = pingOk(p, 'PC2', '192.168.20.10');
  assert(!r.ok && /implicit deny/.test(r.reason), r.reason);
});

test('bad ACL numbers and shadowed lines are flagged', () => {
  const p = sample('stick');
  const r1 = named(p, 'R1');
  r1.acls.push({ id: 'x', name: '150', type: 'standard', rules: [{ action: 'permit', src: 'any' }, { action: 'deny', src: 'host 1.1.1.1' }] });
  const all = V.validate(p, S.simulate(p)).map((i) => i.msg).join('\n');
  assert(/standard lists use 1 to 99/.test(all), all);
  assert(/matches everything/.test(all), all);
});

test('BGP: eBGP over Ethernet WAN links, reachability', () => {
  const p = sample('bgp');
  has(cfg(p, 'R1'), ' network 172.16.1.0 mask 255.255.255.0');
  has(cfg(p, 'R1'), ' neighbor 203.0.113.2 remote-as 64500');
  has(cfg(p, 'ISP1'), ' ip address 203.0.113.5 255.255.255.252');
  lacks(cfg(p, 'ISP1'), ' clock rate 64000');
  const r = pingOk(p, 'PC-A', '172.16.3.10');
  assert(r.ok, r.reason);
  assert.deepEqual(r.fwd.hops.map((h) => h.dev), ['PC-A', 'R1', 'ISP1', 'R3', 'SRV-C']);
  const sim = S.simulate(p);
  assert(S.showRoutes(sim, named(p, 'R1')).some((x) => x.code === 'B' && /172\.16\.3\.0\/24 \[20\/0\] via 203\.0\.113\.2/.test(x.text)));
});

test('BGP network without an exact route, and wrong remote-as', () => {
  const p = sample('bgp');
  named(p, 'R1').routing.bgp.networks[0].mask = '255.255.0.0';
  named(p, 'R1').routing.bgp.networks[0].net = '172.16.0.0';
  assert(errors(p).some((e) => /no exact match/.test(e.msg)));
  const q = sample('bgp');
  named(q, 'R1').routing.bgp.neighbors[0].remoteAs = '1';
  assert(errors(q).some((e) => /will not establish/.test(e.msg)));
  assert(!pingOk(q, 'PC-A', '172.16.3.10').ok);
});

test('iBGP next hop needs next-hop-self unless the WAN is reachable', () => {
  // R1 (AS 65001) eBGP to ISP, iBGP from R1 to R2 inside the AS, with an IGP that omits the WAN.
  const p = M.newProject();
  const m = '255.255.255.252';
  const isp = M.addDevice(p, 'isr2911', 0, 0, 'ISP');
  const r1 = M.addDevice(p, 'isr2911', 0, 0, 'R1');
  const r2 = M.addDevice(p, 'isr2911', 0, 0, 'R2');
  const l1 = M.addLink(p, isp.id, r1.id).link;
  const l2 = M.addLink(p, r1.id, r2.id).link;
  Object.assign(M.port(isp, l1.members[0].a), { ip: '198.51.100.1', mask: m });
  Object.assign(M.port(r1, l1.members[0].b), { ip: '198.51.100.2', mask: m });
  Object.assign(M.port(r1, l2.members[0].a), { ip: '10.0.0.1', mask: m });
  Object.assign(M.port(r2, l2.members[0].b), { ip: '10.0.0.2', mask: m });
  isp.loopbacks.push({ num: 0, ip: '8.8.8.8', mask: '255.255.255.255', desc: '' });
  Object.assign(isp.routing.bgp, { enabled: true, asn: '100', neighbors: [{ ip: '198.51.100.2', remoteAs: '200' }], networks: [{ net: '8.8.8.8', mask: '255.255.255.255' }] });
  const toR2 = { ip: '10.0.0.2', remoteAs: '200', nextHopSelf: false };
  Object.assign(r1.routing.bgp, { enabled: true, asn: '200', neighbors: [{ ip: '198.51.100.1', remoteAs: '100' }, toR2] });
  Object.assign(r2.routing.bgp, { enabled: true, asn: '200', neighbors: [{ ip: '10.0.0.1', remoteAs: '200' }] });
  const before = errors(p).map((e) => e.msg).join('\n');
  assert(/next hop 198\.51\.100\.1 is unreachable/.test(before), before);
  toR2.nextHopSelf = true;
  assert.deepEqual(errors(p).map((e) => e.msg), []);
  const sim = S.simulate(p);
  assert(S.showRoutes(sim, r2).some((x) => /^8\.8\.8\.8\/32 \[200\/0\] via 10\.0\.0\.1/.test(x.text)));
});

test('RIP: v2, no auto-summary, passive LAN, full reachability', () => {
  const p = sample('rip');
  const r2 = cfg(p, 'R2');
  has(r2, 'router rip');
  has(r2, ' version 2');
  has(r2, ' no auto-summary');
  has(r2, ' network 192.168.2.0');
  const ok = pingOk(p, 'PC1', '192.168.3.10');
  assert(ok.ok, ok.reason);
  assert.deepEqual(ok.fwd.hops.map((h) => h.dev), ['PC1', 'R2', 'R3', 'PC2']);
});

test('RIP missing network on one router blocks return traffic', () => {
  const p = sample('rip');
  named(p, 'R3').routing.rip.networks = ['10.0.0.0'];
  assert(!pingOk(p, 'PC1', '192.168.3.10').ok);
});

test('OSPF: area mismatch prevents adjacency and is reported', () => {
  const p = sample('campus');
  named(p, 'R1').routing.ospf.networks[0].area = 1;
  assert(errors(p).some((e) => /area mismatch/.test(e.msg)));
  assert(!pingOk(p, 'PC1', '1.1.1.1').ok);
});

test('OSPF prefers the lower-cost path', () => {
  const p = M.newProject();
  const m = '255.255.255.252';
  const a = M.addDevice(p, 'isr2911', 0, 0, 'A');
  const b = M.addDevice(p, 'isr2911', 0, 0, 'B');
  const c = M.addDevice(p, 'isr2911', 0, 0, 'C');
  const s = M.addLink(p, a.id, b.id).link;
  const g1 = M.addLink(p, a.id, c.id).link;
  const g2 = M.addLink(p, c.id, b.id).link;
  Object.assign(M.port(a, s.members[0].a), { ip: '10.0.1.1', mask: m });
  Object.assign(M.port(b, s.members[0].b), { ip: '10.0.1.2', mask: m });
  Object.assign(M.port(a, g1.members[0].a), { ip: '10.0.2.1', mask: m });
  Object.assign(M.port(c, g1.members[0].b), { ip: '10.0.2.2', mask: m });
  Object.assign(M.port(c, g2.members[0].a), { ip: '10.0.3.1', mask: m });
  Object.assign(M.port(b, g2.members[0].b), { ip: '10.0.3.2', mask: m });
  b.loopbacks.push({ num: 0, ip: '9.9.9.9', mask: '255.255.255.255', desc: '' });
  [a, b, c].forEach((d) => Object.assign(d.routing.ospf, { enabled: true, networks: [{ net: '0.0.0.0', wild: '255.255.255.255', area: 0 }] }));
  const sim = S.simulate(p);
  assert(S.showRoutes(sim, a).some((x) => /^9\.9\.9\.9\/32 \[110\/2\] via 10\.0\.1\.2/.test(x.text)));
  // Take the direct link out of OSPF on A and the two-hop path is all that is left.
  Object.assign(a.routing.ospf, { networks: [{ net: '10.0.2.0', wild: '0.0.0.255', area: 0 }, { net: '10.0.3.0', wild: '0.0.0.255', area: 0 }] });
  assert(S.showRoutes(S.simulate(p), a).some((x) => /^9\.9\.9\.9\/32 \[110\/3\] via 10\.0\.2\.2/.test(x.text)));
});

test('static and default routes, and default-information originate into OSPF', () => {
  const p = M.newProject();
  const m = '255.255.255.252';
  const a = M.addDevice(p, 'isr2911', 0, 0, 'A');
  const b = M.addDevice(p, 'isr2911', 0, 0, 'B');
  const c = M.addDevice(p, 'isr2911', 0, 0, 'C');
  const ab = M.addLink(p, a.id, b.id).link;
  const bc = M.addLink(p, b.id, c.id).link;
  Object.assign(M.port(a, ab.members[0].a), { ip: '10.0.0.1', mask: m });
  Object.assign(M.port(b, ab.members[0].b), { ip: '10.0.0.2', mask: m });
  Object.assign(M.port(b, bc.members[0].a), { ip: '10.0.1.1', mask: m });
  Object.assign(M.port(c, bc.members[0].b), { ip: '10.0.1.2', mask: m });
  c.loopbacks.push({ num: 0, ip: '8.8.4.4', mask: '255.255.255.255', desc: '' });
  b.routing.static.push({ net: '0.0.0.0', mask: '0.0.0.0', via: '10.0.1.2', ad: 1 });
  has(cfg(p, 'B'), 'ip route 0.0.0.0 0.0.0.0 10.0.1.2');
  assert(!pingOk(p, 'A', '8.8.4.4').ok, 'A has no route yet');
  [a, b].forEach((d) => Object.assign(d.routing.ospf, { enabled: true, networks: [{ net: '10.0.0.0', wild: '0.0.0.3', area: 0 }] }));
  b.routing.ospf.defaultOriginate = true;
  c.routing.static.push({ net: '10.0.0.0', mask: '255.255.255.252', via: '10.0.1.1', ad: 1 });
  has(cfg(p, 'B'), ' default-information originate');
  const r = pingOk(p, 'A', '8.8.4.4');
  assert(r.ok, r.reason);
});

test('EtherChannel: static on routers, PAgP, member speed, port-channel rename', () => {
  const p = M.newProject();
  const r = M.addDevice(p, 'isr2911', 0, 0, 'R1');
  const s = M.addDevice(p, 'c3560_24ps', 0, 0, 'MLS1');
  const l = M.addLink(p, r.id, s.id).link;
  l.mode = 'routed';
  Object.assign(M.port(r, l.members[0].a), { ip: '10.0.0.1', mask: '255.255.255.252' });
  Object.assign(M.port(s, l.members[0].b), { ip: '10.0.0.2', mask: '255.255.255.252' });
  M.setChannel(p, l, true);
  assert.equal(l.ec.preset, 'on');
  assert.equal(l.members.length, 2);
  assert.equal(r.ports['Port-channel1'].ip, '10.0.0.1');
  const t = cfg(p, 'R1');
  has(t, 'interface Port-channel1');
  has(t, ' channel-group 1');
  has(t, ' ip address 10.0.0.1 255.255.255.252');
  has(cfg(p, 'MLS1'), ' channel-group 1 mode on');
  assert(pingOk(p, 'R1', '10.0.0.2').ok);
  M.setChannel(p, l, false);
  assert.equal(l.members.length, 1);
  assert.equal(r.ports[l.members[0].a].ip, '10.0.0.1');
  assert(pingOk(p, 'R1', '10.0.0.2').ok);
});

test('Auto port selection: uplinks on Gigabit, hosts on Fast Ethernet, routers run out', () => {
  const p = M.newProject();
  const sw = M.addDevice(p, 'c2960_24tt', 0, 0);
  const sw2 = M.addDevice(p, 'c2960_24tt', 0, 0);
  const pc = M.addDevice(p, 'pc', 0, 0);
  const uplink = M.addLink(p, sw.id, sw2.id).link;
  assert.equal(uplink.members[0].a, 'GigabitEthernet0/1');
  assert.equal(uplink.mode, 'trunk');
  const edge = M.addLink(p, pc.id, sw.id).link;
  assert.equal(edge.members[0].b, 'FastEthernet0/1');
  assert.equal(edge.mode, 'access');
  const r1 = M.addDevice(p, 'isr1941', 0, 0);
  const r2 = M.addDevice(p, 'isr1941', 0, 0);
  const wan = M.addLink(p, r1.id, r2.id).link;
  assert.equal(wan.members[0].a, 'GigabitEthernet0/0');
  assert.equal(wan.mode, 'routed');
  M.addLink(p, r1.id, r2.id);
  assert(M.addLink(p, r1.id, r2.id).error, 'a 1941 has two Ethernet ports');
  assert(M.addLink(p, pc.id, sw.id).error, 'a PC has one NIC');
});

test('Unused ports use interface range with at most 5 ranges', () => {
  const list = ['FastEthernet0/1', 'FastEthernet0/2', 'FastEthernet0/3', 'FastEthernet0/7', 'GigabitEthernet0/2'];
  assert.deepEqual(C.rangeCommands(list), ['interface range FastEthernet0/1 - 3 , FastEthernet0/7 , GigabitEthernet0/2']);
  const many = Array.from({ length: 7 }, (_, i) => `FastEthernet0/${i * 2 + 1}`);
  assert.equal(C.rangeCommands(many).length, 2);
});

test('Sub-interface helper and host auto-addressing', () => {
  const p = M.newProject();
  p.vlans.push({ id: 10, name: 'A', subnet: '10.1.10.0', mask: '255.255.255.0' }, { id: 20, name: 'B', subnet: '10.1.20.0', mask: '255.255.255.0' });
  const r = M.addDevice(p, 'isr2911', 0, 0, 'R1');
  const s = M.addDevice(p, 'c2960_24tt', 0, 0, 'SW1');
  const t = M.addLink(p, r.id, s.id).link;
  assert.equal(t.mode, 'trunk');
  assert.equal(M.subifsFromVlans(p, r, t.members[0].a, t), 2);
  const pc = M.addDevice(p, 'pc', 0, 0, 'PC1');
  const e = M.addLink(p, s.id, pc.id).link;
  e.vlan = 20;
  assert.equal(M.autoAddressHosts(p), 1);
  assert.equal(pc.ports.Ethernet0.ip, '10.1.20.10');
  assert.equal(pc.gateway, '10.1.20.1');
  assert.deepEqual(errors(p).map((x) => x.msg), []);
  assert(pingOk(p, 'PC1', '10.1.20.1').ok);
});

test('Project survives a JSON round trip and renders the same config', () => {
  const p = sample('campus');
  const q = M.normalize(JSON.parse(JSON.stringify(p)));
  assert.equal(C.generateAll(q), C.generateAll(p));
});

test('Separate cables join an EtherChannel and split back out', () => {
  const p = M.newProject();
  const s1 = M.addDevice(p, 'c2960_24tt', 0, 0, 'S1');
  const s2 = M.addDevice(p, 'c2960_24tt', 0, 0, 'S2');
  const first = M.addLink(p, s1.id, s2.id).link;
  const second = M.addLink(p, s2.id, s1.id).link; // drawn the other way round
  assert.equal(M.channelsFor(p, second).length, 0);
  M.setChannel(p, first, true, { single: true });
  assert.equal(first.members.length, 1);
  assert.deepEqual(M.channelsFor(p, second), [first]);
  const r = M.joinChannel(p, second, first);
  assert.equal(r.link, first);
  assert.equal(p.links.length, 1);
  assert.deepEqual(first.members[1], { a: 'GigabitEthernet0/2', b: 'GigabitEthernet0/2' });
  const t = cfg(p, 'S1');
  has(t, 'interface Port-channel1');
  assert.equal(t.split('\n').filter((x) => x === ' channel-group 1 mode active').length, 2);
  const out = M.splitMember(p, first, 1).link;
  assert.equal(p.links.length, 2);
  assert.equal(out.ec, null);
  assert.equal(out.mode, first.mode);
  assert(M.joinChannel(p, out, first).link);
});

test('Old saves drop serial cables and serial port settings', () => {
  const p = sample('rip');
  const r1 = named(p, 'R1');
  const r2 = named(p, 'R2');
  p.links.push({ id: 'old', a: r1.id, b: r2.id, members: [{ a: 'Serial0/0/0', b: 'Serial0/0/0' }], medium: 'serial', mode: 'routed', ec: null });
  M.port(r1, 'Serial0/0/0').ip = '10.9.9.1';
  const before = p.links.length;
  M.normalize(p);
  assert.equal(p.links.length, before - 1);
  assert(!r1.ports['Serial0/0/0']);
  assert(p.links.every((l) => !('medium' in l)));
});

test('DHCP: relayed leases, pool output, helper-address, reachability', () => {
  const p = sample('dhcp');
  const sim = S.simulate(p);
  const lease = sim.leases[named(p, 'PC1').id];
  assert(lease.ok, lease.reason);
  assert.equal(lease.ip, '10.1.10.11');
  assert.equal(lease.gateway, '10.1.10.1');
  assert.equal(lease.relay, 'MLS1');
  assert.equal(sim.leases[named(p, 'PC2').id].ip, '10.1.10.12');
  assert.equal(sim.leases[named(p, 'Staff1').id].ip, '10.1.20.11');
  const r1 = cfg(p, 'R1');
  has(r1, 'ip dhcp excluded-address 10.1.10.1 10.1.10.10');
  has(r1, 'ip dhcp pool STUDENTS');
  has(r1, ' network 10.1.10.0 255.255.255.0');
  has(r1, ' default-router 10.1.10.1');
  has(r1, ' dns-server 8.8.8.8');
  has(cfg(p, 'MLS1'), ' ip helper-address 1.1.1.1');
  assert.deepEqual(errors(p).map((e) => e.msg), []);
  const ok = pingOk(p, 'PC1', '10.1.20.11');
  assert(ok.ok, ok.reason);
});

test('DHCP failures: no relay, no route back to the relay, exhausted pool', () => {
  const p = sample('dhcp');
  named(p, 'MLS1').svis[0].helper = '';
  assert(errors(p).some((e) => /PC1 gets no DHCP lease. No DHCP pool for 10\.1\.10\.0\/24 on MLS1/.test(e.msg)));
  const q = sample('dhcp');
  named(q, 'R1').routing.ospf.enabled = false;
  assert(errors(q).some((e) => /PC1 gets no DHCP lease.*no route/.test(e.msg)));
  const r = sample('dhcp');
  named(r, 'R1').dhcp.excluded[0].to = '10.1.10.253';
  const sim = S.simulate(r);
  assert(sim.leases[named(r, 'PC1').id].ok);
  assert(/no free addresses/.test(sim.leases[named(r, 'PC2').id].reason));
});

test('DHCP: a local pool on the gateway serves its own subnet', () => {
  const p = sample('stick');
  const r1 = named(p, 'R1');
  assert.equal(M.dhcpPoolsFromGateways(p, r1), 2);
  assert.equal(r1.dhcp.pools[0].gateway, '192.168.10.1');
  named(p, 'PC2').ipMode = 'dhcp';
  const sim = S.simulate(p);
  assert.equal(sim.leases[named(p, 'PC2').id].ip, '192.168.10.11');
  assert(pingOk(p, 'PC2', '192.168.20.10').ok);
});

test('Feature filter keeps only the lines for that feature', () => {
  const p = sample('campus');
  const core = named(p, 'CORE1');
  const ec = C.generate(p, core, { feature: 'etherchannel', notes: false, paste: false });
  has(ec, 'interface Port-channel1');
  has(ec, ' channel-group 1 mode active');
  lacks(ec, 'router ospf 1');
  lacks(ec, 'hostname CORE1');
  const acl = C.generate(p, core, { feature: 'acl', notes: false, paste: false });
  has(acl, 'ip access-list extended PROTECT_SERVERS');
  has(acl, 'interface Vlan30');
  has(acl, ' ip access-group PROTECT_SERVERS out');
  lacks(acl, ' ip address 10.10.30.1 255.255.255.0');
  const ospf = C.generate(p, core, { feature: 'ospf', notes: false, paste: false });
  assert.equal(ospf.split('\n').filter((x) => !x.startsWith('!'))[0], 'router ospf 1');
  lacks(ospf, 'interface ');
  assert(/has no DHCP configuration/.test(C.generate(p, core, { feature: 'dhcp' })));
  const all = C.generateAll(p, { feature: 'acl' });
  has(all, '!!! CORE1 !!!');
  lacks(all, '!!! R1 !!!');
});

test('ACL ports: source and destination, ranges, keywords, log', () => {
  const p = sample('stick');
  const r1 = named(p, 'R1');
  const rule = (o) => ({ action: 'permit', proto: 'tcp', src: 'any', dst: 'any', ...o });
  r1.acls.push({ id: 'x', name: 'WEB_ONLY', type: 'extended', rules: [
    { remark: '' },
    rule({ src: '192.168.10.0/24', dst: 'host 192.168.20.10', op: 'range', port: '8000', port2: '8080', log: true }),
    rule({ proto: 'udp', srcOp: 'eq', srcPort: 'domain', dst: '192.168.20.0/24', op: 'gt', port: '1023' }),
    rule({ src: 'host 192.168.20.10', srcOp: 'eq', srcPort: 'www' }),
    { action: 'deny', proto: 'ip', src: 'any', dst: 'any' },
  ] });
  r1.ports['GigabitEthernet0/0'].subifs[1].aclOut = 'WEB_ONLY';
  const text = cfg(p, 'R1');
  has(text, ' remark ');
  has(text, ' permit tcp 192.168.10.0 0.0.0.255 host 192.168.20.10 range 8000 8080 log');
  has(text, ' permit udp any eq domain 192.168.20.0 0.0.0.255 gt 1023');
  has(text, ' permit tcp host 192.168.20.10 eq www any');
  assert(pingOk(p, 'PC1', '192.168.20.10', { proto: 'tcp', port: 8080 }).ok);
  const outside = pingOk(p, 'PC1', '192.168.20.10', { proto: 'tcp', port: 8081 });
  assert(!outside.ok && /WEB_ONLY out .*line 5/.test(outside.reason), outside.reason);
  assert(!errors(p).length, errors(p).map((e) => e.msg).join('\n'));

  // Matching the source port: replies from a web server's port 80 get back in.
  r1.acls.push({ id: 'y', name: 'REPLIES', type: 'extended', rules: [rule({ src: 'host 192.168.20.10', srcOp: 'eq', srcPort: '80' })] });
  r1.ports['GigabitEthernet0/0'].subifs[0].aclOut = 'REPLIES';
  assert(pingOk(p, 'PC1', '192.168.20.10', { proto: 'tcp', port: 8080 }).ok === false);
  r1.acls[1].rules = [rule({ src: 'host 192.168.20.10', srcOp: 'range', srcPort: '8000', srcPort2: '8080' })];
  assert(pingOk(p, 'PC1', '192.168.20.10', { proto: 'tcp', port: 8080 }).ok);

  r1.acls[0].rules[1].port2 = '7000';
  r1.acls[0].rules[3].srcPort = 'https';
  const msgs = errors(p).map((e) => e.msg).join('\n');
  assert(/range runs backwards/.test(msgs), msgs);
  assert(/"https" is not a TCP source port/.test(msgs), msgs);
});

test('Inbound ACLs block OSPF, BGP and DHCP when they do not permit them', () => {
  const p = sample('dhcp');
  const r1 = named(p, 'R1');
  r1.acls.push({ id: 'x', name: 'IN', type: 'extended', rules: [{ action: 'permit', proto: 'icmp', src: 'any', dst: 'any' }] });
  M.port(r1, 'GigabitEthernet0/0/0').aclIn = 'IN';
  let sim = S.simulate(p);
  assert(!sim.rt[r1.id].ospfAdj.length);
  assert(!sim.leases[named(p, 'PC1').id].ok);
  let msgs = errors(p).map((e) => e.msg).join('\n');
  assert(/R1 Gi0\/0\/0 inbound ACL IN drops OSPF hellos from MLS1/.test(msgs), msgs);
  r1.acls[0].rules.unshift({ action: 'permit', proto: 'ospf', src: 'any', dst: 'any' });
  sim = S.simulate(p);
  assert(sim.rt[r1.id].ospfAdj.length);
  assert(sim.leases[named(p, 'PC1').id].ok);

  const mls = named(p, 'MLS1');
  mls.acls.push({ id: 'y', name: 'NO_DHCP', type: 'extended', rules: [{ action: 'deny', proto: 'udp', src: 'any', dst: 'any', op: 'eq', port: '67' }, { action: 'permit', proto: 'ip', src: 'any', dst: 'any' }] });
  mls.svis.find((s) => s.vlan === 10).aclIn = 'NO_DHCP';
  sim = S.simulate(p);
  const lease = sim.leases[named(p, 'PC1').id];
  assert(!lease.ok && /NO_DHCP on MLS1 Vlan10 drops DHCP requests/.test(lease.reason), lease.reason);
  assert(sim.leases[named(p, 'Staff1').id].ok);

  const b = sample('bgp');
  const br1 = named(b, 'R1');
  br1.acls.push({ id: 'z', name: 'EDGE', type: 'extended', rules: [{ action: 'permit', proto: 'icmp', src: 'any', dst: 'any' }] });
  M.port(br1, 'GigabitEthernet0/0').aclIn = 'EDGE';
  msgs = errors(b).map((e) => e.msg).join('\n');
  assert(/BGP peer 203.0.113.2 will not establish. An inbound ACL on R1 Gi0\/0 \(EDGE\) drops BGP/.test(msgs), msgs);
  br1.acls[0].rules.push({ action: 'permit', proto: 'tcp', src: 'any', dst: 'any', op: 'eq', port: 'bgp' });
  assert(!errors(b).some((e) => /BGP peer/.test(e.msg)), errors(b).map((e) => e.msg).join('\n'));
});

test('OSPF neighbors: router IDs, DR/BDR election, 2WAY between DROTHERs, failure reasons', () => {
  const p = sample('dhcp');
  const mls = named(p, 'MLS1');
  const sw = named(p, 'SW1');
  mls.routing.ospf.passive = ['Vlan20'];
  const add = (name, ip, loop) => {
    const r = M.addDevice(p, 'isr4321', 0, 0, name);
    const { link } = M.addLink(p, sw.id, r.id);
    Object.assign(link, { mode: 'access', vlan: 10 });
    Object.assign(M.port(r, link.members[0].b), { ip, mask: '255.255.255.0' });
    if (loop) r.loopbacks.push({ num: 0, ip: loop, mask: '255.255.255.255', desc: '' });
    Object.assign(r.routing.ospf, { enabled: true, networks: [{ net: '10.1.10.0', wild: '0.0.0.255', area: 0 }] });
    return r;
  };
  add('R2', '10.1.10.2');
  add('R3', '10.1.10.3');
  const r4 = add('R4', '10.1.10.4', '9.9.9.9');
  let sim = S.simulate(p);
  const st = sim.rt[mls.id];
  assert.equal(st.ospfRid, '2.2.2.2');
  assert.equal(sim.rt[r4.id].ospfRid, '9.9.9.9');
  assert.equal(sim.rt[named(p, 'R3').id].ospfRid, '10.1.10.3');
  const view = Object.fromEntries(st.ospfNbrs.filter((n) => n.me.name === 'Vlan10').map((n) => [n.them.dev.name, `${n.state}/${n.role}`]));
  assert.deepEqual(view, { R3: 'FULL/DR', R2: 'FULL/BDR', R4: '2WAY/DROTHER' });
  assert.equal(st.ospfRoles.Vlan10, 'DROTHER');
  assert.equal(st.ospfNbrs.find((n) => n.them.dev.name === 'R1').state, 'FULL');

  r4.routing.ospf.networks[0].area = 1;
  r4.routing.ospf.routerId = '2.2.2.2';
  sim = S.simulate(p);
  const r4view = sim.rt[mls.id].ospfNbrs.find((n) => n.them.dev.name === 'R4');
  assert(!r4view.ok && /Area mismatch: area 0 here, area 1 on R4/.test(r4view.reason), r4view.reason);
  assert(errors(p).some((e) => /Duplicate OSPF router ID 2.2.2.2/.test(e.msg)));
});

test('Routes view data: sources, hidden routes, BGP table', () => {
  const p = sample('campus');
  const core = named(p, 'CORE1');
  let sim = S.simulate(p);
  const o = S.showRoutes(sim, core).find((r) => r.net === '1.1.1.1');
  assert.equal(o.code, 'O');
  assert.equal(o.from, 'R1');
  assert.equal(shortIf(o.ifName), 'Gi1/0/1');

  core.routing.static.push({ net: '1.1.1.1', mask: '255.255.255.255', via: '10.255.0.1', ad: '' });
  sim = S.simulate(p);
  const s = S.showRoutes(sim, core).find((r) => r.net === '1.1.1.1');
  assert.equal(s.proto, 'S');
  assert.equal(s.from, 'R1');
  assert.equal(shortIf(s.ifName), 'Gi1/0/1');
  const hidden = S.hiddenRoutes(sim, core);
  assert.equal(hidden.length, 1);
  assert.equal(hidden[0].proto, 'O');
  assert.equal(hidden[0].winner.proto, 'S');

  const b = sample('bgp');
  const r1 = named(b, 'R1');
  const bsim = S.simulate(b);
  const table = S.bgpTable(bsim, r1);
  assert.deepEqual(table.map((r) => [r.net, r.nh, r.path.join(' '), r.best]), [
    ['172.16.1.0', '0.0.0.0', '', true],
    ['172.16.3.0', '203.0.113.2', '64500 65003', true],
  ]);
  assert.equal(S.showRoutes(bsim, r1).find((r) => r.proto === 'B').from, 'ISP1');
});

// ---------- Backlog features ----------

const setIp = (d, n, ip, mask = '255.255.255.0') => Object.assign(M.port(d, n), { ip, mask });

// Two routers sharing a LAN with HSRP, R1 doing PAT to an Internet cloud.
function edgeLab() {
  const p = M.newProject('edge');
  const sw = M.addDevice(p, 'c2960_24tt', 0, 0);
  const r1 = M.addDevice(p, 'isr2911', -100, -200);
  const r2 = M.addDevice(p, 'isr2911', 100, -200);
  const h = M.addDevice(p, 'pc', 0, 200);
  const net = M.addDevice(p, 'internet', 0, -400);
  const l1 = M.addLink(p, r1.id, sw.id).link;
  const l2 = M.addLink(p, r2.id, sw.id).link;
  M.addLink(p, h.id, sw.id);
  const l4 = M.addLink(p, net.id, r1.id).link;
  [l1, l2].forEach((l) => { l.mode = 'access'; l.vlan = 1; });
  const lan1 = M.endIf(l1, r1.id);
  const lan2 = M.endIf(l2, r2.id);
  const wan = M.endIf(l4, r1.id);
  setIp(r1, lan1, '10.0.0.2');
  setIp(r2, lan2, '10.0.0.3');
  setIp(h, 'Ethernet0', '10.0.0.50');
  h.gateway = '10.0.0.1';
  M.port(r1, lan1).hsrp = { group: 1, vip: '10.0.0.1', priority: 110, preempt: true };
  M.port(r2, lan2).hsrp = { group: 1, vip: '10.0.0.1', priority: 100, preempt: false };
  setIp(r1, wan, '203.0.113.1', '255.255.255.248');
  setIp(net, 'Ethernet0', '203.0.113.2', '255.255.255.248');
  net.gateway = '203.0.113.1';
  net.loopbacks.push({ num: 0, ip: '8.8.8.8', mask: '255.255.255.255', desc: '' });
  M.port(r1, lan1).nat = 'inside';
  M.port(r1, wan).nat = 'outside';
  r1.acls.push({ id: 'a1', name: '1', type: 'standard', rules: [{ action: 'permit', src: '10.0.0.0 0.0.0.255' }] });
  r1.nat.pat = { acl: '1', iface: wan };
  r1.routing.static.push({ net: '0.0.0.0', mask: '0.0.0.0', via: '203.0.113.2', ad: 1 });
  return { p, sw, r1, r2, h, net, lan1, lan2, wan };
}

test('Subnet calculator and VLSM planner', () => {
  const c = SUB.calc('192.168.10.77', '/26');
  assert.deepEqual([c.network, c.broadcast, c.first, c.last, c.hosts, c.wildcard], ['192.168.10.64', '192.168.10.127', '192.168.10.65', '192.168.10.126', 62, '0.0.0.63']);
  assert.equal(SUB.calc('10.0.0.0', '/31').hosts, 2);
  assert(SUB.calc('300.1.1.1', '/24').error);
  const plan = SUB.vlsm('192.168.1.0', '/24', [{ name: 'A', hosts: 50 }, { name: 'B', hosts: 100 }, { name: 'C', hosts: 2 }, { name: 'D', hosts: 20 }]);
  assert.deepEqual(plan.rows.map((r) => [r.name, r.net, r.len]), [['B', '192.168.1.0', 25], ['A', '192.168.1.128', 26], ['D', '192.168.1.192', 27], ['C', '192.168.1.224', 30]]);
  assert(SUB.vlsm('192.168.1.0', '/24', [{ name: 'A', hosts: 200 }, { name: 'B', hosts: 100 }]).error);
});

test('Spanning tree: root, blocked port, priorities and the forwarding path', () => {
  const p = M.newProject('stp');
  p.vlans.push({ id: 10, name: 'A', subnet: '10.0.10.0', mask: '255.255.255.0' });
  const sws = [0, 1, 2].map((i) => M.addDevice(p, 'c2960_24tt', i * 200, 0));
  sws.forEach((d, i) => { d.stp.mac = `0050.0000.000${i + 1}`; });
  [[0, 1], [1, 2], [2, 0]].forEach(([x, y]) => { M.addLink(p, sws[x].id, sws[y].id).link.mode = 'trunk'; });
  const h1 = M.addDevice(p, 'pc', 0, 300);
  const h2 = M.addDevice(p, 'pc', 200, 300);
  M.addLink(p, h1.id, sws[0].id).link.vlan = 10;
  M.addLink(p, h2.id, sws[1].id).link.vlan = 10;
  setIp(h1, 'Ethernet0', '10.0.10.11');
  setIp(h2, 'Ethernet0', '10.0.10.12');
  let sim = S.simulate(p);
  let r = sim.stp.byVlan[10];
  assert.equal(r.groups[0].root, sws[0].id, 'lowest MAC wins a priority tie');
  assert.equal(r.blocked.length, 1);
  assert.equal(r.blocked[0].devId, sws[2].id, 'the switch furthest from the root blocks');
  assert(V.validate(p, sim).some((i) => /only because of its MAC/.test(i.msg)));
  sws[2].stp.priority[10] = 4096;
  sim = S.simulate(p);
  r = sim.stp.byVlan[10];
  assert.equal(r.groups[0].root, sws[2].id);
  assert.equal(r.blocked[0].devId, sws[1].id);
  const pg = S.ping(sim, h1.id, '10.0.10.12');
  assert(pg.ok, pg.reason);
  assert.equal(pg.fwd.links.length, 4, 'traffic detours through the root because SW1-SW2 is blocked');
  has(cfg(p, 'SW3'), 'spanning-tree vlan 10 priority 4096');
  assert(STP.showLines(sim.stp, sws[2], 10).includes('             This bridge is the root'));
  const imp = IMP.parse('spanning-tree vlan 10,20 root primary');
  assert.deepEqual(imp.stp, { 10: 24576, 20: 24576 });
});

test('HSRP: active and standby, failover, virtual gateway, config', () => {
  const { p, r1, r2, h, lan1 } = edgeLab();
  let sim = S.simulate(p);
  assert.deepEqual(sim.hsrp.map((x) => [x.dev.name, x.state]), [['R1', 'Active'], ['R2', 'Standby']]);
  assert(S.ping(sim, h.id, '10.0.0.1').ok, 'the virtual IP answers');
  const r = cfg(p, 'R1');
  has(r, ' standby 1 ip 10.0.0.1');
  has(r, ' standby 1 priority 110');
  has(r, ' standby 1 preempt');
  lacks(cfg(p, 'R2'), ' standby 1 priority 100');
  assert.deepEqual(errors(p), []);
  M.port(r1, lan1).shutdown = true;
  sim = S.simulate(p);
  assert.deepEqual(sim.hsrp.map((x) => [x.dev.name, x.state]), [['R2', 'Active']]);
  const pg = S.ping(sim, h.id, '10.0.0.1');
  assert(pg.ok && pg.fwd.endDev === r2, 'R2 takes over the virtual IP');
  M.port(r1, lan1).shutdown = false;
  h.gateway = '10.0.0.2';
  assert(V.validate(p, S.simulate(p)).some((i) => /physical HSRP router address/.test(i.msg)));
  M.port(r2, M.linksOf(p, r2.id)[0] && M.endIf(M.linksOf(p, r2.id)[0], r2.id)).hsrp.vip = '10.0.0.9';
  assert(V.validate(p, S.simulate(p)).some((i) => /disagree on the virtual IP/.test(i.msg)));
});

test('NAT: PAT out and back, static NAT inbound, config and checks', () => {
  const { p, r1, h, net, wan } = edgeLab();
  let sim = S.simulate(p);
  let pg = S.ping(sim, h.id, '8.8.8.8');
  assert(pg.ok, pg.reason);
  assert(/source 10\.0\.0\.50 becomes 203\.0\.113\.1 \(PAT/.test(pg.fwd.hops[1].nat));
  assert(/destination 203\.0\.113\.1 becomes 10\.0\.0\.50/.test(pg.back.hops[1].nat));
  const r = cfg(p, 'R1');
  has(r, ` ip nat inside`);
  has(r, ` ip nat outside`);
  has(r, `ip nat inside source list 1 interface ${wan} overload`);
  assert.deepEqual(errors(p), []);
  r1.nat.statics.push({ local: '10.0.0.50', global: '203.0.113.5' });
  sim = S.simulate(p);
  pg = S.ping(sim, net.id, '203.0.113.5');
  assert(pg.ok, pg.reason);
  assert.equal(pg.fwd.endDev, h, 'the static global reaches the inside host');
  has(cfg(p, 'R1'), 'ip nat inside source static 10.0.0.50 203.0.113.5');
  r1.nat.pat.acl = '7';
  assert(errors(p).some((i) => /PAT uses ACL 7/.test(i.msg)));
});

test('Port security: shutdown err-disables, restrict drops the extra hosts', () => {
  const p = M.newProject('ps');
  const sw = M.addDevice(p, 'c2960_24tt', 0, 0);
  const hub = M.addDevice(p, 'c2960_24tt', 0, 200);
  const a = M.addDevice(p, 'pc', -100, 400);
  const b = M.addDevice(p, 'pc', 100, 400);
  const c = M.addDevice(p, 'pc', 200, 0);
  const up = M.addLink(p, hub.id, sw.id).link;
  up.mode = 'access';
  M.addLink(p, a.id, hub.id);
  M.addLink(p, b.id, hub.id);
  M.addLink(p, c.id, sw.id);
  [[a, '10.0.0.1'], [b, '10.0.0.2'], [c, '10.0.0.3']].forEach(([d, ip]) => setIp(d, 'Ethernet0', ip));
  const port = M.port(sw, M.endIf(up, sw.id));
  port.portSec = { max: 1, sticky: true, violation: 'shutdown' };
  let sim = S.simulate(p);
  assert(!S.ping(sim, a.id, '10.0.0.3').ok);
  assert(errors(p).some((i) => /sees 2/.test(i.msg)));
  const t = cfg(p, 'SW1');
  has(t, ' switchport port-security');
  has(t, ' switchport port-security mac-address sticky');
  port.portSec.violation = 'restrict';
  sim = S.simulate(p);
  assert(S.ping(sim, a.id, '10.0.0.3').ok, 'the first MAC still works');
  assert(!S.ping(sim, b.id, '10.0.0.3').ok, 'the second MAC is dropped');
  has(cfg(p, 'SW1'), ' switchport port-security violation restrict');
  port.portSec.max = 2;
  assert(S.ping(S.simulate(p), b.id, '10.0.0.3').ok);
});

test('DHCP snooping: offers need a trusted path to the server', () => {
  const p = sample('dhcp');
  const sim0 = S.simulate(p);
  const client = p.devices.find((d) => M.isHost(d) && d.ipMode === 'dhcp' && sim0.leases[d.id].ok);
  const sw = M.dev(p, M.peerOf(M.linksOf(p, client.id)[0], client.id));
  const vlan = M.linksOf(p, client.id)[0].vlan;
  sw.snooping = { on: true, vlans: String(vlan) };
  let lease = S.simulate(p).leases[client.id];
  assert(!lease.ok && /DHCP snooping on/.test(lease.reason), lease.reason);
  M.linksOf(p, sw.id).filter((l) => l.mode === 'trunk' || M.isL3End(p, l, M.peerOf(l, sw.id))).forEach((l) => { M.port(sw, M.endIf(l, sw.id)).trust = true; });
  lease = S.simulate(p).leases[client.id];
  assert(lease.ok, lease.reason);
  const t = C.generate(p, sw, { notes: false });
  has(t, `ip dhcp snooping vlan ${vlan}`);
  has(t, 'no ip dhcp snooping information option');
  has(t, 'ip dhcp snooping');
  has(t, ' ip dhcp snooping trust');
});

test('IPv6: SLAAC, OSPFv3 between routers, ping, router ID check', () => {
  const p = M.newProject('v6');
  const r1 = M.addDevice(p, 'isr2911', 0, 0);
  const r2 = M.addDevice(p, 'isr2911', 300, 0);
  const sw = M.addDevice(p, 'c2960_24tt', 0, 200);
  const pc = M.addDevice(p, 'pc', 0, 400);
  const srv = M.addDevice(p, 'server', 300, 200);
  const wan = M.addLink(p, r1.id, r2.id).link;
  const lan = M.addLink(p, r1.id, sw.id).link;
  lan.mode = 'access';
  M.addLink(p, pc.id, sw.id);
  const sl = M.addLink(p, srv.id, r2.id).link;
  Object.assign(M.port(r1, M.endIf(wan, r1.id)), { ip6: '2001:db8:12::1/64', ospf3: '0' });
  Object.assign(M.port(r2, M.endIf(wan, r2.id)), { ip6: '2001:db8:12::2/64', ospf3: '0' });
  Object.assign(M.port(r1, M.endIf(lan, r1.id)), { ip6: '2001:db8:1::1/64', ospf3: '0' });
  Object.assign(M.port(r2, M.endIf(sl, r2.id)), { ip6: '2001:db8:2::1/64', ospf3: '0' });
  r1.routing.ospf3 = { enabled: true, pid: 1, routerId: '1.1.1.1' };
  r2.routing.ospf3 = { enabled: true, pid: 1, routerId: '' };
  pc.ip6Mode = 'slaac';
  srv.ip6Mode = 'static';
  M.port(srv, 'Ethernet0').ip6 = '2001:db8:2::10/64';
  srv.gateway6 = '2001:db8:2::1';
  let sim = S.simulate(p);
  assert(errors(p).some((i) => /R2: OSPFv3 has no router ID/.test(i.msg)));
  r2.routing.ospf3.routerId = '2.2.2.2';
  sim = S.simulate(p);
  const h = sim.v6.hosts[pc.id];
  assert(h.ok && h.addr.startsWith('2001:db8:1:0:') && h.gateway.startsWith('fe80::'), JSON.stringify(h));
  assert.deepEqual(V6.showRoutes(sim, r1).filter((r) => r.proto === 'O').map((r) => `${r.net}/${r.len}`), ['2001:db8:2::/64']);
  const pg = V6.ping(sim, pc.id, '2001:db8:2::10');
  assert(pg.ok, pg.reason);
  assert.deepEqual(pg.fwd.hops.map((x) => x.dev), ['PC1', 'R1', 'R2', 'SRV1']);
  const t = cfg(p, 'R1');
  has(t, 'ipv6 unicast-routing');
  has(t, ' ipv6 address 2001:db8:12::1/64');
  has(t, ' ipv6 ospf 1 area 0');
  has(t, 'ipv6 router ospf 1');
  has(t, ' router-id 1.1.1.1');
  assert.deepEqual(errors(p), []);
  assert.equal(V6.format(V6.parse('2001:0db8:0000:0000:0001:0000:0000:0001')), '2001:db8::1:0:0:1');
  assert.equal(V6.format(V6.eui64('0050.56ab.cdef') | (0xfe80n << 112n)), 'fe80::250:56ff:feab:cdef');
});

test('Config import: every sample device round-trips through show running-config', () => {
  samples.forEach((smp) => {
    const p = smp.build();
    const sim = S.simulate(p);
    p.devices.filter((d) => !M.isHost(d)).forEach((d) => {
      const before = C.generate(p, d, { notes: false, sim });
      const parsed = IMP.parse(before);
      const res = IMP.apply(p, d, parsed);
      const after = C.generate(p, d, { notes: false, sim: S.simulate(p) });
      assert.equal(after, before, `${smp.id} ${d.name}: ${res.skipped.map((x) => x.line).join(' | ')}`);
    });
  });
  const p = sample('stick');
  const r1 = named(p, 'R1');
  const res = IMP.apply(p, r1, IMP.parse('hostname EDGE\ninterface gi0/0.10\n encapsulation dot1Q 10\n ip address 10.9.9.1 255.255.255.0\nip route 0.0.0.0 0.0.0.0 10.9.9.254\nsnmp-server community public RO\nfoo bar'));
  assert.equal(r1.name, 'EDGE');
  assert.equal(M.port(r1, 'GigabitEthernet0/0').subifs[0].ip, '10.9.9.1');
  assert.deepEqual(res.skipped.map((x) => x.line), ['snmp-server community public RO', 'foo bar']);
  assert.equal(IMP.ifName('Fa0/1'), 'FastEthernet0/1');
  assert.equal(IMP.ifName('gig1/0/2'), 'GigabitEthernet1/0/2');
  assert.deepEqual(IMP.parseRule('permit tcp 10.0.0.0 0.0.0.255 host 10.0.30.5 eq 443 log', 'extended'),
    { action: 'permit', proto: 'tcp', srcOp: 'any', srcPort: '', srcPort2: '', op: 'eq', port: '443', port2: '', log: true, src: '10.0.0.0 0.0.0.255', dst: 'host 10.0.30.5' });
});

test('Build guide: every config line appears once, in typing order, with checks', () => {
  samples.forEach((smp) => {
    const p = smp.build();
    const sim = S.simulate(p);
    G.guide(p, sim).forEach(({ device: d, steps }) => {
      if (M.isHost(d)) return;
      const full = C.generate(p, d, { notes: false, paste: false, sim }).split('\n').filter((l) => l && !l.startsWith('!') && !l.startsWith('interface ') && !/^ description /.test(l));
      const guided = steps.flatMap((x) => x.commands).filter((l) => !l.startsWith('interface ') && !/^ description /.test(l));
      assert.deepEqual(guided.slice().sort(), full.slice().sort(), `${smp.id} ${d.name}`);
      const order = steps.map((x) => G.STEPS.findIndex((y) => y.id === x.id));
      assert.deepEqual(order, order.slice().sort((a, b) => a - b));
    });
  });
  const p = sample('campus');
  const steps = G.guide(p, S.simulate(p)).find((x) => x.device.name === 'SW1').steps;
  assert.equal(steps.find((x) => x.id === 'vlans').check.cmd, 'show vlan brief');
  assert(/show (interfaces trunk|etherchannel)/.test(steps.find((x) => x.id === 'trunks').check.cmd));
  assert(G.guideText(p, S.simulate(p)).includes('### Step 1: Base settings'));
});

test('CML export and answer sheet', () => {
  const p = sample('stick');
  const y = X.cmlYaml(p, S.simulate(p));
  assert(y.startsWith('lab:\n'));
  assert(y.includes('node_definition: iosv\n') && y.includes('node_definition: iosvl2\n') && y.includes('node_definition: desktop\n'));
  assert(y.includes('      interface GigabitEthernet0/0.10\n'));
  assert(/switchport trunk encapsulation dot1q\n\s+switchport mode trunk/.test(y), 'IOSvL2 trunks get the encapsulation line');
  assert(!/FastEthernet/.test(y), 'every port is renamed onto the CML platform');
  assert.equal((y.split('links:')[1].match(/- id: l/g) || []).length, p.links.reduce((n, l) => n + l.members.length, 0));
  assert.equal(X.renameInConfig('interface GigabitEthernet0/1\ninterface GigabitEthernet0/10', { 'GigabitEthernet0/1': 'GigabitEthernet0/0' }), 'interface GigabitEthernet0/0\ninterface GigabitEthernet0/10');
  const sim = S.simulate(p);
  const html = G.answerSheet(p, sim, '<svg></svg>', []);
  assert(html.includes('<h2>Addressing</h2>') && html.includes('192.168.10.1') && html.includes('hostname R1'));
});

test('IPv6 subnet calculator and splitter', () => {
  const c = SUB.calc6('2001:db8:acad:12::1/48');
  assert.equal(c.network, '2001:db8:acad::');
  assert.equal(c.networkLong, '2001:0db8:acad:0000:0000:0000:0000:0000');
  assert.equal(c.last, '2001:db8:acad:ffff:ffff:ffff:ffff:ffff');
  assert.equal(c.sixtyFours, '65,536');
  assert(/^Documentation/.test(c.type));
  assert(!c.isNetwork);
  assert.equal(SUB.calc6('fe80::1').len, 64);
  assert(/Link-local/.test(SUB.calc6('fe80::1').type));
  assert(/Unique local/.test(SUB.calc6('fd00:1::/48').type));
  assert(/Global unicast/.test(SUB.calc6('2600::/32').type));
  assert(SUB.calc6('2001:db8::g/64').error);
  const s = SUB.split6('2001:db8:acad::/48', 64, 0, 3);
  assert.equal(s.total, '65536');
  assert.deepEqual(s.rows.map((r) => r.net), ['2001:db8:acad::', '2001:db8:acad:1::', '2001:db8:acad:2::']);
  assert.equal(SUB.split6('2001:db8:acad::/48', 64, 255, 1).rows[0].net, '2001:db8:acad:ff::');
  assert.equal(SUB.split6('2001:db8:acad::/48', 64, 99999, 1).rows[0].net, '2001:db8:acad:ffff::', 'clamped to the last subnet');
  const odd = SUB.split6('2001:db8::/32', 34, 0, 4);
  assert.deepEqual(odd.rows.map((r) => r.net), ['2001:db8::', '2001:db8:4000::', '2001:db8:8000::', '2001:db8:c000::']);
  assert.equal(odd.nibble, false);
  assert.equal(odd.rows[0].last, '2001:db8:3fff:ffff:ffff:ffff:ffff:ffff');
  assert(SUB.split6('2001:db8::/64', 48).error);
});

// Types lines into one device's console and returns the outputs.
function typeInto(target, practice, devName, text) {
  const d = named(target, devName);
  const ctx = { target, practice, session: { mode: 'user', cur: null } };
  return text.split('\n').map((l) => ({ prompt: P.promptFor(ctx, d.id), out: P.exec(ctx, d.id, l).out }));
}

test('CLI lab: abbreviations, modes, validation and show commands', () => {
  assert.equal(P.expand('priv', 'conf t').line, 'configure terminal');
  assert.equal(P.expand('priv', 'sh ip int br').line, 'show ip interface brief');
  assert.equal(P.expand('config', 'int g0/0.10').line, 'interface GigabitEthernet0/0.10');
  assert.equal(P.expand('config', 'int fa 0/1').line, 'interface FastEthernet0/1');
  assert.equal(P.expand('config-if', 'no shut').line, 'no shutdown');
  assert.equal(P.expand('config-if', 'sw mo tr').line, 'switchport mode trunk');
  assert.equal(P.expand('config-if', 'sw tr all vl 10,20').line, 'switchport trunk allowed vlan 10,20');
  assert(P.expand('priv', 'co').error, 'co is ambiguous between configure and copy');
  const target = sample('stick');
  const practice = { devices: {}, hosts: {} };
  const out = typeInto(target, practice, 'R1', 'en\nconf t\nhostname R1\nint g0/9\nint g0/0\nno shut\nint g0/0.10\nencapsulation dot1q 10\nip add 192.168.10.1 255.255.255.0\nfrobnicate\nsnmp-server community x RO\nip route 0.0.0.0 0.0.0.0 192.168.10.254\nend\nsh ip int br | i 0/0');
  assert.deepEqual(out.slice(0, 4).map((x) => x.prompt), ['Router>', 'Router#', 'Router(config)#', 'R1(config)#']);
  assert(/Invalid interface/.test(out[3].out));
  assert(/Invalid input/.test(out[9].out));
  assert(/does not simulate/.test(out[10].out));
  assert.equal(out[11].prompt, 'R1(config-subif)#', 'a global command typed in a sub-mode still applies');
  assert(/GigabitEthernet0\/0\.10\s+192\.168\.10\.1\s+YES manual up/.test(out[13].out), out[13].out);
  const run = P.serialize(practice.devices[named(target, 'R1').id].blocks).text;
  assert(run.includes('ip route 0.0.0.0 0.0.0.0 192.168.10.254'));
  typeInto(target, practice, 'R1', 'en\nconf t\nno ip route 0.0.0.0 0.0.0.0 192.168.10.254\nint g0/0.10\nip address 192.168.10.2 255.255.255.0');
  const run2 = P.serialize(practice.devices[named(target, 'R1').id].blocks).text;
  assert(!run2.includes('ip route'), 'no removes the route');
  assert((run2.match(/ip address/g) || []).length === 1, 'a second ip address replaces the first');
});

test('CLI lab: router ports start shut, VLANs must exist, scoring and exact fixes', () => {
  const target = sample('stick');
  const practice = { devices: {}, hosts: {} };
  let sc = P.score(target, P.buildStudent(target, practice));
  assert.equal(sc.matched, 0);
  target.devices.filter(M.isHost).forEach((h) => {
    const c = h.ports.Ethernet0;
    typeInto(target, practice, h.name, `ipconfig ${c.ip} ${c.mask} ${h.gateway}`);
  });
  typeInto(target, practice, 'R1', 'en\nconf t\nhostname R1\nint g0/0.10\nenc dot 10\nip add 192.168.10.1 255.255.255.0\nint g0/0.20\nenc dot 20\nip add 192.168.20.1 255.255.255.0\nint g0/0.99\nenc dot 99 native');
  typeInto(target, practice, 'SW1', 'en\nconf t\nhostname SW1\nvlan 10\nname STUDENTS\nvlan 20\nname STAFF\nvlan 99\nname NATIVE\nint g0/1\nsw mo tr\nsw tr nat vl 99\nsw tr all vl 10,20,99\nint range fa0/1-2');
  ['FastEthernet0/1', 'FastEthernet0/2'].forEach((n) => typeInto(target, practice, 'SW1', `en\nconf t\nint ${n}\nsw mo acc\nsw acc vl 10`));
  typeInto(target, practice, 'SW1', 'en\nconf t\nint fa0/3\nsw acc vl 20');
  let student = P.buildStudent(target, practice);
  sc = P.score(target, student);
  assert.equal(sc.matched, 2, 'only PC1 and PC2, in the same VLAN, reach each other while the router port is shut');
  const fix = P.fixCommands(target, student, named(target, 'R1').id, practice);
  assert(fix.includes('interface GigabitEthernet0/0') && fix.includes(' no shutdown'), fix.join('|'));
  const a = T.ask({ p: student, sim: S.simulate(student), issues: [], cli: true }, 'why cant pc1 ping staff1');
  assert(/R1 Gi0\/0 is administratively down/.test(a.summary), a.summary);
  typeInto(target, practice, 'R1', 'en\nconf t\nint g0/0\nno shut');
  student = P.buildStudent(target, practice);
  sc = P.score(target, student);
  assert(sc.done, JSON.stringify(sc.cells.filter((c) => !c.match)));
  // A VLAN the switch never created leaves its access ports inactive.
  typeInto(target, practice, 'SW1', 'en\nconf t\nno vlan 20');
  student = P.buildStudent(target, practice);
  assert(student.practiceNotes.some((n) => /VLAN 20, which SW1 has not created/.test(n)));
  assert(!P.score(target, student).done);
});

test('Troubleshooting assistant: parses questions and names the cause and fix', () => {
  const p0 = sample('campus');
  const q = T.parseQuestion(p0, "why can't pc 1 reach web1 on http?");
  assert.deepEqual([q.kind, q.mentions.map((m) => m.dev.name), q.service.port], ['ping', ['PC1', 'WEB1'], 80]);
  assert.equal(T.parseQuestion(p0, 'why does PC2 not get an address').kind, 'dhcp');
  assert.equal(T.parseQuestion(p0, "why aren't R1 and CORE1 OSPF neighbors").kind, 'ospf');
  const ask = (p, text) => {
    const sim = S.simulate(p);
    return T.ask({ p, sim, issues: V.validate(p, sim) }, text);
  };
  // A wrong mask on the router side of a point-to-point link.
  const p = sample('rip');
  const r1 = named(p, 'R1');
  const l = M.linksOf(p, r1.id).find((x) => M.dev(p, M.peerOf(x, r1.id)).name === 'R2');
  M.port(r1, M.endIf(l, r1.id)).mask = '255.255.255.0';
  let a = ask(p, "why can't R1 ping R2");
  assert(/The mask on R1 interface Gi0\/0 is \/24 \(255\.255\.255\.0\), but R2 uses \/30/.test(a.summary), a.summary);
  assert.deepEqual(a.fixes, [{ device: 'R1', lines: ['interface GigabitEthernet0/0', ' ip address 10.0.12.1 255.255.255.252'] }]);
  // A host gateway typo.
  const s = sample('stick');
  named(s, 'PC1').gateway = '192.168.10.254';
  a = ask(s, 'pc1 cannot ping staff1');
  assert(/nothing on its segment has that address/.test(a.summary));
  assert(/default gateway 192\.168\.10\.1$/.test(a.fixes[0].lines[0]));
  // A trunk that leaves a VLAN out.
  const t = sample('stick');
  M.linksOf(t, named(t, 'R1').id)[0].allowed = '10,99';
  a = ask(t, 'why cant staff1 ping pc1');
  assert(/does not allow VLAN 20/.test(a.summary));
  assert(a.fixes.some((f) => f.lines.includes(' switchport trunk allowed vlan add 20')));
  // An ACL drop gets a permit placed above the deny.
  const c = sample('campus');
  const m = S.matrix(S.simulate(c));
  const blocked = m.rows.flatMap((row, i) => row.map((x, j) => (x && !x.ok ? [m.hosts[i], m.hosts[j]] : null))).find(Boolean);
  a = ask(c, `why can't ${blocked[0].name} ping ${blocked[1].name}`);
  assert(/ACL/.test(a.summary) && /working as designed/.test(a.summary), a.summary);
  assert(/^ \d+ permit icmp host /.test(a.fixes[0].lines[1]), a.fixes[0].lines.join('|'));
  a = ask(sample('stick'), 'can pc1 ping pc2');
  assert(a.ok && /It works/.test(a.summary));
});

tests.forEach(([name, fn]) => {
  try {
    fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}\n${e.message}\n`);
    process.exitCode = 1;
  }
});
console.log(`\n${passed}/${tests.length} passed`);
