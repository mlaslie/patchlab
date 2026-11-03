// Reads a pasted "show running-config" into a device. It understands the commands PatchLab
// itself generates, plus the common forms students type, and reports every line it skipped.
(function (PL) {
  'use strict';

  const { MODELS } = PL.catalog;
  const N = PL.net;
  const M = PL.model;

  const LONG = [['gigabitethernet', 'GigabitEthernet'], ['fastethernet', 'FastEthernet'], ['port-channel', 'Port-channel'], ['loopback', 'Loopback'], ['vlan', 'Vlan'], ['ethernet', 'Ethernet']];
  const SHORT = [['gig', 'GigabitEthernet'], ['gi', 'GigabitEthernet'], ['g', 'GigabitEthernet'], ['fa', 'FastEthernet'], ['f', 'FastEthernet'], ['po', 'Port-channel'], ['lo', 'Loopback'], ['vl', 'Vlan'], ['eth', 'Ethernet'], ['e', 'Ethernet']];

  // "gi0/1", "Gig 0/1" or "GigabitEthernet0/1" all become "GigabitEthernet0/1".
  function ifName(text) {
    const s = String(text || '').replace(/\s+/g, '');
    const m = /^([A-Za-z-]+)([\d/.:]+)$/.exec(s);
    if (!m) return s;
    const word = m[1].toLowerCase();
    const full = LONG.find(([k]) => k === word || (word.length >= 2 && k.startsWith(word) && word.length > 3));
    if (full) return full[1] + m[2];
    const short = SHORT.find(([k]) => k === word);
    return short ? short[1] + m[2] : m[1] + m[2];
  }

  // Lines that carry nothing PatchLab models, or that it sets lab-wide. They are not reported.
  const QUIET = /^(enable$|configure terminal|conf t|end$|exit$|write|copy |Building configuration|Current configuration|version |!|no ip domain-lookup|no ip domain lookup|service |enable (secret|password)|banner |ip domain[- ]name|line |logging|password|login|transport|exec-timeout|ip ssh|crypto |username|ip cef|no ip http|ip http|boot|license|spanning-tree mode|spanning-tree extend|spanning-tree portfast|spanning-tree bpduguard|ip routing$|no ip source-route|ipv6 cef|redundancy|mode |memory|diagnostic|archive|control-plane|speed|duplex|media-type|negotiation|hostname)/i;
  const QUIET_CHILD = /^(description|shutdown|no shutdown|switchport nonegotiate|spanning-tree portfast|spanning-tree bpduguard|negotiation|speed|duplex|media-type|no cdp|no mop|no keepalive|no ip address|switchport trunk encapsulation|version 2|no auto-summary|log-adjacency-changes|auto-cost|password|login|logging|transport|exec-timeout|privilege|access-class|history|stopbits|ipv6 enable|ip ospf |cdp |lldp )/i;

  const isNumberedStd = (n) => (+n >= 1 && +n <= 99) || (+n >= 1300 && +n <= 1999);

  // Parses one ACL entry after the list name: "permit tcp any host 10.0.0.5 eq 80 log".
  function parseRule(text, type) {
    const t = text.trim().split(/\s+/);
    if (/^\d+$/.test(t[0])) t.shift();
    if (t[0] === 'remark') return { remark: text.trim().replace(/^(\d+\s+)?remark\s?/, '') };
    const action = t.shift();
    if (action !== 'permit' && action !== 'deny') return null;
    const addr = () => {
      const w = t.shift();
      if (w === 'any') return 'any';
      if (w === 'host') return `host ${t.shift()}`;
      if (N.ip2n(w) !== null && t[0] && N.ip2n(t[0]) !== null) return `${w} ${t.shift()}`;
      return w;
    };
    const ports = (rule, opKey, loKey, hiKey) => {
      const op = t[0];
      if (!['eq', 'neq', 'gt', 'lt', 'range'].includes(op)) return;
      t.shift();
      rule[opKey] = op;
      rule[loKey] = t.shift();
      if (op === 'range') rule[hiKey] = t.shift();
    };
    const log = () => { const i = t.indexOf('log'); if (i > -1) t.splice(i, 1); return i > -1; };
    if (type === 'standard') {
      const lg = log();
      return { action, src: addr(), log: lg || undefined };
    }
    const r = { action, proto: t.shift(), srcOp: 'any', srcPort: '', srcPort2: '', op: 'any', port: '', port2: '' };
    r.log = log() || undefined;
    r.src = addr();
    if (r.proto === 'tcp' || r.proto === 'udp') ports(r, 'srcOp', 'srcPort', 'srcPort2');
    r.dst = addr();
    if (r.proto === 'tcp' || r.proto === 'udp') ports(r, 'op', 'port', 'port2');
    if (t[0] === 'established') { r.established = true; t.shift(); }
    if (r.proto === 'icmp' && t[0]) r.icmpType = t.shift();
    if (!r.src || !r.dst || t.length) return null;
    return r;
  }

  // Returns the configuration as data plus the lines it could not use.
  function parse(text) {
    const cfg = {
      hostname: '', vlans: {}, ifs: {}, routes: [], routes6: [], acls: [], dhcp: { pools: [], excluded: [] }, defaultGateway: '',
      ospf: null, rip: null, bgp: null, ospf3: null, nat: { pat: null, statics: [] }, snooping: null, stp: {}, skipped: [], used: 0,
    };
    const acl = (name, type) => {
      let a = cfg.acls.find((x) => x.name === name);
      if (!a) cfg.acls.push((a = { name, type, rules: [] }));
      return a;
    };
    const lines = String(text || '').replace(/\r/g, '').split('\n');
    let ctx = null;
    lines.forEach((raw, idx) => {
      const line = raw.replace(/\s+$/, '');
      if (!line.trim()) return;
      const child = /^\s/.test(line);
      const s = line.trim();
      const skip = () => cfg.skipped.push({ n: idx + 1, line: s });
      const ok = () => { cfg.used++; };
      let m;
      if (!child) ctx = null;
      if (child && ctx) {
        if (ctx.kind === 'if') return childIf(ctx.it, s, ok, skip);
        if (ctx.kind === 'vlan') { if ((m = /^name\s+(\S+)/.exec(s))) { ctx.it.name = m[1]; return ok(); } return skip(); }
        if (ctx.kind === 'acl') { const r = parseRule(s, ctx.it.type); if (r) { ctx.it.rules.push(r); return ok(); } return skip(); }
        if (ctx.kind === 'pool') return childPool(ctx.it, s, ok, skip);
        if (ctx.kind === 'ospf') return childOspf(ctx.it, s, ok, skip);
        if (ctx.kind === 'rip') return childRip(ctx.it, s, ok, skip);
        if (ctx.kind === 'bgp') return childBgp(ctx.it, s, ok, skip);
        if (ctx.kind === 'ospf3') { if ((m = /^router-id\s+(\S+)/.exec(s))) { ctx.it.routerId = m[1]; return ok(); } return QUIET_CHILD.test(s) ? null : skip(); }
        return QUIET_CHILD.test(s) ? null : skip();
      }
      if ((m = /^hostname\s+(\S+)/.exec(s))) { cfg.hostname = m[1]; return ok(); }
      if ((m = /^vlan\s+([\d,-]+)$/.exec(s))) {
        const ids = N.expandList(m[1]);
        ids.forEach((id) => { cfg.vlans[id] = cfg.vlans[id] || { id, name: '' }; });
        ctx = ids.length === 1 ? { kind: 'vlan', it: cfg.vlans[ids[0]] } : { kind: 'quiet' };
        return ok();
      }
      if ((m = /^interface\s+range\s/.exec(s))) { ctx = { kind: 'quiet' }; return skip(); }
      if ((m = /^interface\s+(.+)$/.exec(s))) {
        const name = ifName(m[1]);
        cfg.ifs[name] = cfg.ifs[name] || { name, kids: 0 };
        ctx = { kind: 'if', it: cfg.ifs[name] };
        return ok();
      }
      if ((m = /^ip route\s+(\S+)\s+(\S+)\s+(\S+(?:\s+\S+)?)$/.exec(s))) {
        const parts = m[3].split(/\s+/);
        let via = parts[0];
        let ad = 1;
        if (parts[1] && /^\d+$/.test(parts[1])) ad = +parts[1];
        else if (parts[1] && N.ip2n(parts[1]) !== null) via = parts[1];
        if (N.ip2n(via) === null) via = ifName(via);
        cfg.routes.push({ net: m[1], mask: m[2], via, ad });
        return ok();
      }
      if ((m = /^ipv6 route\s+(\S+)\s+(\S+)/.exec(s))) { cfg.routes6.push({ net: m[1], via: /:/.test(m[2]) ? m[2] : ifName(m[2]) }); return ok(); }
      if ((m = /^ip default-gateway\s+(\S+)/.exec(s))) { cfg.defaultGateway = m[1]; return ok(); }
      if ((m = /^access-list\s+(\d+)\s+(.+)$/.exec(s))) {
        const type = isNumberedStd(m[1]) ? 'standard' : 'extended';
        const r = parseRule(m[2], type);
        if (!r) return skip();
        acl(m[1], type).rules.push(r);
        return ok();
      }
      if ((m = /^ip access-list\s+(standard|extended)\s+(\S+)/.exec(s))) { ctx = { kind: 'acl', it: acl(m[2], m[1]) }; return ok(); }
      if ((m = /^ip dhcp excluded-address\s+(\S+)(?:\s+(\S+))?/.exec(s))) { cfg.dhcp.excluded.push({ from: m[1], to: m[2] || '' }); return ok(); }
      if ((m = /^ip dhcp pool\s+(\S+)/.exec(s))) {
        const pool = { name: m[1], network: '', mask: '', gateway: '', dns: '', domain: '' };
        cfg.dhcp.pools.push(pool);
        ctx = { kind: 'pool', it: pool };
        return ok();
      }
      if (/^ip dhcp snooping$/.test(s)) { cfg.snooping = cfg.snooping || { on: true, vlans: '' }; cfg.snooping.on = true; return ok(); }
      if ((m = /^ip dhcp snooping vlan\s+(\S+)/.exec(s))) { cfg.snooping = cfg.snooping || { on: true, vlans: '' }; cfg.snooping.vlans = m[1]; return ok(); }
      if (/^no ip dhcp snooping information option/.test(s)) return ok();
      if ((m = /^router ospf\s+(\d+)/.exec(s))) { cfg.ospf = { pid: +m[1], routerId: '', networks: [], passive: [], redistribute: [], defaultOriginate: false }; ctx = { kind: 'ospf', it: cfg.ospf }; return ok(); }
      if (/^router rip/.test(s)) { cfg.rip = { networks: [], passive: [], redistribute: [], defaultOriginate: false }; ctx = { kind: 'rip', it: cfg.rip }; return ok(); }
      if ((m = /^router bgp\s+(\d+)/.exec(s))) { cfg.bgp = { asn: m[1], routerId: '', neighbors: [], networks: [], redistribute: [] }; ctx = { kind: 'bgp', it: cfg.bgp }; return ok(); }
      if ((m = /^ipv6 router ospf\s+(\d+)/.exec(s))) { cfg.ospf3 = { pid: +m[1], routerId: '' }; ctx = { kind: 'ospf3', it: cfg.ospf3 }; return ok(); }
      if (/^ipv6 unicast-routing/.test(s)) return ok();
      if ((m = /^ip nat inside source list\s+(\S+)\s+interface\s+(\S+)\s+overload/.exec(s))) { cfg.nat.pat = { acl: m[1], iface: ifName(m[2]) }; return ok(); }
      if ((m = /^ip nat inside source static\s+(\S+)\s+(\S+)/.exec(s))) { cfg.nat.statics.push({ local: m[1], global: m[2] }); return ok(); }
      if ((m = /^spanning-tree vlan\s+(\S+)\s+priority\s+(\d+)/.exec(s))) { N.expandList(m[1]).forEach((v) => { cfg.stp[v] = +m[2]; }); return ok(); }
      if ((m = /^spanning-tree vlan\s+(\S+)\s+root\s+(primary|secondary)/.exec(s))) { N.expandList(m[1]).forEach((v) => { cfg.stp[v] = m[2] === 'primary' ? 24576 : 28672; }); return ok(); }
      if (QUIET.test(s)) { ctx = { kind: 'quiet' }; return null; }
      ctx = { kind: 'quiet' };
      return skip();
    });
    return cfg;
  }

  function childIf(it, s, ok, skip) {
    let m;
    it.kids++;
    if ((m = /^description\s+(.+)$/.exec(s))) { it.desc = m[1]; return ok(); }
    if (s === 'shutdown') { it.shutdown = true; return ok(); }
    if (s === 'no shutdown') { it.shutdown = false; return ok(); }
    if ((m = /^ip address\s+(\S+)\s+(\S+)(\s+secondary)?$/.exec(s))) { if (m[3]) return skip(); it.ip = m[1]; it.mask = m[2]; return ok(); }
    if (s === 'ip address dhcp') { it.dhcpClient = true; return ok(); }
    if (s === 'no switchport') { it.routed = true; return ok(); }
    if ((m = /^switchport mode\s+(access|trunk)/.exec(s))) { it.mode = m[1]; return ok(); }
    if ((m = /^switchport access vlan\s+(\d+)/.exec(s))) { it.vlan = +m[1]; return ok(); }
    if ((m = /^switchport trunk native vlan\s+(\d+)/.exec(s))) { it.native = +m[1]; return ok(); }
    if ((m = /^switchport trunk allowed vlan\s+(?:add\s+)?(\S+)/.exec(s))) { it.allowed = m[1] === 'all' ? 'all' : (it.allowed && /add/.test(s) ? `${it.allowed},${m[1]}` : m[1]); return ok(); }
    if ((m = /^channel-group\s+(\d+)(?:\s+mode\s+(\S+))?/.exec(s))) { it.channel = { group: +m[1], mode: m[2] || 'on' }; return ok(); }
    if ((m = /^encapsulation dot1q\s+(\d+)(\s+native)?/i.exec(s))) { it.encap = +m[1]; it.native = !!m[2]; return ok(); }
    if ((m = /^ip helper-address\s+(\S+)/.exec(s))) { it.helper = m[1]; return ok(); }
    if ((m = /^ip access-group\s+(\S+)\s+(in|out)/.exec(s))) { it[m[2] === 'in' ? 'aclIn' : 'aclOut'] = m[1]; return ok(); }
    if ((m = /^ip nat\s+(inside|outside)/.exec(s))) { it.nat = m[1]; return ok(); }
    if ((m = /^standby\s+(\d+)\s+ip\s+(\S+)/.exec(s))) { it.hsrp = { ...(it.hsrp || { priority: 100, preempt: false }), group: +m[1], vip: m[2] }; return ok(); }
    if ((m = /^standby\s+(\d+)\s+priority\s+(\d+)/.exec(s))) { it.hsrp = { ...(it.hsrp || { vip: '', preempt: false }), group: +m[1], priority: +m[2] }; return ok(); }
    if ((m = /^standby\s+(\d+)\s+preempt/.exec(s))) { it.hsrp = { ...(it.hsrp || { vip: '', priority: 100 }), group: +m[1], preempt: true }; return ok(); }
    if (/^standby version/.test(s)) return ok();
    if (s === 'switchport port-security') { it.portSec = { max: 1, sticky: false, violation: 'shutdown', ...(it.portSec || {}) }; return ok(); }
    if ((m = /^switchport port-security maximum\s+(\d+)/.exec(s))) { it.portSec = { ...(it.portSec || { sticky: false, violation: 'shutdown' }), max: +m[1] }; return ok(); }
    if (/^switchport port-security mac-address sticky$/.test(s)) { it.portSec = { ...(it.portSec || { max: 1, violation: 'shutdown' }), sticky: true }; return ok(); }
    if ((m = /^switchport port-security violation\s+(\S+)/.exec(s))) { it.portSec = { ...(it.portSec || { max: 1, sticky: false }), violation: m[1] }; return ok(); }
    if (s === 'ip dhcp snooping trust') { it.trust = true; return ok(); }
    if ((m = /^ipv6 address\s+(\S+\/\d+)/.exec(s))) { it.ip6 = m[1]; return ok(); }
    if ((m = /^ipv6 ospf\s+\d+\s+area\s+(\S+)/.exec(s))) { it.ospf3 = m[1]; return ok(); }
    if (QUIET_CHILD.test(s)) return null;
    return skip();
  }

  function childPool(pool, s, ok, skip) {
    let m;
    if ((m = /^network\s+(\S+)\s+(\S+)/.exec(s))) { pool.network = m[1]; pool.mask = N.normalizeMask(m[2]) || m[2]; return ok(); }
    if ((m = /^default-router\s+(\S+)/.exec(s))) { pool.gateway = m[1]; return ok(); }
    if ((m = /^dns-server\s+(\S+)/.exec(s))) { pool.dns = m[1]; return ok(); }
    if ((m = /^domain-name\s+(\S+)/.exec(s))) { pool.domain = m[1]; return ok(); }
    return QUIET_CHILD.test(s) ? null : skip();
  }

  const redist = (list, s) => {
    const m = /^redistribute\s+(connected|static|ospf|rip|bgp)/.exec(s);
    if (m && !list.includes(m[1])) list.push(m[1]);
    return !!m;
  };

  function childOspf(o, s, ok, skip) {
    let m;
    if ((m = /^router-id\s+(\S+)/.exec(s))) { o.routerId = m[1]; return ok(); }
    if ((m = /^network\s+(\S+)\s+(\S+)\s+area\s+(\S+)/.exec(s))) { o.networks.push({ net: m[1], wild: m[2], area: m[3] }); return ok(); }
    if ((m = /^passive-interface\s+(\S+)/.exec(s)) && m[1] !== 'default') { o.passive.push(ifName(m[1])); return ok(); }
    if (/^default-information originate/.test(s)) { o.defaultOriginate = true; return ok(); }
    if (redist(o.redistribute, s)) return ok();
    return QUIET_CHILD.test(s) ? null : skip();
  }

  function childRip(r, s, ok, skip) {
    let m;
    if ((m = /^network\s+(\S+)/.exec(s))) { r.networks.push(m[1]); return ok(); }
    if ((m = /^passive-interface\s+(\S+)/.exec(s)) && m[1] !== 'default') { r.passive.push(ifName(m[1])); return ok(); }
    if (/^default-information originate/.test(s)) { r.defaultOriginate = true; return ok(); }
    if (/^version 1/.test(s)) return skip();
    if (redist(r.redistribute, s)) return ok();
    return QUIET_CHILD.test(s) ? null : skip();
  }

  function childBgp(b, s, ok, skip) {
    let m;
    const nb = (ip) => {
      let n = b.neighbors.find((x) => x.ip === ip);
      if (!n) b.neighbors.push((n = { ip, remoteAs: '', desc: '', updateSource: '', nextHopSelf: false }));
      return n;
    };
    if ((m = /^bgp router-id\s+(\S+)/.exec(s))) { b.routerId = m[1]; return ok(); }
    if (/^bgp log-neighbor-changes/.test(s)) return null;
    if ((m = /^neighbor\s+(\S+)\s+remote-as\s+(\d+)/.exec(s))) { nb(m[1]).remoteAs = m[2]; return ok(); }
    if ((m = /^neighbor\s+(\S+)\s+description\s+(.+)$/.exec(s))) { nb(m[1]).desc = m[2]; return ok(); }
    if ((m = /^neighbor\s+(\S+)\s+update-source\s+(\S+)/.exec(s))) { nb(m[1]).updateSource = ifName(m[2]); return ok(); }
    if ((m = /^neighbor\s+(\S+)\s+next-hop-self/.exec(s))) { nb(m[1]).nextHopSelf = true; return ok(); }
    if ((m = /^network\s+(\S+)(?:\s+mask\s+(\S+))?/.exec(s))) {
      // Without "mask", BGP takes the classful mask.
      const first = +m[1].split('.')[0];
      b.networks.push({ net: m[1], mask: m[2] || N.lenToMask(first < 128 ? 8 : first < 192 ? 16 : 24) });
      return ok();
    }
    if (redist(b.redistribute, s)) return ok();
    return QUIET_CHILD.test(s) ? null : skip();
  }

  const L3_KEYS = ['desc', 'shutdown', 'ip', 'mask', 'aclIn', 'aclOut', 'helper', 'nat', 'hsrp', 'ip6', 'ospf3'];

  function copyL3(from, to) {
    L3_KEYS.forEach((k) => { if (from[k] !== undefined) to[k] = from[k]; });
  }

  // Replaces the device's settings with the parsed ones. Cables stay; switchport settings
  // go onto the cable plugged into that port, so both ends keep agreeing.
  function apply(p, d, cfg) {
    const notes = [];
    const ports = MODELS[d.model].ports;
    if (cfg.hostname) d.name = cfg.hostname.replace(/\s+/g, '-');
    Object.values(cfg.vlans).forEach((v) => {
      if (v.id === 1 || v.id > 4094) return;
      const have = p.vlans.find((x) => x.id === v.id);
      if (have) { if (v.name) have.name = v.name; } else {
        p.vlans.push({ id: v.id, name: v.name || `VLAN${v.id}`, subnet: '', mask: '' });
        notes.push(`Added VLAN ${v.id} to the lab.`);
      }
    });
    p.vlans.sort((a, b) => a.id - b.id);

    // Start from a clean device: keep cables, drop what the paste will redefine.
    const keepPorts = {};
    Object.keys(d.ports).forEach((n) => { keepPorts[n] = { desc: '', shutdown: false, ip: '', mask: '', aclIn: '', aclOut: '', subifs: [] }; });
    d.ports = keepPorts;
    d.svis = [];
    d.loopbacks = [];
    d.acls = [];
    d.routing = M.newRouting();
    d.dhcp = M.newDhcp();
    d.nat = { pat: null, statics: [] };
    d.snooping = { on: false, vlans: '' };
    d.stp = { ...(d.stp || {}), priority: {} };

    const subs = [];
    Object.values(cfg.ifs).forEach((it) => {
      const name = it.name;
      if (/\.\d+$/.test(name)) return subs.push(it);
      if (/^Loopback\d+$/.test(name)) {
        const lo = { num: +name.slice(8), ip: it.ip || '', mask: it.mask || '255.255.255.255', desc: it.desc || '' };
        if (it.ip6) lo.ip6 = it.ip6;
        if (it.ospf3) lo.ospf3 = it.ospf3;
        d.loopbacks.push(lo);
        return;
      }
      if (/^Vlan\d+$/.test(name)) {
        if (!M.isSwitch(d)) return notes.push(`${name} skipped: only switches have VLAN interfaces.`);
        const svi = { vlan: +name.slice(4), ip: '', mask: '', desc: '', shutdown: false, aclIn: '', aclOut: '' };
        copyL3(it, svi);
        d.svis.push(svi);
        return;
      }
      const po = /^Port-channel(\d+)$/.exec(name);
      const link = po
        ? M.linksOf(p, d.id).find((l) => l.ec && M.endIf(l, d.id) === name)
        : M.linkOnPort(p, d.id, name);
      if (!po && !ports.includes(name) && !(M.isHost(d))) return notes.push(`${name} skipped: a ${MODELS[d.model].label} has no such port.`);
      if (it.channel && !po) {
        if (!link || !link.ec) notes.push(`${name} has channel-group ${it.channel.group}, but its cable is not bundled. Bundle it on the cable panel.`);
        return;
      }
      if (M.isHost(d)) return;
      const c = M.port(d, link && link.ec ? M.endIf(link, d.id) : name);
      const switchport = M.isSwitch(d) && !it.routed;
      if (switchport) {
        c.desc = it.desc || '';
        c.shutdown = !!it.shutdown;
        if (it.portSec) c.portSec = it.portSec;
        if (it.trust) c.trust = true;
        if (!link) {
          if (it.mode || it.vlan) notes.push(`${name} has switchport settings but no cable in the lab. Cable it, then import again.`);
          return;
        }
        const peer = M.dev(p, M.peerOf(link, d.id));
        const before = `${link.mode}`;
        if (it.mode === 'trunk' && M.allowedModes(d, peer).includes('trunk')) {
          link.mode = 'trunk';
          link.nativeVlan = it.native || 1;
          link.allowed = it.allowed && it.allowed !== 'all' ? N.compressList(N.expandList(it.allowed)) : 'all';
        } else if (it.mode === 'access' || it.vlan) {
          link.mode = 'access';
          link.vlan = it.vlan || 1;
        }
        if (before !== link.mode) notes.push(`The cable to ${peer.name} is now ${link.mode}, so ${peer.name}'s end changed too.`);
        return;
      }
      if (it.routed && link && M.isL3Switch(d)) {
        const peer = M.dev(p, M.peerOf(link, d.id));
        if (M.allowedModes(d, peer).includes('routed')) link.mode = 'routed';
      }
      copyL3(it, c);
    });
    subs.forEach((it) => {
      const [parent, num] = it.name.split('.');
      if (!M.isRouter(d)) return notes.push(`${it.name} skipped: sub-interfaces are for routers.`);
      const c = M.port(d, parent);
      const s = { num: +num, vlan: it.encap || +num, ip: '', mask: '', native: !!it.native, desc: it.desc || '', aclIn: '', aclOut: '' };
      copyL3(it, s);
      c.subifs.push(s);
      c.subifs.sort((a, b) => a.num - b.num);
    });

    if (M.isHost(d)) {
      const nic = cfg.ifs.Ethernet0 || Object.values(cfg.ifs)[0];
      if (nic && nic.ip) Object.assign(M.port(d, 'Ethernet0'), { ip: nic.ip, mask: nic.mask });
    }

    cfg.acls.forEach((a) => d.acls.push({ id: M.uid('a'), name: a.name, type: a.type, rules: a.rules }));
    if (M.canRoute(d)) {
      d.routing.static = cfg.routes.map((r) => ({ ...r }));
      d.routing.static6 = cfg.routes6.map((r) => ({ ...r }));
      if (cfg.ospf) d.routing.ospf = { ...d.routing.ospf, ...cfg.ospf, enabled: true };
      if (cfg.rip) d.routing.rip = { ...d.routing.rip, ...cfg.rip, enabled: true };
      if (cfg.bgp) d.routing.bgp = { ...d.routing.bgp, ...cfg.bgp, enabled: true };
      if (cfg.ospf3) d.routing.ospf3 = { ...d.routing.ospf3, ...cfg.ospf3, enabled: true };
      d.dhcp = { pools: cfg.dhcp.pools, excluded: cfg.dhcp.excluded };
      d.nat = cfg.nat;
    } else if (cfg.routes.length || cfg.ospf || cfg.rip || cfg.bgp) notes.push('Routing commands skipped: this device does not route.');
    if (M.isSwitch(d)) {
      d.stp.priority = { ...cfg.stp };
      if (cfg.snooping) d.snooping = cfg.snooping;
      if (cfg.defaultGateway) d.gateway = cfg.defaultGateway;
    }
    M.normalize(p);
    return { used: cfg.used, skipped: cfg.skipped, notes };
  }

  PL.importer = { parse, apply, ifName, parseRule };
})(typeof window !== 'undefined' ? (window.PL = window.PL || {}) : (globalThis.PL = globalThis.PL || {}));
