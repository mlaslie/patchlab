// Turns the project into IOS CLI. Output is meant to be pasted at a device console.
(function (PL) {
  'use strict';

  const { MODELS, shortName, naturalCompare } = PL.catalog;
  const N = PL.net;
  const M = PL.model;

  class Out {
    constructor(notes) {
      this.lines = [];
      this.notes = notes;
    }
    add(...lines) { this.lines.push(...lines); }
    section(title, note) {
      this.lines.push('!', `! ${title}`);
      if (this.notes && note) note.split('\n').forEach((n) => this.lines.push(`! ${n}`));
    }
  }

  const ecMode = (l, s) => M.EC_PRESETS[l.ec.preset][s];

  function peerDesc(p, d, l) {
    const peer = M.dev(p, M.peerOf(l, d.id));
    const peerPort = M.endIf(l, peer.id);
    return `To ${peer.name} ${shortName(peerPort)}`;
  }

  function switchportLines(p, d, l) {
    const out = [];
    if (l.mode === 'access') {
      out.push(' switchport mode access', ` switchport access vlan ${l.vlan}`);
      return out;
    }
    if (MODELS[d.model].trunkEncap) out.push(' switchport trunk encapsulation dot1q');
    out.push(' switchport mode trunk');
    if (l.nativeVlan !== 1) out.push(` switchport trunk native vlan ${l.nativeVlan}`);
    if (l.allowed !== 'all' && l.allowed) out.push(` switchport trunk allowed vlan ${N.compressList(N.expandList(l.allowed))}`);
    if (p.settings.nonegotiate) out.push(' switchport nonegotiate');
    return out;
  }

  // Per-interface Layer 3 extras, shared by routed ports, sub-interfaces and SVIs.
  function aclLines(c, d) {
    const out = [];
    if (c.helper) out.push(` ip helper-address ${c.helper}`);
    if (c.aclIn) out.push(` ip access-group ${c.aclIn} in`);
    if (c.aclOut) out.push(` ip access-group ${c.aclOut} out`);
    if (c.nat === 'inside' || c.nat === 'outside') out.push(` ip nat ${c.nat}`);
    const h = c.hsrp;
    if (h && h.vip) {
      out.push(` standby ${h.group} ip ${h.vip}`);
      if (+h.priority && +h.priority !== 100) out.push(` standby ${h.group} priority ${h.priority}`);
      if (h.preempt) out.push(` standby ${h.group} preempt`);
    }
    out.push(...ipv6Lines(c, d));
    return out;
  }

  function ipv6Lines(c, d) {
    const out = [];
    if (c.ip6) out.push(` ipv6 address ${c.ip6}`);
    if (c.ip6 && c.ospf3 !== undefined && c.ospf3 !== '' && d && d.routing.ospf3.enabled) out.push(` ipv6 ospf ${d.routing.ospf3.pid} area ${c.ospf3}`);
    return out;
  }

  // Port security and snooping trust on a switchport.
  function securityLines(l, c) {
    const out = [];
    const ps = c.portSec;
    if (ps && l.mode === 'access') {
      out.push(' switchport port-security');
      if (+ps.max > 1) out.push(` switchport port-security maximum ${ps.max}`);
      if (ps.sticky) out.push(' switchport port-security mac-address sticky');
      if (ps.violation && ps.violation !== 'shutdown') out.push(` switchport port-security violation ${ps.violation}`);
    }
    if (c.trust) out.push(' ip dhcp snooping trust');
    return out;
  }

  function ipLine(c) {
    return c.ip && c.mask ? ` ip address ${c.ip} ${c.mask}` : null;
  }

  function subifLines(ifName, c, d) {
    const out = [];
    c.subifs.slice().sort((a, b) => a.num - b.num).forEach((s) => {
      out.push(`interface ${ifName}.${s.num}`);
      if (s.desc) out.push(` description ${s.desc}`);
      out.push(` encapsulation dot1Q ${s.vlan}${s.native ? ' native' : ''}`);
      if (s.ip && s.mask) out.push(` ip address ${s.ip} ${s.mask}`);
      out.push(...aclLines(s, d));
    });
    return out;
  }

  // Routed side of a link: router interface, routed switchport, or Port-channel.
  function routedLines(d, ifName, c, desc) {
    const out = [`interface ${ifName}`];
    if (c.desc || desc) out.push(` description ${c.desc || desc}`);
    if (M.isL3Switch(d)) out.push(' no switchport');
    const ip = ipLine(c);
    if (ip) out.push(ip);
    else if (c.subifs.length) out.push(' no ip address');
    out.push(...aclLines(c, d));
    out.push(c.shutdown ? ' shutdown' : ' no shutdown');
    out.push(...subifLines(ifName, c, d));
    return out;
  }

  function linkLines(p, d, l) {
    const s = M.side(l, d.id);
    const name = M.endIf(l, d.id);
    const cfg = M.port(d, name);
    const auto = peerDesc(p, d, l);
    const l3 = M.isL3End(p, l, d.id);
    const out = [];
    if (!l.ec) {
      if (l3) return routedLines(d, name, cfg, auto);
      out.push(`interface ${name}`, ` description ${cfg.desc || auto}`, ...switchportLines(p, d, l), ...securityLines(l, cfg));
      const peer = M.dev(p, M.peerOf(l, d.id));
      if (l.mode === 'access' && M.isHost(peer) && p.settings.portfastHosts) {
        out.push(' spanning-tree portfast', ' spanning-tree bpduguard enable');
      }
      out.push(cfg.shutdown ? ' shutdown' : ' no shutdown');
      return out;
    }
    // The Port-channel comes first so members join a bundle that already has its settings.
    const mode = ecMode(l, s);
    const group = s === 'a' ? l.ec.groupA : l.ec.groupB;
    // ISR G2 routers take a bare "channel-group N"; they have no mode keyword.
    const staticOnly = M.isRouter(d) && !MODELS[d.model].ec.includes('lacp');
    const channel = staticOnly ? ` channel-group ${group}` : ` channel-group ${group} mode ${mode}`;
    if (l3) {
      out.push(...routedLines(d, name, cfg, auto));
    } else {
      out.push(`interface ${name}`, ` description ${cfg.desc || auto}`, ...switchportLines(p, d, l), ...securityLines(l, cfg), cfg.shutdown ? ' shutdown' : ' no shutdown');
    }
    l.members.forEach((m) => {
      out.push(`interface ${m[s]}`, ` description Member of ${shortName(name)} ${auto.toLowerCase()}`);
      if (l3) {
        if (M.isL3Switch(d)) out.push(' no switchport');
        out.push(' no ip address');
      } else {
        out.push(...switchportLines(p, d, l));
      }
      out.push(channel, ' no shutdown');
    });
    return out;
  }

  // Compresses ports into "interface range" commands, at most 5 ranges per command as IOS allows.
  function rangeCommands(ports) {
    const groups = [];
    ports.slice().sort(naturalCompare).forEach((n) => {
      const m = /^(.*\/)(\d+)$/.exec(n);
      const prev = groups[groups.length - 1];
      if (m && prev && prev.base === m[1] && prev.end === +m[2] - 1) prev.end = +m[2];
      else groups.push({ base: m ? m[1] : n, start: m ? +m[2] : null, end: m ? +m[2] : null });
    });
    const items = groups.map((g) => (g.start === null ? g.base : g.start === g.end ? `${g.base}${g.start}` : `${g.base}${g.start} - ${g.end}`));
    const out = [];
    for (let i = 0; i < items.length; i += 5) out.push(`interface range ${items.slice(i, i + 5).join(' , ')}`);
    return out;
  }

  // " eq 80" or " range 1024 2000"; empty when the port box is blank, which matches any port.
  function portClause(op, a, b) {
    const lo = String(a === undefined || a === null ? '' : a).trim();
    if (!op || op === 'any' || !lo) return '';
    if (op === 'range') return ` range ${lo} ${String(b || '').trim()}`;
    return ` ${op} ${lo}`;
  }

  function aclCommands(d) {
    const out = [];
    d.acls.forEach((a) => {
      const numbered = /^\d+$/.test(a.name);
      const std = a.type === 'standard';
      const lines = a.rules.map((r) => {
        if (r.remark !== undefined) return `remark ${r.remark}`;
        const src = (N.parseAclAddr(r.src) || { text: r.src }).text;
        const log = r.log ? ' log' : '';
        if (std) return `${r.action} ${src}${log}`;
        const dst = (N.parseAclAddr(r.dst) || { text: r.dst }).text;
        const ports = r.proto === 'tcp' || r.proto === 'udp';
        let s = `${r.action} ${r.proto} ${src}${ports ? portClause(r.srcOp, r.srcPort, r.srcPort2) : ''} ${dst}`;
        if (ports) s += portClause(r.op, r.port, r.port2);
        if (r.proto === 'tcp' && r.established) s += ' established';
        if (r.proto === 'icmp' && r.icmpType) s += ` ${r.icmpType}`;
        return s + log;
      });
      if (numbered) lines.forEach((x) => out.push(`access-list ${a.name} ${x}`));
      else {
        out.push(`ip access-list ${a.type} ${a.name}`);
        lines.forEach((x) => out.push(` ${x}`));
      }
    });
    return out;
  }

  function redistLines(list, target, r) {
    const out = [];
    (list || []).forEach((src) => {
      if (src === 'connected' || src === 'static') {
        out.push(` redistribute ${src}${target === 'ospf' ? ' subnets' : target === 'rip' ? ' metric 3' : ''}`);
      } else if (src === 'ospf' && r.ospf.enabled) {
        out.push(` redistribute ospf ${r.ospf.pid}${target === 'rip' ? ' metric 3' : ''}`);
      } else if (src === 'rip' && r.rip.enabled) {
        out.push(` redistribute rip${target === 'ospf' ? ' subnets' : ''}`);
      } else if (src === 'bgp' && r.bgp.enabled) {
        out.push(` redistribute bgp ${r.bgp.asn}${target === 'ospf' ? ' subnets' : target === 'rip' ? ' metric 3' : ''}`);
      }
    });
    return out;
  }

  function routingLines(o, d) {
    const r = d.routing;
    if (r.static.length) {
      o.section('Static routes', 'Destination, mask, then the next-hop address or exit interface.');
      r.static.forEach((s) => {
        const ad = s.ad && +s.ad !== 1 ? ` ${s.ad}` : '';
        o.add(`ip route ${s.net} ${s.mask} ${s.via}${ad}`);
      });
    }
    if (r.ospf.enabled) {
      o.section('OSPF', 'Network statements match interfaces by wildcard, then place them in an area.');
      o.add(`router ospf ${r.ospf.pid}`);
      if (r.ospf.routerId) o.add(` router-id ${r.ospf.routerId}`);
      r.ospf.networks.forEach((n) => o.add(` network ${n.net} ${n.wild} area ${n.area}`));
      r.ospf.passive.forEach((n) => o.add(` passive-interface ${n}`));
      o.add(...redistLines(r.ospf.redistribute, 'ospf', r));
      if (r.ospf.defaultOriginate) o.add(' default-information originate');
    }
    if (r.rip.enabled) {
      o.section('RIP', 'Version 2 sends subnet masks. "no auto-summary" stops it summarising at classful boundaries.');
      o.add('router rip', ' version 2', ' no auto-summary');
      r.rip.networks.forEach((n) => o.add(` network ${n}`));
      r.rip.passive.forEach((n) => o.add(` passive-interface ${n}`));
      o.add(...redistLines(r.rip.redistribute, 'rip', r));
      if (r.rip.defaultOriginate) o.add(' default-information originate');
    }
    if (r.bgp.enabled) {
      o.section('BGP', 'A "network" statement only advertises a prefix that exactly matches a route in the routing table.');
      o.add(`router bgp ${r.bgp.asn}`);
      if (r.bgp.routerId) o.add(` bgp router-id ${r.bgp.routerId}`);
      r.bgp.neighbors.forEach((n) => {
        o.add(` neighbor ${n.ip} remote-as ${n.remoteAs}`);
        if (n.desc) o.add(` neighbor ${n.ip} description ${n.desc}`);
        if (n.updateSource) o.add(` neighbor ${n.ip} update-source ${n.updateSource}`);
        if (n.nextHopSelf) o.add(` neighbor ${n.ip} next-hop-self`);
      });
      r.bgp.networks.forEach((n) => o.add(` network ${n.net} mask ${n.mask}`));
      o.add(...redistLines(r.bgp.redistribute, 'bgp', r));
    }
    if (r.static6.length) {
      o.section('IPv6 static routes', 'Prefix, then a next-hop address or exit interface. A link-local next hop also needs the exit interface.');
      r.static6.forEach((s) => o.add(`ipv6 route ${s.net} ${s.exit && /^fe80/i.test(s.via) ? `${s.exit} ` : ''}${s.via}${s.ad && +s.ad !== 1 ? ` ${s.ad}` : ''}`));
    }
    if (r.ospf3.enabled) {
      o.section('OSPFv3', 'Interfaces join OSPFv3 with "ipv6 ospf" rather than network statements.\nOSPFv3 still needs a 32-bit router ID. Without any IPv4 address, set one.');
      o.add(`ipv6 router ospf ${r.ospf3.pid}`);
      if (r.ospf3.routerId) o.add(` router-id ${r.ospf3.routerId}`);
    }
  }

  const usesIpv6 = (d) => [...Object.values(d.ports), ...Object.values(d.ports).flatMap((c) => c.subifs || []), ...d.svis, ...d.loopbacks].some((c) => c.ip6)
    || d.routing.static6.length > 0 || d.routing.ospf3.enabled;

  function natLines(o, d) {
    const n = d.nat;
    if (!n || (!n.pat && !n.statics.length)) return;
    o.section('NAT', 'Mark interfaces inside or outside, then say which inside addresses to translate.\n"overload" is PAT: many inside hosts share the outside address, told apart by port.');
    n.statics.forEach((s) => o.add(`ip nat inside source static ${s.local} ${s.global}`));
    if (n.pat && n.pat.acl && n.pat.iface) o.add(`ip nat inside source list ${n.pat.acl} interface ${n.pat.iface} overload`);
  }

  function hostText(p, d, opts) {
    const lines = hostLines4(p, d, opts);
    if (d.ip6Mode === 'slaac') {
      const h = opts.sim && opts.sim.v6 && opts.sim.v6.hosts[d.id];
      lines.push('IPv6             Automatic (SLAAC)');
      if (h && h.ok) lines.push(`# Expected address ${h.addr}/${h.len}, gateway ${h.gateway} (${h.router})`);
      else if (h) lines.push(`# No IPv6 address expected: ${h.reason}`);
    } else if (d.ip6Mode === 'static') {
      lines.push(`IPv6 address     ${(d.ports.Ethernet0 || {}).ip6 || '(not set)'}`, `IPv6 gateway     ${d.gateway6 || '(not set)'}`);
    }
    if (MODELS[d.model].kind === 'host' && d.loopbacks.length) lines.push(`# Also answers for ${d.loopbacks.filter((x) => x.ip).map((x) => x.ip).join(', ')}`);
    return lines.join('\n');
  }

  function hostLines4(p, d, opts) {
    const c = d.ports.Ethernet0 || {};
    const lines = [`# ${d.name} (${MODELS[d.model].label})`, '# Set these in the operating system network settings.'];
    if (d.ipMode === 'dhcp') {
      lines.push('IP addressing    DHCP (obtain an address automatically)');
      const lease = opts.sim && opts.sim.leases[d.id];
      if (lease && lease.ok) {
        lines.push(`# Expected lease from ${lease.server}: ${lease.ip} ${lease.mask}, gateway ${lease.gateway || '(none)'}${lease.dns ? `, DNS ${lease.dns}` : ''}`);
      } else if (lease) lines.push(`# No lease expected: ${lease.reason}`);
      return lines;
    }
    lines.push(`IP address       ${c.ip || '(not set)'}`, `Subnet mask      ${c.mask || '(not set)'}`, `Default gateway  ${d.gateway || '(not set)'}`);
    if (d.dns) lines.push(`DNS server       ${d.dns}`);
    return lines;
  }

  function dhcpLines(o, d) {
    const x = d.dhcp;
    if (!x.pools.length && !x.excluded.length) return;
    o.section('DHCP server', 'Exclude the addresses kept for gateways and servers first, then define one pool per subnet.\nThe router hands out addresses from the pool whose network matches the interface the request arrived on.');
    x.excluded.forEach((e) => o.add(`ip dhcp excluded-address ${e.from}${e.to && e.to !== e.from ? ` ${e.to}` : ''}`));
    x.pools.forEach((pl) => {
      o.add(`ip dhcp pool ${pl.name}`);
      if (pl.network && pl.mask) o.add(` network ${pl.network} ${pl.mask}`);
      if (pl.gateway) o.add(` default-router ${pl.gateway}`);
      if (pl.dns) o.add(` dns-server ${pl.dns}`);
      if (pl.domain) o.add(` domain-name ${pl.domain}`);
    });
  }

  // Each feature names the top-level commands it owns and the interface lines that belong to it.
  // Filtering keeps a matching top-level block whole, and from any other block keeps the header,
  // its description and just the matching lines.
  const FEATURES = [
    { id: 'base', label: 'Base settings and remote access', top: /^(hostname|no ip domain-lookup|enable secret|service password|banner|ip domain-name|line |username|crypto key|ip ssh)/ },
    { id: 'vlans', label: 'VLANs and trunks', top: /^vlan \d/, child: /^ switchport (mode|access|trunk|nonegotiate)/ },
    { id: 'stp', label: 'Spanning tree', top: /^spanning-tree/, child: /^ spanning-tree/ },
    { id: 'etherchannel', label: 'EtherChannel', top: /^interface Port-channel/, child: /^ channel-group/ },
    { id: 'addressing', label: 'IP addressing', top: /^(interface (Loopback|Vlan)|interface \S+\.\d+$|ip routing$|ip default-gateway)/, child: /^ (ip address|no ip address|no switchport|encapsulation dot1Q)/ },
    { id: 'dhcp', label: 'DHCP', top: /^ip dhcp (?!snooping)/, child: /^ ip helper-address/ },
    { id: 'hsrp', label: 'HSRP', top: /(?!)/, child: /^ standby / },
    { id: 'nat', label: 'NAT', top: /^ip nat /, child: /^ ip nat / },
    { id: 'security', label: 'Port security and DHCP snooping', top: /^(no )?ip dhcp snooping/, child: /^ (switchport port-security|ip dhcp snooping)/ },
    { id: 'ipv6', label: 'IPv6', top: /^(ipv6 )/, child: /^ ipv6 / },
    { id: 'acl', label: 'Access lists', top: /^(access-list|ip access-list)/, child: /^ (ip access-group|access-class)/ },
    { id: 'routing', label: 'Routing (all)', top: /^(ip route |router |ip routing$)/ },
    { id: 'static', label: 'Static routes', top: /^ip route / },
    { id: 'ospf', label: 'OSPF', top: /^router ospf/ },
    { id: 'rip', label: 'RIP', top: /^router rip/ },
    { id: 'bgp', label: 'BGP', top: /^router bgp/ },
  ];
  const FRAME = new Set(['enable', 'configure terminal', 'end', 'write memory']);

  function filterConfig(text, featureId) {
    const f = FEATURES.find((x) => x.id === featureId);
    if (!f) return { text, empty: false };
    // Split into comment runs (section headings and notes) and command blocks.
    const items = [];
    text.split('\n').forEach((line) => {
      const last = items[items.length - 1];
      if (line.startsWith('!')) {
        if (last && last.type === 'comment') last.lines.push(line);
        else items.push({ type: 'comment', lines: [line] });
      } else if (line.startsWith(' ') && last && last.type === 'block') last.lines.push(line);
      else items.push({ type: FRAME.has(line) ? 'frame' : 'block', lines: [line] });
    });
    const keep = (b) => {
      const [head, ...kids] = b.lines;
      if (f.top.test(head)) return b.lines;
      if (!f.child || !head.startsWith('interface ')) return null;
      const hits = kids.filter((k) => f.child.test(k));
      if (!hits.length) return null;
      return [head, ...kids.filter((k) => k.startsWith(' description ')), ...hits];
    };
    const out = [];
    let pending = null;
    let found = false;
    items.forEach((it) => {
      if (it.type === 'comment') pending = it.lines;
      else if (it.type === 'frame') out.push(...it.lines);
      else {
        const kept = keep(it);
        if (!kept) return;
        if (pending) out.push(...pending);
        pending = null;
        found = true;
        out.push(...kept);
      }
    });
    return { text: out.join('\n'), empty: !found };
  }

  function generate(p, d, opts) {
    opts = { paste: true, notes: true, feature: 'all', ...opts };
    const text = generateFull(p, d, opts);
    if (opts.feature === 'all') return text;
    const f = FEATURES.find((x) => x.id === opts.feature);
    if (M.isHost(d)) {
      return opts.feature === 'addressing' || (opts.feature === 'dhcp' && d.ipMode === 'dhcp') ? text : `# ${d.name} has no ${f.label} settings.`;
    }
    const r = filterConfig(text, opts.feature);
    return r.empty ? `! ${d.name} has no ${f.label} configuration.` : r.text;
  }

  function generateFull(p, d, opts) {
    if (M.isHost(d)) return hostText(p, d, opts);
    const o = new Out(opts.notes);
    const s = p.settings;
    const sw = M.isSwitch(d);
    if (opts.paste) o.add('enable', 'configure terminal');
    o.section('Base settings', 'Hostname, passwords and the login banner.');
    o.add(`hostname ${d.name}`, 'no ip domain-lookup');
    if (s.enableSecret) o.add(`enable secret ${s.enableSecret}`);
    o.add('service password-encryption');
    if (s.banner) o.add(`banner motd #${s.banner.replace(/#/g, '')}#`);
    if (s.domainName) o.add(`ip domain-name ${s.domainName}`);

    if (M.isL3Switch(d)) {
      o.section('Layer 3 switching', 'Multilayer switches only route between VLANs once "ip routing" is on.');
      o.add('ip routing');
    }

    if (sw) {
      const vlans = M.vlansOnSwitch(p, d);
      if (vlans.length) {
        o.section('VLANs', 'A trunk drops a VLAN the switch does not know, so VLANs that only pass through are listed too.');
        vlans.forEach((id) => {
          const v = p.vlans.find((x) => x.id === id);
          o.add(`vlan ${id}`);
          if (v && v.name) o.add(` name ${v.name}`);
        });
      }
      o.section('Spanning tree', 'Rapid PVST+ converges in seconds rather than the 50 of classic STP.\nThe lowest bridge priority becomes root. Ties go to the lowest MAC address.');
      o.add('spanning-tree mode rapid-pvst');
      const byPrio = {};
      Object.entries((d.stp && d.stp.priority) || {}).forEach(([v, pr]) => {
        if (pr === '' || pr === undefined || +pr === 32768) return;
        (byPrio[pr] = byPrio[pr] || []).push(+v);
      });
      Object.keys(byPrio).sort((a, b) => a - b).forEach((pr) => o.add(`spanning-tree vlan ${N.compressList(byPrio[pr])} priority ${pr}`));
      const sn = d.snooping;
      if (sn && sn.on) {
        o.section('DHCP snooping', 'Only trusted ports may carry DHCP server replies. Trust the uplinks toward the real server.\nIOS DHCP servers drop the option 82 that snooping adds, so it is turned off.');
        if (sn.vlans) o.add(`ip dhcp snooping vlan ${N.compressList(N.expandList(sn.vlans))}`);
        o.add('no ip dhcp snooping information option', 'ip dhcp snooping');
      }
    }

    const acl = aclCommands(d);
    if (acl.length) {
      o.section('Access lists', 'Every list ends with an implicit "deny any". Define them before applying them to an interface.');
      o.add(...acl);
    }

    if (M.canRoute(d)) dhcpLines(o, d);
    if (M.canRoute(d) && usesIpv6(d)) {
      o.section('IPv6', 'Routers only forward IPv6 and send Router Advertisements once unicast routing is on.');
      o.add('ipv6 unicast-routing');
    }

    const links = M.linksOf(p, d.id).slice().sort((a, b) => naturalCompare(M.endIf(a, d.id), M.endIf(b, d.id)));
    if (links.length) {
      o.section('Connected interfaces', sw ? 'Access ports carry one VLAN. Trunks carry many, tagged with 802.1Q.' : 'Router interfaces are shut down by default, so each one needs "no shutdown".');
      links.forEach((l) => o.add(...linkLines(p, d, l)));
    }

    // Interfaces that have settings but no cable yet.
    const linked = new Set(links.map((l) => M.endIf(l, d.id)));
    links.forEach((l) => l.members.forEach((m) => linked.add(m[M.side(l, d.id)])));
    const loose = Object.keys(d.ports).filter((n) => !linked.has(n) && (d.ports[n].ip || d.ports[n].subifs.length)).sort(naturalCompare);
    if (loose.length) {
      o.section('Unconnected interfaces');
      loose.forEach((n) => o.add(...routedLines(d, n, d.ports[n], '')));
    }

    if (d.loopbacks.length) {
      o.section('Loopbacks', 'A loopback is always up, which makes it a stable router ID and BGP peering address.');
      d.loopbacks.forEach((lo) => {
        o.add(`interface Loopback${lo.num}`);
        if (lo.desc) o.add(` description ${lo.desc}`);
        if (lo.ip && lo.mask) o.add(` ip address ${lo.ip} ${lo.mask}`);
        o.add(...ipv6Lines(lo, d));
      });
    }

    if (d.svis.length) {
      o.section('Switch virtual interfaces', M.isL3Switch(d) ? 'Each SVI is the default gateway for its VLAN.' : 'A Layer 2 switch uses an SVI for management only.');
      d.svis.slice().sort((a, b) => a.vlan - b.vlan).forEach((v) => {
        o.add(`interface Vlan${v.vlan}`);
        const name = (p.vlans.find((x) => x.id === v.vlan) || {}).name;
        if (v.desc || name) o.add(` description ${v.desc || name}`);
        if (v.ip && v.mask) o.add(` ip address ${v.ip} ${v.mask}`);
        o.add(...aclLines(v, d), v.shutdown ? ' shutdown' : ' no shutdown');
      });
    }

    if (sw && !M.isL3Switch(d) && d.gateway) {
      o.section('Management gateway', 'A Layer 2 switch needs this to answer from outside its own subnet.');
      o.add(`ip default-gateway ${d.gateway}`);
    }

    if (s.shutUnused && sw) {
      const unused = M.freePorts(p, d);
      if (unused.length) {
        o.section('Unused ports', 'Shutting spare ports stops anyone plugging in unnoticed.');
        rangeCommands(unused).forEach((cmd) => o.add(cmd, ' shutdown'));
      }
    }

    if (M.canRoute(d)) routingLines(o, d);
    if (M.canRoute(d)) natLines(o, d);

    o.section('Console and remote access');
    o.add('line console 0');
    if (s.consolePassword) o.add(` password ${s.consolePassword}`, ' login');
    o.add(' logging synchronous');
    if (s.ssh && s.domainName) {
      o.add(`username admin secret ${s.vtyPassword || 'cisco'}`, 'crypto key generate rsa modulus 2048', 'ip ssh version 2');
      o.add('line vty 0 4', ' login local', ' transport input ssh');
    } else {
      o.add('line vty 0 4');
      if (s.vtyPassword) o.add(` password ${s.vtyPassword}`, ' login');
    }
    if (d.vtyAcl) o.add(` access-class ${d.vtyAcl} in`);
    if (opts.paste) o.add('end', 'write memory');
    return o.lines.join('\n');
  }

  // With a feature filter, devices that have nothing for that feature are left out.
  function generateAll(p, opts) {
    const feature = (opts && opts.feature) || 'all';
    const parts = p.devices.map((d) => [d, generate(p, d, opts)])
      .filter(([, t]) => feature === 'all' || !/^[!#] \S+ has no /.test(t));
    if (!parts.length) return `! No device has ${FEATURES.find((x) => x.id === feature).label} configuration yet.`;
    return parts.map(([d, t]) => `!!! ${d.name} !!!\n${t}`).join('\n\n');
  }

  PL.configgen = { generate, generateAll, rangeCommands, filterConfig, FEATURES };
})(typeof window !== 'undefined' ? (window.PL = window.PL || {}) : (globalThis.PL = globalThis.PL || {}));
