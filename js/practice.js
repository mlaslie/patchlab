// CLI lab: students type IOS commands into simulated consoles, and their devices are scored
// against the end-to-end reachability of the lab as designed. The designed lab is the answer
// key; the student's lab is the same cabling with only what they typed. No DOM.
(function (PL) {
  'use strict';

  const { MODELS, shortName, naturalCompare } = PL.catalog;
  const N = PL.net;
  const M = PL.model;
  const C = PL.configgen;
  const S = PL.simulate;
  const IMP = PL.importer;

  // ---------- Words and abbreviations ----------

  // What may come first in each mode, which is how IOS resolves "sh" to show or shutdown.
  const FIRST = {
    user: ['enable', 'exit', 'logout', 'ping', 'show', 'terminal', 'traceroute'],
    priv: ['clear', 'clock', 'configure', 'copy', 'disable', 'end', 'erase', 'exit', 'logout', 'ping', 'reload', 'show', 'terminal', 'traceroute', 'write'],
    config: ['access-list', 'banner', 'default', 'do', 'enable', 'end', 'exit', 'hostname', 'interface', 'ip', 'ipv6', 'line', 'no', 'router', 'service', 'spanning-tree', 'username', 'vlan', 'crypto'],
    'config-if': ['channel-group', 'description', 'do', 'encapsulation', 'end', 'exit', 'interface', 'ip', 'ipv6', 'no', 'shutdown', 'spanning-tree', 'standby', 'switchport', 'speed', 'duplex'],
    'config-subif': ['description', 'do', 'encapsulation', 'end', 'exit', 'interface', 'ip', 'ipv6', 'no', 'shutdown', 'standby'],
    'config-router': ['auto-summary', 'bgp', 'default-information', 'do', 'end', 'exit', 'neighbor', 'network', 'no', 'passive-interface', 'redistribute', 'router-id', 'version'],
    'config-rtr': ['do', 'end', 'exit', 'no', 'router-id'],
    'config-vlan': ['do', 'end', 'exit', 'name', 'no'],
    'dhcp-config': ['default-router', 'dns-server', 'do', 'domain-name', 'end', 'exit', 'network', 'no'],
    'config-std-nacl': ['deny', 'do', 'end', 'exit', 'no', 'permit', 'remark'],
    'config-ext-nacl': ['deny', 'do', 'end', 'exit', 'no', 'permit', 'remark'],
    'config-line': ['do', 'end', 'exec-timeout', 'exit', 'logging', 'login', 'no', 'password', 'transport'],
  };

  // The words allowed after a given phrase. Anything not listed is taken as typed (names,
  // numbers, addresses).
  const NEXT = {
    configure: ['terminal'], write: ['erase', 'memory', 'terminal'], copy: ['running-config', 'startup-config'], erase: ['startup-config'],
    show: ['access-lists', 'arp', 'cdp', 'clock', 'etherchannel', 'history', 'interfaces', 'ip', 'ipv6', 'mac', 'port-security', 'running-config', 'spanning-tree', 'standby', 'startup-config', 'version', 'vlan'],
    'show cdp': ['neighbors'], 'show mac': ['address-table'],
    'show mac address-table': ['address', 'aging-time', 'count', 'dynamic', 'interface', 'static', 'vlan'],
    'show mac address-table dynamic': ['address', 'interface', 'vlan'], 'show mac address-table static': ['address', 'interface', 'vlan'],
    'show mac address-table interface *': ['vlan'], 'show mac address-table dynamic interface *': ['vlan'], 'show port-security': ['address', 'interface'],
    'show interfaces *': ['switchport'], 'show ip ospf interface': ['brief'],
    clear: ['arp-cache', 'counters', 'ip', 'mac'], 'clear mac': ['address-table'], 'clear mac address-table': ['dynamic'], 'clear ip': ['ospf'], 'clear ip ospf': ['process'], 'show running-config': ['interface'],
    terminal: ['history', 'length', 'monitor', 'width'], 'terminal history': ['size'], default: ['interface'],
    'config interface': ['range'], 'if interface': ['range'],
    'show ip': ['access-lists', 'arp', 'bgp', 'dhcp', 'interface', 'nat', 'ospf', 'protocols', 'route'],
    'show ip interface': ['brief'], 'show ip ospf': ['neighbor', 'interface'], 'show ip dhcp': ['binding', 'pool', 'snooping'],
    'show ip nat': ['translations'], 'show ip bgp': ['summary'], 'show vlan': ['brief', 'id'], 'show interfaces': ['description', 'status', 'trunk'],
    'show etherchannel': ['summary'], 'show standby': ['brief'], 'show ipv6': ['interface', 'route', 'ospf'], 'show ipv6 interface': ['brief'],
    'show ipv6 ospf': ['neighbor'], 'show spanning-tree': ['vlan', 'summary'],
    'config ip': ['access-list', 'default-gateway', 'dhcp', 'domain-lookup', 'domain-name', 'http', 'nat', 'route', 'routing', 'ssh'],
    'if ip': ['access-group', 'address', 'dhcp', 'helper-address', 'nat', 'ospf'],
    'ip dhcp': ['excluded-address', 'pool', 'snooping'], 'ip access-list': ['extended', 'standard'], 'ip nat': ['inside', 'outside'],
    'ip nat inside': ['source'], 'ip nat inside source': ['list', 'static'], 'ip address': ['dhcp'],
    'config ipv6': ['route', 'router', 'unicast-routing'], 'if ipv6': ['address', 'enable', 'ospf'], 'ipv6 router': ['ospf'],
    router: ['bgp', 'ospf', 'rip'], switchport: ['access', 'mode', 'nonegotiate', 'port-security', 'trunk'],
    'switchport mode': ['access', 'dynamic', 'trunk'], 'switchport access': ['vlan'], 'switchport trunk': ['allowed', 'encapsulation', 'native'],
    'switchport trunk native': ['vlan'], 'switchport trunk allowed': ['vlan'], 'switchport trunk encapsulation': ['dot1q'],
    'switchport port-security': ['mac-address', 'maximum', 'violation'], 'switchport port-security violation': ['protect', 'restrict', 'shutdown'],
    encapsulation: ['dot1Q'], 'spanning-tree': ['bpduguard', 'mode', 'portfast', 'vlan'], 'spanning-tree mode': ['pvst', 'rapid-pvst'],
    'default-information': ['originate'], 'enable': ['password', 'secret'], 'service': ['password-encryption'],
    line: ['console', 'vty'], transport: ['input'], 'transport input': ['all', 'none', 'ssh', 'telnet'], logging: ['synchronous'],
    redistribute: ['bgp', 'connected', 'ospf', 'rip', 'static'], 'passive-interface': [], interface: [],
    'copy running-config': ['startup-config'], 'copy startup-config': ['running-config'], 'show ip route': ['bgp', 'connected', 'ospf', 'rip', 'static'],
    'if ip dhcp snooping': ['limit', 'trust'], 'config ip dhcp snooping': ['information', 'vlan'], 'switchport port-security mac-address': ['sticky'], login: ['local'],
    // After a number or name, written as *: "access-list 10 permit", "standby 1 priority".
    'access-list *': ['deny', 'permit', 'remark'], 'standby *': ['ip', 'preempt', 'priority', 'track'],
    'channel-group *': ['mode'], 'channel-group * mode': ['active', 'auto', 'desirable', 'on', 'passive'],
    'network *': ['mask'], 'network * *': ['area'], 'ipv6 ospf *': ['area'], 'ip access-group *': ['in', 'out'],
    'ip nat inside source list *': ['interface', 'pool'], 'ip nat inside source list * interface *': ['overload'], 'ip nat inside source list * pool *': ['overload'],
    'spanning-tree vlan *': ['priority', 'root'], 'spanning-tree vlan * root': ['primary', 'secondary'],
    'neighbor *': ['default-originate', 'next-hop-self', 'remote-as', 'update-source'],
  };

  // Every keyword above. Any other word in a phrase is a value and matches * in NEXT.
  const VOCAB = new Set([...Object.values(FIRST), ...Object.values(NEXT)].flat());
  const shape = (prev) => prev.map((w) => (VOCAB.has(w) ? w : '*')).join(' ');

  // Words that take nothing after them, so "ip ro 0.0.0.0 ..." means route, not routing.
  const NO_ARGS = new Set(['routing', 'unicast-routing', 'domain-lookup', 'nonegotiate', 'portfast', 'preempt']);

  // The keywords allowed after `prev` (already expanded, without a leading "no"), or null
  // when the next word is a value.
  function choices(mode, prev) {
    if (!prev.length) return FIRST[mode] || [];
    const scope = mode === 'config-if' || mode === 'config-subif' ? 'if' : 'config';
    const phrase = prev.join(' ');
    const sh = shape(prev);
    return NEXT[`${scope} ${phrase}`] || NEXT[phrase] || NEXT[`${scope} ${sh}`] || NEXT[sh] || null;
  }

  const startsWith = (list, w) => (list || []).filter((x) => x.toLowerCase().startsWith(w.toLowerCase()));

  // Settles an abbreviation that fits more than one keyword the way a student means it: by
  // the word after it ("log sync" is logging synchronous), then by which takes arguments.
  function settle(mode, prev, hits, next) {
    if (!next) return null;
    const fit = hits.filter((h) => startsWith(choices(mode, [...prev, h]), next).length);
    if (fit.length === 1) return fit[0];
    const args = hits.filter((h) => !NO_ARGS.has(h));
    return args.length === 1 ? args[0] : null;
  }

  // Real IOS commands outside what PatchLab models: accepted as valid but not applied.
  const NOT_SIMULATED = /^(no )?(snmp-server|ntp|logging|cdp|clock|lldp|vtp|aaa|archive|errdisable|mls|power|boot|license|monitor|privilege|alias|key|track|object-group|class-map|policy-map|ip sla|ip ftp|ip tftp|ip scp|ip name-server|security|login|memory|vrf|udld|storm-control|speed|duplex|mdix|cdp|lldp|keepalive|bandwidth|delay|mtu|ip mtu|ip ospf|ip split-horizon|ip summary-address|ip rip|ip pim|ip igmp|ip verify|ip arp|arp|mac|exec-timeout)\b/i;

  const IF_WORDS = new Set(['interface', 'interfaces', 'passive-interface', 'update-source', 'range']);

  // Interface range mode takes the same commands as one interface.
  const base = (mode) => (mode === 'config-if-range' ? 'config-if' : mode);

  // Expands IOS abbreviations: "conf t", "int g0/1", "sh ip int br", "no shut".
  function expand(mode, line) {
    mode = base(mode);
    const words = line.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return { line: '' };
    const out = [];
    let negate = false;
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const lw = w.toLowerCase();
      const prev = out.slice(negate ? 1 : 0);
      const list = !prev.length && mode === 'priv' && negate ? [] : choices(mode, prev);
      if (i === 0 && lw === 'no' && mode !== 'user' && mode !== 'priv') {
        out.push('no');
        negate = true;
        continue;
      }
      if (prev.length && IF_WORDS.has(prev[prev.length - 1]) && /\d/.test(w)) {
        out.push(IMP.ifName(w));
        continue;
      }
      if (prev.length >= 2 && /^interfaces?$/.test(prev[prev.length - 1]) && /^[a-z-]+$/i.test(w) && words[i + 1] && /^\d/.test(words[i + 1])) {
        out.push(IMP.ifName(w + words[i + 1]));
        i++;
        continue;
      }
      if (!list || !list.length) {
        out.push(w);
        continue;
      }
      const exact = list.find((x) => x.toLowerCase() === lw);
      const hits = exact ? [exact] : startsWith(list, lw);
      const pick = hits.length === 1 ? hits[0] : hits.length > 1 ? settle(mode, prev, hits, words[i + 1]) : null;
      if (pick) out.push(pick);
      else if (hits.length > 1) return { error: `% Ambiguous command:  "${line.trim()}"` };
      else if (!prev.length) return { error: invalid(line, w) };
      else out.push(w);
    }
    // "interface g0/1" style names after the first word.
    if (out[0] === 'interface' || (['no', 'default'].includes(out[0]) && out[1] === 'interface')) {
      const at = out[0] === 'interface' ? 1 : 2;
      if (out[at] === 'range') {
        const items = rangeItems(out.slice(at + 1).join(' '));
        if (!items) return { error: '% Invalid input: write a range as interface range fa0/1 - 4, g0/1' };
        out.splice(at + 1, out.length, items.map((x) => (x.to ? `${x.from} - ${x.to}` : x.from)).join(' , '));
      } else if (out[at]) out.splice(at, out.length - at, IMP.ifName(out.slice(at).join('')));
    }
    return { line: out.join(' ') };
  }

  // "fa0/1 - 4, g0/1" as [{ from: 'FastEthernet0/1', to: '4' }, { from: 'GigabitEthernet0/1' }].
  function rangeItems(text) {
    const parts = text.split(',').map((x) => x.replace(/\s+/g, '')).filter(Boolean);
    const items = parts.map((x) => {
      const m = /^([A-Za-z-]+[\d/]*?)(\d+)(?:-(\d+))?$/.exec(x);
      return m && { from: IMP.ifName(m[1] + m[2]), to: m[3] || '' };
    });
    return items.length && items.every(Boolean) ? items : null;
  }

  // Every interface a range names, in order.
  function rangeNames(text) {
    return text.split(' , ').flatMap((x) => {
      const [from, to] = x.split(' - ');
      if (!to) return [from];
      const m = /^(.*?)(\d+)$/.exec(from);
      const out = [];
      for (let i = +m[2]; i <= +to && out.length < 64; i++) out.push(m[1] + i);
      return out;
    });
  }

  function invalid(line, word) {
    const at = Math.max(0, line.indexOf(word));
    return `${' '.repeat(at)}^\n% Invalid input detected at '^' marker.`;
  }

  // ---------- Running configuration as blocks ----------

  const BLOCK = [
    [/^interface (\S+)$/, (m) => (m[1].includes('.') ? 'config-subif' : 'config-if')],
    [/^router (ospf|rip|bgp)\b/, () => 'config-router'],
    [/^ipv6 router ospf \d+$/, () => 'config-rtr'],
    [/^vlan \d+$/, () => 'config-vlan'],
    [/^ip dhcp pool \S+$/, () => 'dhcp-config'],
    [/^ip access-list standard \S+$/, () => 'config-std-nacl'],
    [/^ip access-list extended \S+$/, () => 'config-ext-nacl'],
    [/^line (console|vty)\b/, () => 'config-line'],
  ];
  const blockMode = (line) => {
    for (const [re, fn] of BLOCK) {
      const m = re.exec(line);
      if (m) return fn(m);
    }
    return null;
  };

  // Child lines that replace an earlier line of the same kind rather than adding another.
  function kidKey(line, mode) {
    const rules = [
      [/^(no )?shutdown$/, 'shutdown'], [/^(no )?switchport$/, 'switchport'], [/^ip address\b/, 'ip address'], [/^description\b/, 'description'],
      [/^switchport mode\b/, 'swmode'], [/^switchport access vlan\b/, 'swacc'], [/^switchport trunk native vlan\b/, 'swnat'],
      [/^switchport trunk allowed vlan\b/, 'swallow'], [/^switchport trunk encapsulation\b/, 'swenc'], [/^encapsulation\b/, 'encap'],
      [/^channel-group\b/, 'chan'], [/^ip nat (inside|outside)$/, 'nat'], [/^ip access-group \S+ in$/, 'aclin'], [/^ip access-group \S+ out$/, 'aclout'],
      [/^standby (\d+) ip\b/, 'sbip'], [/^standby (\d+) priority\b/, 'sbpri'], [/^switchport port-security maximum\b/, 'psmax'],
      [/^switchport port-security violation\b/, 'psvio'], [/^ipv6 address\b/, 'ip6'], [/^ipv6 ospf \d+ area\b/, 'o3'], [/^router-id\b/, 'rid'],
      [/^bgp router-id\b/, 'brid'], [/^name\b/, 'name'], [/^default-router\b/, 'dr'], [/^dns-server\b/, 'dns'], [/^domain-name\b/, 'dom'],
      [/^version\b/, 'ver'], [/^password\b/, 'pw'], [/^(no )?auto-summary$/, 'as'],
    ];
    if (mode === 'dhcp-config' && /^network\b/.test(line)) return 'net';
    const hit = rules.find(([re]) => re.test(line));
    if (!hit) return null;
    const m = /^standby (\d+)/.exec(line);
    return m ? `${hit[1]}${m[1]}` : hit[1];
  }

  const topKey = (line) => {
    if (/^hostname /.test(line)) return 'hostname';
    if (/^ip dhcp snooping vlan /.test(line)) return 'snvlan';
    if (/^enable secret /.test(line)) return 'secret';
    if (/^banner motd /.test(line)) return 'banner';
    const m = /^spanning-tree vlan (\S+) priority /.exec(line);
    if (m) return `stp${m[1]}`;
    if (/^spanning-tree mode /.test(line)) return 'stpmode';
    return null;
  };

  function serialize(blocks) {
    const lines = [];
    const where = [];
    blocks.forEach((b, bi) => {
      lines.push(b.head);
      where.push([bi, -1]);
      b.kids.forEach((k, ki) => {
        lines.push(` ${k}`);
        where.push([bi, ki]);
      });
    });
    return { text: lines.join('\n'), where };
  }

  const clone = (o) => JSON.parse(JSON.stringify(o));

  // Applies one expanded configuration line to the block list. Returns the new list and the
  // block now being edited, or an error.
  function applyLine(blocks, cur, mode, line) {
    const next = clone(blocks);
    let block = cur === null ? null : next[cur];
    const no = /^no /.test(line);
    const body = no ? line.slice(3) : line;
    const sub = block && mode !== 'config';
    if (!sub) {
      const bm = blockMode(body);
      if (bm) {
        let i = next.findIndex((b) => b.head === body);
        if (no) {
          if (i < 0) return { blocks: next, cur: null, mode: 'config' };
          next.splice(i, 1);
          return { blocks: next, cur: null, mode: 'config' };
        }
        if (i < 0) {
          next.push({ head: body, kids: [] });
          i = next.length - 1;
        }
        return { blocks: next, cur: i, mode: bm };
      }
      if (no) {
        const before = next.length;
        const kept = next.filter((b) => !(b.head === body || b.head.startsWith(`${body} `)));
        if (kept.length === before && /^access-list \d+$/.test(body)) return { blocks: next, cur: null, mode: 'config' };
        return { blocks: kept, cur: null, mode: 'config' };
      }
      const key = topKey(body);
      if (key) {
        const i = next.findIndex((b) => !b.kids.length && topKey(b.head) === key);
        if (i >= 0) next[i] = { head: body, kids: [] };
        else next.push({ head: body, kids: [] });
      } else if (!next.some((b) => b.head === body && !b.kids.length)) next.push({ head: body, kids: [] });
      return { blocks: next, cur: null, mode: 'config' };
    }
    // Inside a block.
    if (no) {
      if (body === 'shutdown') return setKid(next, cur, mode, 'no shutdown');
      if (body === 'switchport') return setKid(next, cur, mode, 'no switchport');
      if (body === 'auto-summary') return setKid(next, cur, mode, 'no auto-summary');
      const hit = block.kids.filter((k) => k === body || k.startsWith(`${body} `) || (body === 'ip address' && /^ip address/.test(k)));
      block.kids = block.kids.filter((k) => !hit.includes(k));
      return { blocks: next, cur, mode };
    }
    if (body === 'switchport' && mode.startsWith('config-if')) {
      block.kids = block.kids.filter((k) => k !== 'no switchport');
      return { blocks: next, cur, mode };
    }
    // "allowed vlan add 30" merges into the list already there.
    const add = /^switchport trunk allowed vlan (add|remove) (\S+)$/.exec(body);
    if (add) {
      const have = block.kids.find((k) => /^switchport trunk allowed vlan /.test(k));
      const list = have ? N.expandList(have.replace(/^switchport trunk allowed vlan /, '')) : [];
      const delta = N.expandList(add[2]);
      const merged = add[1] === 'add' ? [...list, ...delta] : list.filter((v) => !delta.includes(v));
      return setKid(next, cur, mode, `switchport trunk allowed vlan ${N.compressList(merged)}`);
    }
    return setKid(next, cur, mode, body);
  }

  function setKid(blocks, cur, mode, line) {
    const b = blocks[cur];
    const key = kidKey(line, mode);
    const i = key ? b.kids.findIndex((k) => kidKey(k, mode) === key) : b.kids.indexOf(line);
    if (i >= 0) b.kids[i] = line;
    else b.kids.push(line);
    return { blocks, cur, mode };
  }

  // ---------- Building the student's lab ----------

  const blank = () => ({ blocks: [], hostState: null });

  function deviceText(dev) {
    return serialize((dev && dev.blocks) || []).text;
  }

  function hasNoShut(blocks, head) {
    const b = blocks.find((x) => x.head === head);
    return !!b && b.kids.includes('no shutdown');
  }

  // The designed lab with every device reset to factory defaults, then given only what the
  // student typed. Cables stay; router interfaces and SVIs stay shut until "no shutdown".
  function buildStudent(target, practice) {
    const p = M.normalize(M.clone(target));
    const st = practice || { devices: {}, hosts: {} };
    p.vlans = [{ id: 1, name: 'default', subnet: '', mask: '' }];
    p.links.forEach((l) => {
      const a = M.dev(p, l.a);
      const b = M.dev(p, l.b);
      const modes = M.allowedModes(a, b);
      Object.assign(l, { mode: modes.includes('access') ? 'access' : modes[0], vlan: 1, nativeVlan: 1, allowed: 'all' });
    });
    p.devices.forEach((d) => {
      const keepMac = d.stp.mac;
      Object.assign(d, {
        ports: {}, svis: [], loopbacks: [], acls: [], gateway: '', dns: '', vtyAcl: '', routing: M.newRouting(), dhcp: M.newDhcp(),
        nat: { pat: null, statics: [] }, snooping: { on: false, vlans: '' }, stp: { priority: {}, mac: keepMac }, ipMode: 'static', ip6Mode: 'none', gateway6: '',
      });
      if (M.isHost(d) && d.model === 'internet') {
        const t = M.dev(target, d.id);
        d.loopbacks = M.clone(t.loopbacks);
      }
    });
    const notes = [];
    p.devices.forEach((d) => {
      if (M.isHost(d)) return applyHost(p, d, (st.hosts || {})[d.id]);
      const dev = (st.devices || {})[d.id];
      if (!dev || !dev.blocks.length) return;
      const name = d.name;
      IMP.apply(p, d, IMP.parse(deviceText(dev)));
      d.name = name;
    });
    // Defaults IOS applies that the importer does not know about.
    p.devices.forEach((d) => {
      if (M.isHost(d)) return;
      const blocks = ((st.devices || {})[d.id] || blank()).blocks;
      if (M.isRouter(d)) {
        MODELS[d.model].ports.forEach((n) => {
          if (!hasNoShut(blocks, `interface ${n}`)) M.port(d, n).shutdown = true;
        });
      }
      d.svis.forEach((s) => { if (!hasNoShut(blocks, `interface Vlan${s.vlan}`)) s.shutdown = true; });
      M.linksOf(p, d.id).filter((l) => l.ec).forEach((l) => {
        const side = M.side(l, d.id);
        const bundled = l.members.every((m) => (blocks.find((b) => b.head === `interface ${m[side]}`) || { kids: [] }).kids.some((k) => /^channel-group /.test(k)));
        if (!bundled) {
          M.port(d, M.endIf(l, d.id)).shutdown = true;
          notes.push(`${d.name}: the EtherChannel members have no channel-group, so the bundle to ${M.dev(p, M.peerOf(l, d.id)).name} is down.`);
        }
      });
      // An access port in a VLAN this switch never created is inactive.
      if (M.isSwitch(d)) {
        const made = new Set([1, ...blocks.map((b) => /^vlan (\d+)$/.exec(b.head)).filter(Boolean).map((m) => +m[1])]);
        M.linksOf(p, d.id).forEach((l) => {
          if (l.mode !== 'access' || M.isL3End(p, l, d.id) || made.has(l.vlan)) return;
          M.port(d, M.endIf(l, d.id)).shutdown = true;
          notes.push(`${d.name} ${shortName(M.endIf(l, d.id))} is in VLAN ${l.vlan}, which ${d.name} has not created, so the port is inactive.`);
        });
      }
    });
    p.practiceNotes = notes;
    return p;
  }

  function applyHost(p, d, h) {
    if (!h) return;
    d.ipMode = h.mode === 'dhcp' ? 'dhcp' : 'static';
    Object.assign(M.port(d, 'Ethernet0'), { ip: h.ip || '', mask: h.mask || '' });
    d.gateway = h.gateway || '';
    d.ip6Mode = h.ip6Mode || 'none';
    M.port(d, 'Ethernet0').ip6 = h.ip6 || '';
    d.gateway6 = h.gateway6 || '';
  }

  // ---------- Scoring ----------

  // Compares every host pair: should it reach, and does it?
  function score(target, student) {
    const want = S.matrix(S.simulate(target));
    const sim = S.simulate(student);
    const got = S.matrix(sim);
    const ids = want.hosts.map((h) => h.id);
    const cells = [];
    want.rows.forEach((row, i) => row.forEach((c, j) => {
      if (!c) return;
      const gi = got.hosts.findIndex((h) => h.id === ids[i]);
      const gj = got.hosts.findIndex((h) => h.id === ids[j]);
      const g = gi >= 0 && gj >= 0 ? got.rows[gi][gj] : { ok: false, reason: 'Not addressed yet.' };
      cells.push({ from: ids[i], to: ids[j], want: c.ok, got: g.ok, match: c.ok === g.ok, reason: g.reason || '' });
    }));
    const matched = cells.filter((x) => x.match).length;
    return { hosts: want.hosts, cells, matched, total: cells.length, done: cells.length > 0 && matched === cells.length, sim };
  }

  // ---------- Fixes: what to type to match the designed lab ----------

  function blocksOf(text) {
    const out = [];
    text.split('\n').forEach((line) => {
      if (!line || line.startsWith('!') || line.startsWith('#')) return;
      if (line.startsWith(' ') && out.length) out[out.length - 1].kids.push(line.slice(1));
      else out.push({ head: line, kids: [] });
    });
    return out;
  }

  const ignorable = (k) => /^description /.test(k);

  // Commands that turn the student's device into the designed one, as a student would type them.
  function fixCommands(target, student, devId, practice) {
    const t = M.dev(target, devId);
    const s = M.dev(student, devId);
    if (M.isHost(t)) return hostFix(t, s);
    const typed = practice && practice.devices[devId] && practice.devices[devId].blocks.find((b) => /^hostname /.test(b.head));
    const named = !practice || (typed && typed.head === `hostname ${t.name}`);
    const opts = { paste: false, notes: false };
    const want = blocksOf(C.generate(target, t, opts).replace(/^hostname .*$/m, `hostname ${t.name}`));
    const have = blocksOf(C.generate(student, s, opts).replace(/^hostname .*$/m, `hostname ${s.name}`));
    const out = [];
    want.forEach((w) => {
      const h = have.find((x) => x.head === w.head);
      if (!h) {
        if (!w.kids.length && have.some((x) => !x.kids.length && topKey(x.head) && topKey(x.head) === topKey(w.head))) out.push(w.head);
        else out.push(w.head, ...w.kids.filter((k) => !ignorable(k)).map((k) => ` ${k}`));
        return;
      }
      const missing = w.kids.filter((k) => !ignorable(k) && !h.kids.includes(k));
      const extra = h.kids.filter((k) => !ignorable(k) && !w.kids.includes(k) && !missing.some((m) => kidKey(m, '') && kidKey(m, '') === kidKey(k, '')));
      if (missing.length || extra.length) out.push(w.head, ...extra.map((k) => ` ${k.startsWith('no ') ? k.slice(3) : `no ${k}`}`), ...missing.map((k) => ` ${k}`));
    });
    have.forEach((h) => {
      if (want.some((w) => w.head === h.head)) return;
      if (/^interface /.test(h.head)) {
        const kids = h.kids.filter((k) => !ignorable(k) && k !== 'no shutdown');
        if (kids.length) out.push(h.head, ...kids.map((k) => ` no ${k}`));
      } else if (!topKey(h.head) && !/^(line |spanning-tree mode)/.test(h.head)) out.push(`no ${h.head}`);
    });
    if (!named) out.unshift(`hostname ${t.name}`);
    return out;
  }

  function hostFix(t, s) {
    const c = t.ports.Ethernet0 || {};
    const have = s.ports.Ethernet0 || {};
    if (t.ipMode === 'dhcp') return s.ipMode === 'dhcp' ? [] : ['ipconfig /dhcp'];
    if (c.ip === have.ip && c.mask === have.mask && t.gateway === s.gateway && s.ipMode !== 'dhcp') return [];
    return c.ip ? [`ipconfig ${c.ip} ${c.mask}${t.gateway ? ` ${t.gateway}` : ''}`] : [];
  }

  // ---------- The console ----------

  function prompt(name, mode, host) {
    if (host) return 'C:\\>';
    if (mode === 'user') return `${name}>`;
    if (mode === 'priv') return `${name}#`;
    return `${name}(${mode})#`;
  }

  // A device's typed hostname, or the factory "Router"/"Switch".
  function hostnameOf(practice, d) {
    const dev = practice.devices[d.id];
    const hn = dev && dev.blocks.find((b) => /^hostname /.test(b.head));
    return hn ? hn.head.slice(9) : M.isRouter(d) ? 'Router' : 'Switch';
  }

  // The prompt for a device: its typed hostname, or the factory "Router"/"Switch".
  function promptFor(ctx, devId) {
    const d = M.dev(ctx.target, devId);
    if (M.isHost(d)) return 'C:\\>';
    if (ctx.session.confirm) return '';
    return prompt(hostnameOf(ctx.practice, d), ctx.session.mode, false);
  }

  // Runs one line on a device. `ctx` carries the target and practice state plus the per-device
  // session ({ mode, cur }); the practice state is updated in place when configuration changes.
  function exec(ctx, devId, raw) {
    let m;
    const target = ctx.target;
    const d = M.dev(target, devId);
    const ses = ctx.session;
    const store = ctx.practice;
    if (M.isHost(d)) return hostExec(ctx, d, raw);
    store.devices[devId] = store.devices[devId] || blank();
    const dev = store.devices[devId];
    const line = raw.trim();
    // "[confirm]": Return or y goes ahead, anything else cancels.
    if (ses.confirm) {
      const what = ses.confirm;
      ses.confirm = null;
      if (line && !/^y/i.test(line)) return { out: '' };
      return confirmed(ctx, d, dev, what);
    }
    ses.started = ses.started || Date.now();
    if (!line) return { out: '' };
    ses.hist = [...(ses.hist || []), line].slice(-256);
    if (line.endsWith('?')) return { out: help(ses.mode, raw.trimStart(), d) };
    const mode = base(ses.mode);
    const cfgMode = mode !== 'user' && mode !== 'priv';
    // In a sub-mode, a global command drops back to global configuration first, as IOS does.
    let exp = expand(mode, line);
    if (cfgMode && mode !== 'config') {
      const words = exp.error ? [] : exp.line.replace(/^no /, '').split(' ');
      const local = !exp.error && FIRST[mode].includes(words[0]) && !blockMode(words.join(' '))
        && !(words[0] === 'ip' && !NEXT['if ip'].includes(words[1])) && !(words[0] === 'ipv6' && !NEXT['if ipv6'].includes(words[1]));
      if (!local) {
        const g = expand('config', line);
        if (!g.error && !['do', 'end', 'exit'].includes(g.line.split(' ')[0])) {
          exp = g;
          ses.mode = 'config';
          ses.cur = null;
          ses.range = null;
        }
      }
    }
    if (exp.error) return { out: cfgMode && NOT_SIMULATED.test(line) ? '% PatchLab does not simulate this command, so it was not applied.' : exp.error };
    const cmd = exp.line;

    if (cfgMode && /^do /.test(cmd)) {
      const inner = expand('priv', cmd.slice(3));
      if (inner.error) return { out: inner.error };
      if (/^(show|ping|traceroute|write terminal)\b/.test(inner.line)) return execShow(ctx, d, inner.line);
      return execPriv(ctx, d, dev, inner.line, cmd.slice(3));
    }
    if (cmd === 'end' && cfgMode) { ses.mode = 'priv'; ses.cur = null; ses.range = null; return { out: '' }; }
    if (cmd === 'exit') {
      if (mode === 'config') { ses.mode = 'priv'; return { out: '' }; }
      if (cfgMode) { ses.mode = 'config'; ses.cur = null; ses.range = null; return { out: '' }; }
      return logout(ses);
    }
    if (cmd === 'logout') return logout(ses);
    if (/^terminal\b/.test(cmd)) {
      const n = /^terminal history size (\d+)$/.exec(cmd);
      if (n) ses.histSize = Math.min(256, +n[1]);
      return { out: '' };
    }
    if (mode === 'user') {
      if (cmd === 'enable') { ses.mode = 'priv'; return { out: '' }; }
      if (/^(show|ping|traceroute)\b/.test(cmd)) return execShow(ctx, d, cmd);
      return { out: invalid(line, line.split(/\s+/)[0]) };
    }
    if (mode === 'priv') return execPriv(ctx, d, dev, cmd, line);
    if ((m = /^default interface (\S+)$/.exec(cmd))) {
      const check = validateInterface(target, d, `interface ${m[1]}`);
      if (check) return { out: check };
      dev.blocks = dev.blocks.filter((b) => b.head !== `interface ${m[1]}`);
      return { out: `Interface ${m[1]} set to default configuration`, changed: true };
    }
    if ((m = /^interface range (.+)$/.exec(cmd))) {
      const names = rangeNames(m[1]);
      for (const n of names) {
        const check = validateInterface(target, d, `interface ${n}`);
        if (check) return { out: check };
      }
      let blocks = dev.blocks;
      const at = names.map((n) => {
        const r = applyLine(blocks, null, 'config', `interface ${n}`);
        blocks = r.blocks;
        return r.cur;
      });
      dev.blocks = blocks;
      Object.assign(ses, { mode: 'config-if-range', cur: at[0], range: at });
      return { out: '', changed: true };
    }
    // In interface range mode each line goes to every interface in the range.
    const targets = ses.mode === 'config-if-range' && ses.range ? ses.range : [ses.cur];
    let blocks = dev.blocks;
    let res;
    for (const cur of targets) {
      res = applyChecked(target, d, blocks, cur, mode, cmd);
      if (res.out) return res;
      blocks = res.blocks;
    }
    dev.blocks = blocks;
    if (targets.length > 1 && res.mode === 'config-if') res.mode = 'config-if-range';
    if (res.mode !== 'config-if-range') ses.range = null;
    ses.mode = res.mode;
    ses.cur = res.cur;
    return { out: '', changed: true };
  }

  // Applies one configuration line, or says why it was not applied. The importer is the
  // arbiter of what PatchLab understands.
  function applyChecked(target, d, blocks, cur, mode, cmd) {
    const check = validateInterface(target, d, cmd);
    if (check) return { out: check };
    const res = applyLine(blocks, cur, mode, cmd);
    const ser = serialize(res.blocks);
    const parsed = IMP.parse(ser.text);
    const bad = parsed.skipped.find((x) => {
      const [bi, ki] = ser.where[x.n - 1];
      const b = res.blocks[bi];
      return (ki < 0 ? b.head : b.kids[ki]) === cmd.replace(/^no /, '') || (ki < 0 ? b.head : b.kids[ki]) === cmd;
    });
    if (bad) return { out: NOT_SIMULATED.test(cmd) ? '% PatchLab does not simulate this command, so it was not applied.' : '% Invalid input, or a command PatchLab does not simulate. Nothing was applied.' };
    return res;
  }

  function logout(ses) {
    Object.assign(ses, { mode: 'user', cur: null, range: null });
    return { out: '\n\nPress RETURN to get started.' };
  }

  // Privileged EXEC commands, also reached from configuration mode with "do".
  function execPriv(ctx, d, dev, cmd, line) {
    const ses = ctx.session;
    if (cmd === 'disable') { ses.mode = 'user'; return { out: '' }; }
    if (cmd === 'configure terminal' || cmd === 'configure') { ses.mode = 'config'; ses.cur = null; return { out: 'Enter configuration commands, one per line.  End with CNTL/Z.' }; }
    if (/^(write memory|write)$/.test(cmd)) return saveStartup(dev, 'Building configuration...\n[OK]');
    if (cmd === 'copy running-config startup-config') return saveStartup(dev, 'Destination filename [startup-config]? \nBuilding configuration...\n[OK]');
    if (cmd === 'copy startup-config running-config') {
      if (!dev.startup) return { out: '%Error opening nvram:/startup-config (No such file or directory)' };
      dev.blocks = clone(dev.startup);
      return { out: 'Destination filename [running-config]? \n[OK] (merged into the running configuration)', changed: true };
    }
    if (cmd === 'erase startup-config' || cmd === 'write erase') {
      ses.confirm = 'erase';
      return { out: 'Erasing the nvram filesystem will remove all configuration files! Continue? [confirm]' };
    }
    if (cmd === 'reload') {
      ses.confirm = 'reload';
      const unsaved = JSON.stringify(dev.blocks) !== JSON.stringify(dev.startup || []);
      return { out: `${unsaved ? 'System configuration has been modified. Unsaved changes are lost on reload; save first with copy run start.\n' : ''}Proceed with reload? [confirm]` };
    }
    if (/^clock set\b/.test(cmd)) return { out: '% PatchLab keeps the clock in step with your computer.' };
    // Tables here are rebuilt from the configuration each time, so a clear relearns at once.
    if (/^clear (mac address-table dynamic|arp-cache|counters|ip ospf process)\b/.test(cmd)) return { out: '' };
    if (/^(show|ping|traceroute|write terminal)\b/.test(cmd)) return execShow(ctx, d, cmd);
    return { out: invalid(line, line.trim().split(/\s+/)[0]) };
  }

  function saveStartup(dev, out) {
    dev.startup = clone(dev.blocks);
    return { out, changed: true };
  }

  function confirmed(ctx, d, dev, what) {
    const ses = ctx.session;
    if (what === 'erase') {
      dev.startup = null;
      return { out: '[OK]\nErase of nvram: complete', changed: true };
    }
    // A reload starts again from the saved configuration, or factory defaults without one.
    dev.blocks = clone(dev.startup || []);
    Object.assign(ses, { mode: 'user', cur: null, range: null, booted: Date.now() });
    return { out: `\nSystem Bootstrap, Version 15.2, RELEASE SOFTWARE\nBooting ${MODELS[d.model].label}...\n${dev.startup ? '' : '\n--- System Configuration Dialog ---\n(no startup-config: starting from factory defaults)\n'}\nPress RETURN to get started.`, changed: true };
  }

  function validateInterface(target, d, cmd) {
    const m = /^interface (\S+)$/.exec(cmd);
    if (!m) return '';
    const n = m[1];
    const ports = MODELS[d.model].ports;
    const base = n.split('.')[0];
    if (ports.includes(n)) return '';
    if (n.includes('.') && ports.includes(base)) return M.isRouter(d) ? '' : '% Sub-interfaces are for routers in PatchLab.';
    if (/^Loopback\d+$/.test(n) && M.canRoute(d)) return '';
    if (/^Vlan\d+$/.test(n) && M.isSwitch(d)) return '';
    if (/^Port-channel\d+$/.test(n)) return '';
    return `% Invalid interface. ${d.name} has ${shortName(ports[0])} to ${shortName(ports[ports.length - 1])}.`;
  }

  function hostExec(ctx, d, raw) {
    const store = ctx.practice;
    const h = store.hosts[d.id] = store.hosts[d.id] || { mode: 'static', ip: '', mask: '', gateway: '' };
    const line = raw.trim();
    const w = line.split(/\s+/);
    if (!line) return { out: '' };
    if (/^(help|\?)$/i.test(line)) return { out: 'ipconfig                       show the address\nipconfig <ip> <mask> [gateway] set a static address\nipconfig /dhcp                 get an address by DHCP\nipv6config auto                use SLAAC\nipv6config <addr/len> <gw>     set a static IPv6 address\nipconfig /all                  show the address, MAC and DNS\narp -a                         show the ARP cache\nping <address>\ntracert <address>' };
    if (/^ipconfig$/i.test(line)) {
      const sim = S.simulate(buildStudent(ctx.target, store));
      const lease = sim.leases[d.id];
      const v6 = sim.v6 && sim.v6.hosts[d.id];
      const four = h.mode === 'dhcp' ? (lease && lease.ok ? [lease.ip, lease.mask, lease.gateway] : ['0.0.0.0', '0.0.0.0', '0.0.0.0']) : [h.ip || '0.0.0.0', h.mask || '0.0.0.0', h.gateway || '0.0.0.0'];
      return { out: `FastEthernet0 Connection:${h.mode === 'dhcp' ? ' (DHCP)' : ''}\n   IPv6 Address....................: ${v6 && v6.ok ? v6.addr : '::'}\n   IPv4 Address....................: ${four[0]}\n   Subnet Mask.....................: ${four[1]}\n   Default Gateway.................: ${four[2]}${h.mode === 'dhcp' && lease && !lease.ok ? `\n\nDHCP request failed. ${lease.reason}` : ''}` };
    }
    if (/^ipconfig \/all$/i.test(line)) {
      const sim = S.simulate(buildStudent(ctx.target, store));
      const lease = sim.leases[d.id];
      const dhcp = h.mode === 'dhcp';
      const ok = !dhcp || (lease && lease.ok);
      const mac = ifMac(d.id, 'Ethernet0').replace(/\./g, '').toUpperCase().replace(/(..)(?!$)/g, '$1-');
      const v = dhcp ? lease || {} : h;
      return { out: ['FastEthernet0 Connection:', `   Physical Address................: ${mac}`, `   DHCP Enabled....................: ${dhcp ? 'Yes' : 'No'}`,
        `   IPv4 Address....................: ${ok ? v.ip || '0.0.0.0' : '0.0.0.0'}`, `   Subnet Mask.....................: ${ok ? v.mask || '0.0.0.0' : '0.0.0.0'}`,
        `   Default Gateway.................: ${ok ? v.gateway || '0.0.0.0' : '0.0.0.0'}`,
        `   DNS Servers.....................: ${(dhcp ? ok && lease.dns : h.dns) || '0.0.0.0'}`].join('\n') };
    }
    if (/^arp -a$/i.test(line)) {
      const sim = S.simulate(buildStudent(ctx.target, store));
      const rows = arpEntries(sim, d.id);
      const me = rows.find((r) => r.own);
      if (!me) return { out: 'No ARP Entries Found.' };
      const win = (mac) => mac.replace(/\./g, '').replace(/(..)(?!$)/g, '$1-');
      return { out: [`\nInterface: ${me.ip} --- 0x2`, '  Internet Address      Physical Address      Type',
        ...rows.filter((r) => !r.own).map((r) => `  ${r.ip.padEnd(22)}${win(r.mac).padEnd(22)}dynamic`)].join('\n') };
    }
    if (/^ipconfig \/(dhcp|renew)$/i.test(line)) {
      h.mode = 'dhcp';
      const sim = S.simulate(buildStudent(ctx.target, store));
      const lease = sim.leases[d.id];
      return { out: lease && lease.ok ? `DHCP request successful.\n   IP Address......................: ${lease.ip}\n   Default Gateway.................: ${lease.gateway}` : `DHCP request failed. ${lease ? lease.reason : ''}`, changed: true };
    }
    if (/^ipconfig\b/i.test(line)) {
      const [, ip, mask, gw] = w;
      const m = N.normalizeMask(mask);
      if (N.ip2n(ip) === null || !m || (gw && N.ip2n(gw) === null)) return { out: 'Usage: ipconfig <ip> <mask> [gateway], for example ipconfig 192.168.1.10 255.255.255.0 192.168.1.1' };
      Object.assign(h, { mode: 'static', ip, mask: m, gateway: gw || '' });
      return { out: '', changed: true };
    }
    if (/^ipv6config auto$/i.test(line)) { Object.assign(h, { ip6Mode: 'slaac' }); return { out: '', changed: true }; }
    if (/^ipv6config /i.test(line)) {
      if (!PL.ipv6.parsePrefix(w[1])) return { out: 'Usage: ipv6config <address/len> <gateway>' };
      Object.assign(h, { ip6Mode: 'static', ip6: w[1], gateway6: w[2] || '' });
      return { out: '', changed: true };
    }
    if (/^ping /i.test(line)) return execShow(ctx, d, `ping ${w[1]}`);
    if (/^tracert /i.test(line)) return execShow(ctx, d, `tracert ${w[1]}`);
    return { out: `Invalid Command. Type help for the list.` };
  }

  // ---------- show and ping ----------

  // "show run | include route": run the command, then filter its lines as IOS does.
  function execShow(ctx, d, cmd) {
    const pipe = /^(.*?)\s*\|\s*(i|in|inc|incl|include|e|ex|exclude|s|sec|section|b|be|begin|c|co|cou|coun|count)\w*\s+(.+)$/i.exec(cmd);
    if (!pipe) return execShowRaw(ctx, d, cmd);
    const res = execShowRaw(ctx, d, expand('priv', pipe[1]).line || pipe[1]);
    let re;
    try { re = new RegExp(pipe[3], 'i'); } catch (e) { re = new RegExp(pipe[3].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
    const lines = res.out.split('\n');
    const op = pipe[2][0].toLowerCase();
    let out;
    if (op === 'i') out = lines.filter((l) => re.test(l));
    else if (op === 'e') out = lines.filter((l) => !re.test(l));
    else if (op === 'b') out = lines.slice(Math.max(0, lines.findIndex((l) => re.test(l))));
    else if (op === 'c') out = [`Number of lines which match regexp = ${lines.filter((l) => re.test(l)).length}`];
    else {
      out = [];
      lines.forEach((l, i) => {
        if (/^\S/.test(l) && re.test(l)) {
          out.push(l);
          for (let j = i + 1; j < lines.length && /^ /.test(lines[j]); j++) out.push(lines[j]);
        }
      });
    }
    return { ...res, out: out.join('\n') };
  }

  function execShowRaw(ctx, d, cmd) {
    const student = buildStudent(ctx.target, ctx.practice);
    const sim = S.simulate(student);
    const sd = M.dev(student, d.id);
    let m;
    if ((m = /^ping (\S+)$/.exec(cmd))) {
      const v6 = m[1].includes(':');
      const r = v6 ? PL.ipv6.ping(sim, d.id, m[1]) : S.ping(sim, d.id, m[1]);
      const head = M.isHost(d) ? `Pinging ${m[1]} with 32 bytes of data:\n` : `Type escape sequence to abort.\nSending 5, 100-byte ICMP Echos to ${m[1]}, timeout is 2 seconds:\n`;
      if (M.isHost(d)) return { out: `${head}\n${r.ok ? [1, 2, 3, 4].map(() => `Reply from ${m[1]}: bytes=32 time<1ms TTL=${r.fwd.hops.length > 2 ? 254 : 255}`).join('\n') : 'Request timed out.\nRequest timed out.\nRequest timed out.\nRequest timed out.'}\n\nPing statistics for ${m[1]}:\n    Packets: Sent = 4, Received = ${r.ok ? 4 : 0}, Lost = ${r.ok ? 0 : 4} (${r.ok ? 0 : 100}% loss)${r.ok ? '' : `\n\n% PatchLab: ${r.reason}`}`, ping: r };
      return { out: `${head}${r.ok ? '!!!!!' : '.....'}\nSuccess rate is ${r.ok ? '100 percent (5/5), round-trip min/avg/max = 1/1/2 ms' : '0 percent (0/5)'}${r.ok ? '' : `\n% PatchLab: ${r.reason}`}`, ping: r };
    }
    if ((m = /^(?:traceroute|tracert) (\S+)$/.exec(cmd))) return { out: trace(sim, d, m[1]) };
    if (M.isHost(d)) return { out: 'Invalid Command.' };
    const mine = (ctx.practice.devices[d.id] || blank());
    if (cmd === 'show running-config' || cmd === 'write terminal') {
      const text = configText(ctx.practice, d, mine.blocks);
      return { out: `Building configuration...\n\nCurrent configuration : ${text.length} bytes\n${text}` };
    }
    if ((m = /^show running-config interface (\S+)$/.exec(cmd))) {
      const lines = configText(ctx.practice, d, mine.blocks).split('\n');
      const at = lines.indexOf(`interface ${m[1]}`);
      if (at < 0) return { out: invalid(cmd, cmd.split(' ').pop()) };
      let end = at + 1;
      while (end < lines.length && /^ /.test(lines[end])) end++;
      const sec = lines.slice(at, end).join('\n');
      return { out: `Building configuration...\n\nCurrent configuration : ${sec.length} bytes\n!\n${sec}\nend` };
    }
    if (cmd === 'show startup-config') {
      if (!mine.startup) return { out: 'startup-config is not present' };
      const text = configText(ctx.practice, d, mine.startup);
      return { out: `Using ${text.length} out of 262144 bytes\n${text}` };
    }
    if (cmd === 'show ip interface brief') {
      const rows = ['Interface              IP-Address      OK? Method Status                Protocol'];
      const sti = (name, c, up) => (c.shutdown ? 'administratively down' : up ? 'up' : 'down');
      const ifs = [];
      MODELS[sd.model].ports.forEach((n) => {
        const c = M.port(sd, n);
        const link = M.linkOnPort(student, sd.id, n);
        const up = !!link && S.linkIsUp(sim, link);
        ifs.push([n, c.ip || 'unassigned', sti(n, c, up), up && !c.shutdown ? 'up' : 'down']);
        (c.subifs || []).forEach((x) => ifs.push([`${n}.${x.num}`, x.ip || 'unassigned', sti(n, c, up), up && !c.shutdown ? 'up' : 'down']));
      });
      Object.keys(sd.ports).filter((n) => /^Port-channel/.test(n)).forEach((n) => ifs.push([n, sd.ports[n].ip || 'unassigned', 'up', 'up']));
      sd.svis.forEach((v) => {
        const i = (sim.byDev[sd.id] || []).find((x) => x.name === `Vlan${v.vlan}`);
        ifs.push([`Vlan${v.vlan}`, v.ip || 'unassigned', v.shutdown ? 'administratively down' : i && i.up ? 'up' : 'down', i && i.up ? 'up' : 'down']);
      });
      sd.loopbacks.forEach((l) => ifs.push([`Loopback${l.num}`, l.ip || 'unassigned', 'up', 'up']));
      ifs.sort((a, b) => naturalCompare(a[0], b[0])).forEach(([n, ip, st, pr]) => rows.push(`${n.padEnd(23)}${ip.padEnd(16)}YES manual ${st.padEnd(22)}${pr}`));
      return { out: rows.join('\n') };
    }
    if ((m = /^show ip route(?: (connected|static|ospf|rip|bgp))?$/.exec(cmd))) {
      if (!M.canRoute(sd)) return { out: 'Default gateway is ' + (sd.gateway || 'not set') };
      const only = { connected: /^[CL]/, static: /^S/, ospf: /^O/, rip: /^R/, bgp: /^B/ }[m[1]];
      const lines = S.showRoutes(sim, sd).filter((r) => !only || only.test(r.code));
      const def = lines.find((r) => r.len === 0);
      return { out: ['Codes: L - local, C - connected, S - static, R - RIP, O - OSPF, B - BGP', '', def ? `Gateway of last resort is ${def.nh || '0.0.0.0'} to network 0.0.0.0` : 'Gateway of last resort is not set', '',
        ...lines.map((r) => `${r.code.padEnd(5)}${r.text}`)].join('\n') };
    }
    if (cmd === 'show vlan brief' || cmd === 'show vlan') {
      if (!M.isSwitch(sd)) return { out: invalid(cmd, 'vlan') };
      const blocks = (ctx.practice.devices[d.id] || blank()).blocks;
      const made = [1, ...blocks.map((b) => /^vlan (\d+)$/.exec(b.head)).filter(Boolean).map((x) => +x[1])];
      const names = {};
      blocks.forEach((b) => { const x = /^vlan (\d+)$/.exec(b.head); if (x) names[x[1]] = ((b.kids.find((k) => /^name /.test(k)) || '').slice(5)) || `VLAN${String(x[1]).padStart(4, '0')}`; });
      const ports = {};
      MODELS[sd.model].ports.forEach((n) => {
        const l = M.linkOnPort(student, sd.id, n);
        if (l && (l.mode === 'trunk' || M.isL3End(student, l, sd.id))) return;
        const v = l ? l.vlan : 1;
        (ports[v] = ports[v] || []).push(shortName(n));
      });
      return { out: ['VLAN Name                             Status    Ports', '---- -------------------------------- --------- -------------------------------',
        ...made.sort((a, b) => a - b).map((v) => `${String(v).padEnd(5)}${(v === 1 ? 'default' : names[v]).padEnd(33)}active    ${(ports[v] || []).join(', ')}`)].join('\n') };
    }
    if (cmd === 'show interfaces trunk') {
      const t = M.linksOf(student, sd.id).filter((l) => l.mode === 'trunk' && !M.isL3End(student, l, sd.id));
      if (!t.length) return { out: '' };
      return { out: ['Port        Mode         Encapsulation  Status        Native vlan', ...t.map((l) => `${shortName(M.endIf(l, sd.id)).padEnd(12)}on           802.1q         trunking      ${l.nativeVlan}`),
        '', 'Port        Vlans allowed on trunk', ...t.map((l) => `${shortName(M.endIf(l, sd.id)).padEnd(12)}${l.allowed === 'all' ? '1-4094' : l.allowed}`)].join('\n') };
    }
    if (cmd === 'show ip ospf neighbor') {
      const st = sim.rt[sd.id];
      const up = st ? (st.ospfNbrs || []).filter((n) => n.ok) : [];
      return { out: ['', 'Neighbor ID     Pri   State           Dead Time   Address         Interface', ...up.map((n) => `${n.rid.padEnd(16)}  1   ${`${n.state}/${n.role}`.padEnd(16)}00:00:35    ${n.them.ip.padEnd(16)}${n.me.name}`)].join('\n') };
    }
    if ((m = /^show spanning-tree(?: vlan (\d+))?$/.exec(cmd))) {
      if (!M.isSwitch(sd)) return { out: '% Spanning tree runs on switches.' };
      const vlans = Object.keys(sim.stp.byVlan).map(Number).filter((v) => sim.stp.byVlan[v].bridges[sd.id] && (!m[1] || v === +m[1]));
      return { out: vlans.map((v) => PL.stp.showLines(sim.stp, sd, v).join('\n')).join('\n\n') || 'No spanning tree instance exists.' };
    }
    if (cmd === 'show standby brief' || cmd === 'show standby') {
      return { out: ['Interface   Grp  Pri P State   Virtual IP', ...sim.hsrp.filter((h) => h.devId === sd.id).map((h) => `${shortName(h.ifName).padEnd(12)}${String(h.group).padEnd(5)}${String(h.priority).padEnd(4)}${h.preempt ? 'P' : ' '} ${h.state.padEnd(8)}${h.vip}`)].join('\n') };
    }
    if (cmd === 'show ip dhcp binding') {
      return { out: ['IP address       Client-ID/              Lease expiration        Type', ...Object.entries(sim.leases).filter(([, l]) => l.ok && l.server === sd.name).map(([id, l]) => `${l.ip.padEnd(17)}${M.dev(student, id).name.padEnd(24)}Infinite                Automatic`)].join('\n') };
    }
    if (cmd === 'show access-lists' || cmd === 'show ip access-lists') {
      return { out: C.generate(student, sd, { paste: false, notes: false }).split('\n').filter((l) => /^(access-list|ip access-list| (permit|deny|remark))/.test(l)).join('\n') };
    }
    if (cmd === 'show ipv6 route') {
      return { out: ['IPv6 Routing Table - default', ...PL.ipv6.showRoutes(sim, sd).map((r) => `${r.code.padEnd(3)}${r.net}/${r.len}${r.nh ? ` via ${r.nh}` : ''}${r.ifName ? `, ${shortName(r.ifName)}` : ''}`)].join('\n') };
    }
    const more = moreShows(ctx, d, sd, student, sim, cmd);
    if (more) return more;
    if (/^show /.test(cmd)) return { out: '% PatchLab does not simulate this show command.' };
    return { out: invalid(cmd, cmd.split(' ')[0]) };
  }

  // ---------- The configuration as IOS shows it ----------

  // Where each kind of global line sits in show running-config.
  const ORDER = [[/^(no )?service /, 1], [/^hostname /, 2], [/^enable /, 3], [/^username /, 4], [/^(no )?ip domain|^ip name-server/, 5],
    [/^ip dhcp excluded/, 6], [/^ip dhcp pool/, 7], [/^(no )?ip dhcp snooping/, 8], [/^(no )?ip routing|^(no )?ipv6 unicast/, 9], [/^(no )?ip cef|^crypto/, 10],
    [/^spanning-tree/, 11], [/^vlan /, 12], [/^interface /, 20], [/^router |^ipv6 router/, 30], [/^ip (route|default-gateway|nat|http)|^ipv6 route/, 40],
    [/^ip access-list|^access-list/, 50], [/^banner /, 60], [/^line /, 70]];
  const rankOf = (head) => (ORDER.find(([re]) => re.test(head)) || [null, 45])[1];
  const IF_ORDER = ['Loopback', 'Port-channel', '', 'Vlan'];
  const ifRank = (n) => { const i = IF_ORDER.indexOf(/^[A-Za-z-]+/.exec(n)[0]); return i < 0 ? 2 : i; };

  // The running (or startup) configuration as the student typed it, laid out as IOS prints it:
  // factory defaults for everything untouched, every port listed, sections separated by "!".
  function configText(practice, d, blocks) {
    const router = M.isRouter(d);
    const find = (head) => blocks.find((b) => b.head === head);
    // VLANs live in vlan.dat, not the running configuration, so show vlan brief lists them.
    const globals = blocks.filter((b) => !/^interface |^line |^hostname |^vlan \d|^(no )?service password-encryption$/.test(b.head))
      .sort((a, b) => rankOf(a.head) - rankOf(b.head));
    const sect = (lo, hi) => globals.filter((b) => rankOf(b.head) >= lo && rankOf(b.head) < hi).flatMap((b) => [b.head, ...b.kids.map((k) => ` ${k}`)]);
    const out = ['!', 'version 15.2', 'service timestamps debug datetime msec', 'service timestamps log datetime msec',
      find('service password-encryption') ? 'service password-encryption' : 'no service password-encryption', '!',
      `hostname ${hostnameOf({ devices: { [d.id]: { blocks } } }, d)}`, '!', 'boot-start-marker', 'boot-end-marker', '!'];
    const push = (lines) => { if (lines.length) out.push(...lines, '!'); };
    push(sect(3, 11));
    const stp = sect(11, 20);
    if (!router && !stp.some((l) => /^spanning-tree mode/.test(l))) stp.unshift('spanning-tree mode pvst');
    if (!router) stp.push('spanning-tree extend system-id');
    push(stp);
    // Every port, then the interfaces the student created.
    const ports = MODELS[d.model].ports;
    const names = new Set([...ports, ...(router ? [] : ['Vlan1']), ...blocks.filter((b) => /^interface /.test(b.head)).map((b) => b.head.slice(10))]);
    [...names].sort((a, b) => ifRank(a) - ifRank(b) || naturalCompare(a, b)).forEach((n) => {
      const kids = (find(`interface ${n}`) || { kids: [] }).kids;
      const physical = ports.includes(n);
      const routed = router || /^(Loopback|Vlan)/.test(n) || kids.includes('no switchport');
      const shutByDefault = (router && physical) || /^Vlan/.test(n);
      const shut = kids.includes('shutdown') || (shutByDefault && !kids.includes('no shutdown'));
      const body = kids.filter((k) => k !== 'shutdown' && k !== 'no shutdown');
      const desc = body.filter((k) => /^description /.test(k));
      const rest = body.filter((k) => !/^description /.test(k));
      const lines = [...desc, ...(routed && !rest.some((k) => /^ip address /.test(k)) ? ['no ip address'] : []), ...rest, ...(shut ? ['shutdown'] : []),
        ...(router && physical ? ['duplex auto', 'speed auto'] : [])];
      out.push(`interface ${n}`, ...lines.map((l) => ` ${l}`), '!');
    });
    push(sect(30, 40));
    push(['ip forward-protocol nd', 'no ip http server', ...sect(40, 50)]);
    push(sect(50, 60));
    push(sect(60, 70));
    // Console, aux and vty lines, with whatever was typed under them.
    const conKids = (blocks.find((b) => /^line console 0$/.test(b.head)) || { kids: [] }).kids;
    out.push('line con 0', ...conKids.map((k) => ` ${k}`));
    if (router) out.push('line aux 0');
    const vtys = blocks.filter((b) => /^line vty /.test(b.head)).map((b) => [b.head.slice(5), b.kids]);
    if (!vtys.some(([h]) => /^vty 0 /.test(h))) vtys.unshift(['vty 0 4', []]);
    if (!router && !vtys.some(([h]) => /^vty (5 |0 15$)/.test(h))) vtys.push(['vty 5 15', []]);
    vtys.forEach(([h, kids]) => out.push(`line ${h}`, ...(kids.some((k) => /^(no )?login/.test(k)) ? [] : [' login']), ...kids.map((k) => ` ${k}`)));
    out.push('!', 'end');
    return out.join('\n');
  }

  // show commands beyond the basics: version, clock, history, interface status, CDP, MAC
  // table and routing protocols.
  function moreShows(ctx, d, sd, student, sim, cmd) {
    const ses = ctx.session;
    const ports = MODELS[sd.model].ports;
    const blocks = (ctx.practice.devices[d.id] || blank()).blocks;
    const kidsOf = (n) => (blocks.find((b) => b.head === `interface ${n}`) || { kids: [] }).kids;
    const descOf = (n) => (kidsOf(n).find((k) => /^description /.test(k)) || '').slice(12);
    const linkUp = (n) => { const l = M.linkOnPort(student, sd.id, n); return !!l && S.linkIsUp(sim, l); };
    const cdpName = (n) => shortName(n).replace(/^([A-Za-z]+)/, (w) => `${w.slice(0, 3)} `);
    let m;
    if (cmd === 'show version') {
      const up = Math.max(1, Math.round((Date.now() - (ses.booted || ses.started || Date.now())) / 60000));
      const gig = ports.filter((n) => /^Gigabit/.test(n)).length;
      const fast = ports.filter((n) => /^Fast/.test(n)).length;
      return { out: [`Cisco IOS Software, ${MODELS[sd.model].label} Software, Version 15.2, RELEASE SOFTWARE (PatchLab)`, '',
        `${hostnameOf(ctx.practice, d)} uptime is ${up} minute${up === 1 ? '' : 's'}`, 'System returned to ROM by power-on', 'System image file is "flash:/patchlab-universalk9.bin"', '',
        `cisco ${MODELS[sd.model].label} processor with 524288K bytes of memory.`, ...(fast ? [`${fast} FastEthernet interfaces`] : []), ...(gig ? [`${gig} Gigabit Ethernet interfaces`] : []),
        '256K bytes of non-volatile configuration memory.', '', 'Configuration register is 0x2102'].join('\n') };
    }
    if (cmd === 'show clock') {
      const t = new Date();
      const p2 = (x) => String(x).padStart(2, '0');
      const day = t.toLocaleDateString('en-US', { weekday: 'short' });
      const mon = t.toLocaleDateString('en-US', { month: 'short' });
      return { out: `*${p2(t.getHours())}:${p2(t.getMinutes())}:${p2(t.getSeconds())}.${String(t.getMilliseconds()).padStart(3, '0')} UTC ${day} ${mon} ${t.getDate()} ${t.getFullYear()}` };
    }
    if (cmd === 'show history') return { out: (ses.hist || []).slice(-(ses.histSize || 10)).map((l) => `  ${l}`).join('\n') };
    if (cmd === 'show interfaces status') {
      if (!M.isSwitch(sd)) return { out: invalid(cmd, 'status') };
      const rows = ['Port      Name               Status       Vlan       Duplex  Speed  Type'];
      ports.forEach((n) => {
        const l = M.linkOnPort(student, sd.id, n);
        const err = (sim.portSec || []).some((e) => e.devId === sd.id && e.ifName === n && e.violated && e.violation === 'shutdown');
        const st = err ? 'err-disabled' : M.port(sd, n).shutdown ? 'disabled' : linkUp(n) ? 'connected' : 'notconnect';
        const typed = /(\d+)$/.exec(kidsOf(n).find((k) => /^switchport access vlan /.test(k)) || '');
        const vlan = kidsOf(n).includes('no switchport') ? 'routed' : l && l.mode === 'trunk' && !M.isL3End(student, l, sd.id) ? 'trunk' : String(l ? l.vlan : typed ? typed[1] : 1);
        const gig = /^Gigabit/.test(n);
        const on = st === 'connected';
        rows.push(`${shortName(n).padEnd(10)}${descOf(n).slice(0, 18).padEnd(19)}${st.padEnd(13)}${vlan.padEnd(11)}${(on ? 'a-full' : 'auto').padEnd(8)}${(on ? (gig ? 'a-1000' : 'a-100') : 'auto').padEnd(6)} ${gig ? '10/100/1000BaseTX' : '10/100BaseTX'}`);
      });
      return { out: rows.join('\n') };
    }
    if (cmd === 'show interfaces description') {
      const rows = ['Interface                      Status         Protocol Description'];
      const typed = blocks.map((b) => /^interface (\S+)$/.exec(b.head)).filter(Boolean).map((x) => x[1]).filter((n) => !ports.includes(n));
      [...ports, ...typed].sort((a, b) => ifRank(a) - ifRank(b) || naturalCompare(a, b)).forEach((n) => {
        const phys = n.split('.')[0];
        const i = (sim.byDev[sd.id] || []).find((x) => x.name === n);
        const admin = ports.includes(phys) ? !!M.port(sd, phys).shutdown : kidsOf(n).includes('shutdown') || (/^Vlan/.test(n) && !kidsOf(n).includes('no shutdown'));
        const up = !admin && (ports.includes(phys) ? linkUp(phys) : !!(i && i.up));
        rows.push(`${shortName(n).padEnd(31)}${(admin ? 'admin down' : up ? 'up' : 'down').padEnd(15)}${(up ? 'up' : 'down').padEnd(9)}${descOf(n)}`);
      });
      return { out: rows.join('\n') };
    }
    if (/^show cdp neighbors( detail)?$/.test(cmd)) {
      const rows = ['Capability Codes: R - Router, T - Trans Bridge, B - Source Route Bridge', '                  S - Switch, H - Host, I - IGMP, r - Repeater, P - Phone', '',
        'Device ID        Local Intrfce     Holdtme    Capability  Platform  Port ID'];
      M.linksOf(student, sd.id).forEach((l) => {
        const peer = M.dev(student, M.peerOf(l, sd.id));
        if (M.isHost(peer) || !S.linkIsUp(sim, l)) return;
        const cap = M.isRouter(peer) ? 'R B S I' : M.canRoute(peer) ? 'R S I' : 'S I';
        const plat = MODELS[peer.model].label.split(/\s+/).pop().slice(0, 9);
        rows.push(`${hostnameOf(ctx.practice, peer).slice(0, 16).padEnd(17)}${cdpName(M.endIf(l, sd.id)).padEnd(18)}${'163'.padEnd(11)}${cap.padEnd(12)}${plat.padEnd(10)}${cdpName(M.endIf(l, peer.id))}`);
      });
      return { out: rows.join('\n') };
    }
    if ((m = /^show mac address-table(?: (.*))?$/.exec(cmd))) {
      if (!M.isSwitch(sd)) return { out: invalid(cmd, 'mac') };
      return { out: showMac(sim, sd, m[1] || '') };
    }
    if (cmd === 'show ip protocols') {
      return { out: blocks.filter((b) => /^router (ospf|rip|bgp)/.test(b.head)).map((b) => {
        const name = b.head.replace(/^router /, '');
        const rid = (b.kids.find((k) => /^router-id /.test(k)) || '').slice(10);
        const nets = b.kids.filter((k) => /^network /.test(k)).map((k) => `    ${k.slice(8)}`);
        const passive = b.kids.filter((k) => /^passive-interface /.test(k)).map((k) => `    ${k.slice(18)}`);
        return [`Routing Protocol is "${name}"`, '  Outgoing update filter list for all interfaces is not set', '  Incoming update filter list for all interfaces is not set',
          ...(rid ? [`  Router ID ${rid}`] : []), '  Routing for Networks:', ...nets, ...(passive.length ? ['  Passive Interface(s):', ...passive] : []),
          `  Distance: (default is ${{ ospf: 110, rip: 120, bgp: 20 }[name.split(' ')[0]]})`].join('\n');
      }).join('\n\n') };
    }
    return ccnaShows(ctx, d, sd, student, sim, cmd);
  }

  // One made-up burned-in address per interface. Sub-interfaces share their port's; every
  // SVI on a switch shares one, as on real hardware.
  const ifMac = (devId, name) => M.macFor(`${devId}:${/^Vlan/.test(name) ? 'Vlan' : name.split('.')[0]}`);
  const hsrpMac = (group) => `0000.0c07.ac${(+group).toString(16).padStart(2, '0')}`;

  // Every ARP entry an interface would hold once traffic has flowed: its own address, and each
  // address up in the same subnet and broadcast domain, HSRP virtual IPs included.
  function arpEntries(sim, devId) {
    const rows = [];
    const all = [...sim.ifaces, ...sim.vips];
    (sim.byDev[devId] || []).filter((i) => i.up && i.ip && i.kind !== 'loopback').forEach((i) => {
      const add = (ip, age, mac) => { if (!rows.some((r) => r.ip === ip)) rows.push({ ip, age, mac, ifName: i.name, own: age === '-' }); };
      add(i.ip, '-', ifMac(devId, i.name));
      all.forEach((j) => {
        if (j === i || !j.up || !j.ip || !i.domain || j.domain !== i.domain || !N.inNet(j.ip, i.net, i.mask)) return;
        if (j.kind === 'vip') add(j.ip, j.devId === devId ? '-' : '0', j.hsrp ? hsrpMac(j.hsrp.group) : ifMac(j.devId, j.name));
        else if (j.devId !== devId) add(j.ip, '0', ifMac(j.devId, j.name));
      });
    });
    return rows.sort((a, b) => N.ip2n(a.ip) - N.ip2n(b.ip));
  }

  // Up, down or administratively down, for any interface this device has; null if it has none.
  function ifState(student, sim, sd, name) {
    const phys = name.split('.')[0];
    if (MODELS[sd.model].ports.includes(phys) || /^Port-channel/.test(phys)) {
      const l = /^Port-channel/.test(phys) ? M.linksOf(student, sd.id).find((x) => M.endIf(x, sd.id) === phys) : M.linkOnPort(student, sd.id, phys);
      if (/^Port-channel/.test(phys) && !l) return null;
      const c = sd.ports[phys] || {};
      if (phys !== name && !(c.subifs || []).some((x) => `${phys}.${x.num}` === name)) return null;
      const err = (sim.portSec || []).some((e) => e.devId === sd.id && e.ifName === phys && e.violated && e.violation === 'shutdown');
      return { admin: !!c.shutdown, up: !c.shutdown && !!l && S.linkIsUp(sim, l), err, cfg: phys === name ? c : c.subifs.find((x) => `${phys}.${x.num}` === name) };
    }
    const i = (sim.byDev[sd.id] || []).find((x) => x.name === name);
    const svi = sd.svis.find((x) => `Vlan${x.vlan}` === name);
    if (svi) return { admin: !!svi.shutdown, up: !!(i && i.up), err: false, cfg: svi };
    const lo = sd.loopbacks.find((x) => `Loopback${x.num}` === name);
    return lo ? { admin: false, up: true, err: false, cfg: lo } : null;
  }

  const stateLine = (name, st) => `${name} is ${st.admin ? 'administratively down' : st.up ? 'up' : 'down'}, line protocol is ${st.up ? 'up' : 'down'}${st.err ? ' (err-disabled)' : ''}`;

  // Every interface name on a device, in IOS order.
  function allIfNames(sd) {
    const names = [...MODELS[sd.model].ports, ...Object.keys(sd.ports).filter((n) => /^Port-channel/.test(n)),
      ...sd.svis.map((x) => `Vlan${x.vlan}`), ...sd.loopbacks.map((x) => `Loopback${x.num}`)];
    MODELS[sd.model].ports.forEach((n) => ((sd.ports[n] || {}).subifs || []).forEach((x) => names.push(`${n}.${x.num}`)));
    return [...new Set(names)].sort((a, b) => ifRank(a) - ifRank(b) || naturalCompare(a, b));
  }

  // The CCNA troubleshooting shows: interface detail and switchport, ARP, port security,
  // EtherChannel, OSPF interfaces, NAT, BGP, DHCP, IPv6 interfaces, one route and one VLAN.
  function ccnaShows(ctx, d, sd, student, sim, cmd) {
    const blocks = (ctx.practice.devices[d.id] || blank()).blocks;
    const kidsOf = (n) => (blocks.find((b) => b.head === `interface ${n}`) || { kids: [] }).kids;
    const vlanName = (v) => (v === 1 ? 'default' : ((blocks.find((b) => b.head === `vlan ${v}`) || { kids: [] }).kids.find((k) => /^name /.test(k)) || '').slice(5) || `VLAN${String(v).padStart(4, '0')}`);
    const len = (c) => N.maskToLen(c.mask);
    let m;
    if ((m = /^show interfaces(?: (\S+))?$/.exec(cmd))) {
      const names = m[1] ? [m[1]] : allIfNames(sd);
      const out = [];
      for (const name of names) {
        const st = ifState(student, sim, sd, name);
        if (!st) return { out: invalid(cmd, m[1]) };
        const c = st.cfg;
        const sub = /\./.test(name);
        const kind = /^Gigabit/.test(name) ? 'Gigabit Ethernet' : /^Fast/.test(name) ? 'Fast Ethernet' : /^Vlan/.test(name) ? 'EtherSVI' : /^Loopback/.test(name) ? 'Loopback' : /^Port-channel/.test(name) ? 'EtherChannel' : 'Ethernet';
        const bw = { Loopback: 8000000, EtherSVI: 1000000, 'Gigabit Ethernet': 1000000, EtherChannel: 2000000 }[kind] || 100000;
        const mac = ifMac(sd.id, name);
        const phys = MODELS[sd.model].ports.includes(name);
        out.push(stateLine(name, st), `  Hardware is ${kind}${kind === 'Loopback' ? '' : `, address is ${mac} (bia ${mac})`}`,
          ...(c.desc || (kidsOf(name).find((k) => /^description /.test(k)) || '') ? [`  Description: ${c.desc || kidsOf(name).find((k) => /^description /.test(k)).slice(12)}`] : []),
          ...(N.ip2n(c.ip) !== null && len(c) !== null ? [`  Internet address is ${c.ip}/${len(c)}`] : []),
          `  MTU ${kind === 'Loopback' ? 1514 : 1500} bytes, BW ${bw} Kbit/sec, DLY ${kind === 'Loopback' ? 5000 : bw >= 1000000 ? 10 : 100} usec,`,
          '     reliability 255/255, txload 1/255, rxload 1/255',
          `  Encapsulation ${sub ? `802.1Q Virtual LAN, Vlan ID  ${c.vlan}.` : kind === 'Loopback' ? 'LOOPBACK' : 'ARPA'}, loopback not set`,
          ...(phys ? [`  ${st.up ? `Full-duplex, ${/^Gigabit/.test(name) ? '1000' : '100'}Mb/s` : 'Auto-duplex, Auto-speed'}, media type is RJ45`] : []),
          ...(sub || kind === 'Loopback' ? [] : ['  ARP type: ARPA, ARP Timeout 04:00:00', '  5 minute input rate 0 bits/sec, 0 packets/sec', '  5 minute output rate 0 bits/sec, 0 packets/sec',
            '     0 packets input, 0 bytes, 0 no buffer', '     0 input errors, 0 CRC, 0 frame, 0 overrun, 0 ignored', '     0 packets output, 0 bytes, 0 underruns', '     0 output errors, 0 collisions, 0 interface resets']));
      }
      return { out: out.join('\n') };
    }
    if ((m = /^show interfaces (\S+) switchport$/.exec(cmd))) {
      if (!M.isSwitch(sd) || !MODELS[sd.model].ports.includes(m[1]) && !/^Port-channel/.test(m[1])) return { out: invalid(cmd, 'switchport') };
      const kids = kidsOf(m[1]);
      if (kids.includes('no switchport')) return { out: `Name: ${shortName(m[1])}\nSwitchport: Disabled` };
      const l = /^Port-channel/.test(m[1]) ? M.linksOf(student, sd.id).find((x) => M.endIf(x, sd.id) === m[1]) : M.linkOnPort(student, sd.id, m[1]);
      const typedMode = (/^switchport mode (\S+(?: \S+)?)$/.exec(kids.find((k) => /^switchport mode /.test(k)) || '') || [])[1];
      const admin = typedMode === 'access' ? 'static access' : typedMode === 'trunk' ? 'trunk' : typedMode || 'dynamic auto';
      const st = ifState(student, sim, sd, m[1]);
      const trunk = l && l.mode === 'trunk';
      const access = +((/(\d+)$/.exec(kids.find((k) => /^switchport access vlan /.test(k)) || '') || [])[1] || 1);
      const native = l ? l.nativeVlan : 1;
      return { out: [`Name: ${shortName(m[1])}`, 'Switchport: Enabled', `Administrative Mode: ${admin}`,
        `Operational Mode: ${st && st.up ? (trunk ? 'trunk' : 'static access') : 'down'}`, 'Administrative Trunking Encapsulation: dot1q',
        ...(st && st.up && trunk ? ['Operational Trunking Encapsulation: dot1q'] : []),
        `Negotiation of Trunking: ${kids.includes('switchport nonegotiate') || typedMode === 'access' ? 'Off' : 'On'}`,
        `Access Mode VLAN: ${access} (${vlanName(access)})`, `Trunking Native Mode VLAN: ${native} (${vlanName(native)})`,
        'Administrative Native VLAN tagging: enabled', 'Voice VLAN: none',
        `Trunking VLANs Enabled: ${!l || l.allowed === 'all' || !l.allowed ? 'ALL' : l.allowed}`, 'Pruning VLANs Enabled: 2-1001',
        `Protected: false`, 'Unknown unicast blocked: disabled', 'Unknown multicast blocked: disabled'].join('\n') };
    }
    if ((m = /^show ip interface(?: (\S+))?$/.exec(cmd))) {
      const names = m[1] ? [m[1]] : allIfNames(sd);
      const out = [];
      for (const name of names) {
        const st = ifState(student, sim, sd, name);
        if (!st) return { out: invalid(cmd, m[1]) };
        const c = st.cfg;
        out.push(stateLine(name, st));
        if (N.ip2n(c.ip) === null || len(c) === null) { out.push('  Internet protocol processing disabled'); continue; }
        out.push(`  Internet address is ${c.ip}/${len(c)}`, '  Broadcast address is 255.255.255.255', '  MTU is 1500 bytes',
          `  Helper address is ${c.helper || 'not set'}`, `  Outgoing access list is ${c.aclOut || 'not set'}`, `  Inbound  access list is ${c.aclIn || 'not set'}`,
          '  Proxy ARP is enabled', '  Security level is default', '  Split horizon is enabled', '  ICMP redirects are always sent', '  ICMP unreachables are always sent',
          ...(c.nat ? [`  IP NAT ${c.nat}`] : []));
      }
      return { out: out.join('\n') };
    }
    if (cmd === 'show arp' || cmd === 'show ip arp') {
      return { out: ['Protocol  Address          Age (min)  Hardware Addr   Type   Interface',
        ...arpEntries(sim, sd.id).map((r) => `Internet  ${r.ip.padEnd(17)}${r.age.padStart(9)}   ${r.mac}  ARPA   ${r.ifName}`)].join('\n') };
    }
    if ((m = /^show port-security(?: interface (\S+)| (address))?$/.exec(cmd))) {
      if (!M.isSwitch(sd)) return { out: invalid(cmd, 'port-security') };
      const secured = MODELS[sd.model].ports.filter((n) => (sd.ports[n] || {}).portSec);
      const entry = (n) => (sim.portSec || []).find((e) => e.devId === sd.id && e.ifName === n);
      if (m[2]) {
        const rows = ['               Secure Mac Address Table', '-----------------------------------------------------------------------------',
          'Vlan    Mac Address       Type                          Ports   Remaining Age', '                                                               (mins)',
          '----    -----------       ----                          -----   -------------'];
        const ent = macTable(sim, sd).filter((e) => secured.includes(e.port));
        ent.forEach((e) => rows.push(`${String(e.vlan).padStart(4)}    ${e.mac}    ${((sd.ports[e.port].portSec.sticky ? 'SecureSticky' : 'SecureDynamic')).padEnd(30)}${shortName(e.port).padEnd(8)}    -`));
        rows.push('-----------------------------------------------------------------------------', `Total Addresses in System (excluding one mac per port)     : ${Math.max(0, ent.length - secured.length)}`,
          'Max Addresses limit in System (excluding one mac per port) : 4096');
        return { out: rows.join('\n') };
      }
      if (m[1]) {
        const ps = (sd.ports[m[1]] || {}).portSec;
        if (!MODELS[sd.model].ports.includes(m[1])) return { out: invalid(cmd, m[1]) };
        const e = entry(m[1]);
        const st = ifState(student, sim, sd, m[1]);
        const learned = macTable(sim, sd).filter((x) => x.port === m[1]);
        return { out: [`Port Security              : ${ps ? 'Enabled' : 'Disabled'}`,
          `Port Status                : ${!ps ? 'Secure-down' : e && e.violated && e.violation === 'shutdown' ? 'Secure-shutdown' : st && st.up ? 'Secure-up' : 'Secure-down'}`,
          `Violation Mode             : ${ps ? ps.violation[0].toUpperCase() + ps.violation.slice(1) : 'Shutdown'}`, 'Aging Time                 : 0 mins', 'Aging Type                 : Absolute',
          'SecureStatic Address Aging : Disabled', `Maximum MAC Addresses      : ${ps ? ps.max : 1}`, `Total MAC Addresses        : ${ps ? learned.length : 0}`, 'Configured MAC Addresses   : 0',
          `Sticky MAC Addresses       : ${ps && ps.sticky ? learned.length : 0}`, `Last Source Address:Vlan   : ${learned.length ? `${learned[learned.length - 1].mac}:${learned[learned.length - 1].vlan}` : '0000.0000.0000:0'}`,
          `Security Violation Count   : ${e && e.violated ? e.count - e.max : 0}`].join('\n') };
      }
      return { out: ['Secure Port  MaxSecureAddr  CurrentAddr  SecurityViolation  Security Action', '                (Count)       (Count)          (Count)',
        '---------------------------------------------------------------------------',
        ...secured.map((n) => {
          const ps = sd.ports[n].portSec;
          const e = entry(n);
          const cur = macTable(sim, sd).filter((x) => x.port === n).length;
          return `${shortName(n).padStart(11)}${String(ps.max).padStart(15)}${String(cur).padStart(13)}${String(e && e.violated ? e.count - e.max : 0).padStart(19)}         ${ps.violation[0].toUpperCase() + ps.violation.slice(1)}`;
        }), '---------------------------------------------------------------------------',
        'Total Addresses in System (excluding one mac per port)     : 0', 'Max Addresses limit in System (excluding one mac per port) : 4096'].join('\n') };
    }
    if (cmd === 'show etherchannel summary') {
      // Groups come from what was typed: channel-group N mode X under each member.
      const groups = {};
      MODELS[sd.model].ports.forEach((n) => {
        const x = /^channel-group (\d+) mode (\S+)$/.exec(kidsOf(n).find((k) => /^channel-group /.test(k)) || '');
        if (x) (groups[x[1]] = groups[x[1]] || { mode: x[2], ports: [] }).ports.push(n);
      });
      const rows = ['Flags:  D - down        P - bundled in port-channel', '        I - stand-alone s - suspended', '        H - Hot-standby (LACP only)',
        '        R - Layer3      S - Layer2', '        U - in use      f - failed to allocate aggregator', '', '        M - not in use, minimum links not met',
        '        u - unsuitable for bundling', '        w - waiting to be aggregated', '        d - default port', '',
        `Number of channel-groups in use: ${Object.keys(groups).length}`, `Number of aggregators:           ${Object.keys(groups).length}`, '',
        'Group  Port-channel  Protocol    Ports', '------+-------------+-----------+-----------------------------------------------'];
      Object.keys(groups).sort((a, b) => a - b).forEach((g) => {
        const { mode, ports } = groups[g];
        const l = M.linksOf(student, sd.id).find((x) => x.ec && M.endIf(x, sd.id) === `Port-channel${g}`);
        const up = !!l && S.linkIsUp(sim, l) && l.members.every((mm) => ports.includes(mm[M.side(l, sd.id)]));
        const proto = /^(active|passive)$/.test(mode) ? 'LACP' : /^(desirable|auto)$/.test(mode) ? 'PAgP' : '-';
        const l3 = !M.isSwitch(sd) || kidsOf(`Port-channel${g}`).includes('no switchport') || kidsOf(ports[0]).includes('no switchport');
        rows.push(`${g.padEnd(7)}${`Po${g}(${l3 ? 'R' : 'S'}${up ? 'U' : 'D'})`.padEnd(14)}${proto.padEnd(12)}${ports.map((n) => `${shortName(n)}(${up ? 'P' : 'D'})`).join('   ')}`);
      });
      return { out: rows.join('\n') };
    }
    if ((m = /^show ip ospf interface(?: (brief|\S+))?$/.exec(cmd))) {
      const st = sim.rt[sd.id];
      if (!st || !sd.routing.ospf.enabled) return { out: '' };
      const pid = sd.routing.ospf.pid || 1;
      const ifs = (st.ospfIfs || []).filter((x) => !m[1] || m[1] === 'brief' || x.i.name === m[1]);
      const nbrs = (x) => (st.ospfNbrs || []).filter((n) => n.ok && n.me === x.i);
      const state = (x) => (x.i.kind === 'loopback' ? 'LOOP' : (st.ospfRoles || {})[x.i.name] || 'DR');
      const cost = (x) => PL.catalog.ospfCost(x.i.name);
      if (m[1] === 'brief') {
        return { out: ['Interface    PID   Area            IP Address/Mask    Cost  State Nbrs F/C',
          ...ifs.map((x) => `${shortName(x.i.name).padEnd(13)}${String(pid).padEnd(6)}${x.area.padEnd(16)}${`${x.i.ip}/${x.i.len}`.padEnd(19)}${String(cost(x)).padEnd(6)}${state(x).padEnd(6)}${nbrs(x).filter((n) => n.state === 'FULL').length}/${nbrs(x).length}`)].join('\n') };
      }
      return { out: ifs.map((x) => [`${x.i.name} is up, line protocol is up`, `  Internet Address ${x.i.ip}/${x.i.len}, Area ${x.area}`,
        `  Process ID ${pid}, Router ID ${st.ospfRid}, Network Type ${x.i.kind === 'loopback' ? 'LOOPBACK' : 'BROADCAST'}, Cost: ${cost(x)}`,
        ...(x.i.kind === 'loopback' ? ['  Loopback interface is treated as a stub Host'] : [
          `  Transmit Delay is 1 sec, State ${state(x)}, Priority 1`,
          '  Timer intervals configured, Hello 10, Dead 40, Wait 40, Retransmit 5',
          ...(x.passive ? ['    No Hellos (Passive interface)'] : ['    Hello due in 00:00:04']),
          `  Neighbor Count is ${nbrs(x).length}, Adjacent neighbor count is ${nbrs(x).filter((n) => n.state === 'FULL').length}`,
          ...nbrs(x).filter((n) => n.state === 'FULL').map((n) => `    Adjacent with neighbor ${n.rid}${n.role === 'DR' || n.role === 'BDR' ? `  (${n.role === 'DR' ? 'Designated Router' : 'Backup Designated Router'})` : ''}`)])].join('\n')).join('\n') };
    }
    if (cmd === 'show ip nat translations') {
      return { out: ['Pro Inside global      Inside local       Outside local      Outside global',
        ...(sd.nat ? sd.nat.statics : []).map((x) => `--- ${x.global.padEnd(19)}${x.local.padEnd(19)}---                ---`)].join('\n') };
    }
    if (cmd === 'show ip bgp summary' || cmd === 'show ip bgp') {
      const b = sd.routing.bgp;
      if (!b.enabled) return { out: '% BGP not active' };
      const ups = (sim.byDev[sd.id] || []).filter((i) => i.up && i.ip && i.kind !== 'vip');
      const top = (list) => list.map((i) => i.ip).sort((x, y) => N.ip2n(y) - N.ip2n(x))[0];
      const rid = N.ip2n(b.routerId) !== null ? b.routerId : top(ups.filter((i) => i.kind === 'loopback')) || top(ups) || '0.0.0.0';
      const table = S.bgpTable(sim, sd);
      if (cmd === 'show ip bgp') {
        return { out: [`BGP table version is ${table.length + 1}, local router ID is ${rid}`, 'Status codes: s suppressed, d damped, h history, * valid, > best, i - internal',
          'Origin codes: i - IGP, e - EGP, ? - incomplete', '', '     Network          Next Hop            Metric LocPrf Weight Path',
          ...table.map((r) => ` ${r.valid ? '*' : ' '}${r.best ? '>' : ' '}${r.ibgp ? 'i' : ' '} ${`${r.net}/${r.len}`.padEnd(17)}${r.nh.padEnd(20)}${'0'.padStart(6)}${(r.ibgp ? '100' : '').padStart(7)}${(r.local ? '32768' : '0').padStart(7)} ${[...r.path, 'i'].join(' ')}`)].join('\n') };
      }
      const sessions = (sim.rt[sd.id] || {}).bgpSessions || [];
      return { out: [`BGP router identifier ${rid}, local AS number ${b.asn}`, `BGP table version is ${table.length + 1}, main routing table version ${table.length + 1}`,
        `${table.length} network entries using ${table.length * 136} bytes of memory`, '',
        'Neighbor        V           AS MsgRcvd MsgSent   TblVer  InQ OutQ Up/Down  State/PfxRcd',
        ...sessions.map((x) => {
          const owner = sim.ifaces.find((i) => i.ip === x.neighbor.ip);
          const pfx = owner ? table.filter((r) => !r.local && r.from === owner.dev.name).length : 0;
          const up = x.state === 'Established';
          return `${x.neighbor.ip.padEnd(16)}4 ${String(x.neighbor.remoteAs).padStart(12)}${(up ? '12' : '0').padStart(8)}${(up ? '12' : '0').padStart(8)}${String(up ? table.length + 1 : 1).padStart(9)}    0    0 ${(up ? '00:05:12' : 'never').padEnd(9)}${up ? pfx : 'Idle'}`;
        })].join('\n') };
    }
    if (cmd === 'show ip dhcp pool') {
      return { out: sd.dhcp.pools.map((pool) => {
        const l = N.maskToLen(pool.mask);
        if (N.ip2n(pool.network) === null || l === null) return `Pool ${pool.name} :\n Total addresses                : 0`;
        const lo = N.ip2n(N.network(pool.network, pool.mask)) + 1;
        const hi = N.ip2n(N.broadcast(pool.network, pool.mask)) - 1;
        let excluded = 0;
        sd.dhcp.excluded.forEach((e) => {
          const a = N.ip2n(e.from);
          const z = N.ip2n(e.to || e.from);
          if (a !== null && z !== null) excluded += Math.max(0, Math.min(hi, Math.max(a, z)) - Math.max(lo, Math.min(a, z)) + 1);
        });
        const leased = Object.values(sim.leases).filter((x) => x.ok && x.server === sd.name && N.inNet(x.ip, pool.network, pool.mask)).length;
        const total = Math.max(0, hi - lo + 1);
        return [`Pool ${pool.name} :`, ' Utilization mark (high/low)    : 100 / 0', ' Subnet size (first/next)       : 0 / 0', ` Total addresses                : ${total}`,
          ` Leased addresses               : ${leased}`, ` Excluded addresses             : ${excluded}`, ' Pending event                  : none', ' 1 subnet is currently in the pool :',
          ' Current index        IP address range                    Leased/Excluded/Total',
          ` ${N.n2ip(lo + excluded + leased).padEnd(21)}${N.n2ip(lo).padEnd(17)}- ${N.n2ip(hi).padEnd(18)}${String(leased).padEnd(6)}/ ${String(excluded).padEnd(6)}/ ${total}`].join('\n');
      }).join('\n\n') };
    }
    if (cmd === 'show ip dhcp snooping') {
      if (!M.isSwitch(sd)) return { out: invalid(cmd, 'snooping') };
      const sn = sd.snooping || {};
      return { out: [`Switch DHCP snooping is ${sn.on ? 'enabled' : 'disabled'}`, 'DHCP snooping is configured on following VLANs:', sn.vlans || 'none',
        'DHCP snooping is operational on following VLANs:', sn.on ? sn.vlans || 'none' : 'none', 'Insertion of option 82 is enabled', '',
        'Interface                  Trusted    Allow option    Rate limit (pps)', '-----------------------    -------    ------------    ----------------',
        ...MODELS[sd.model].ports.filter((n) => (sd.ports[n] || {}).trust).map((n) => `${n.padEnd(27)}yes        yes             unlimited`)].join('\n') };
    }
    if (cmd === 'show ipv6 interface brief') {
      const F = (x) => PL.ipv6.format(x).toUpperCase();
      return { out: allIfNames(sd).flatMap((name) => {
        const st = ifState(student, sim, sd, name);
        const v = ((sim.v6 && sim.v6.byDev[sd.id]) || []).find((i) => i.name === name);
        const status = st.admin ? 'administratively down/down' : st.up ? 'up/up' : 'down/down';
        return [`${name.padEnd(23)}[${status}]`, ...(v ? [`    ${F(v.ll)}`, ...(v.addr !== null ? [`    ${F(v.addr)}`] : [])] : ['    unassigned'])];
      }).join('\n') };
    }
    if (cmd === 'show ipv6 ospf neighbor') {
      const st = sim.v6 && sim.v6.rt[sd.id];
      if (!st || !sd.routing.ospf3.enabled) return { out: '' };
      return { out: ['', `            OSPFv3 Router with ID (${st.rid}) (Process ID ${sd.routing.ospf3.pid || 1})`, '',
        'Neighbor ID     Pri   State           Dead Time   Interface ID    Interface',
        ...st.nbrs.filter((n) => n.ok).map((n) => `${n.rid.padEnd(16)}  1   ${`FULL/${N.ip2n(n.rid) > N.ip2n(st.rid) ? 'DR' : 'BDR'}`.padEnd(16)}00:00:35    ${String(portNumOf(n.them.name)).padEnd(16)}${n.me.name}`)].join('\n') };
    }
    if (cmd === 'show spanning-tree summary') {
      if (!M.isSwitch(sd)) return { out: '% Spanning tree runs on switches.' };
      const mode = (/^spanning-tree mode (\S+)$/.exec((blocks.find((b) => /^spanning-tree mode /.test(b.head)) || {}).head || '') || [])[1] || 'pvst';
      const vlans = Object.keys(sim.stp.byVlan).map(Number).filter((v) => sim.stp.byVlan[v].bridges[sd.id]).sort((a, b) => a - b);
      const me = (v) => sim.stp.byVlan[v].bridges[sd.id];
      const roots = vlans.filter((v) => !me(v).rootDev || me(v).rootDev === sd.id).map((v) => `VLAN${String(v).padStart(4, '0')}`);
      const count = (v, s) => me(v).ports.filter((x) => x.state === s).length;
      const rows = vlans.map((v) => `VLAN${String(v).padStart(4, '0')}`.padEnd(23) + [count(v, 'BLK'), 0, 0, count(v, 'FWD'), me(v).ports.length].map((x, i) => String(x).padStart([8, 10, 9, 11, 11][i])).join(''));
      return { out: [`Switch is in ${mode} mode`, `Root bridge for: ${roots.join(', ') || 'none'}`, 'Extended system ID           is enabled',
        `Portfast Default             is ${blocks.some((b) => b.head === 'spanning-tree portfast default') ? 'enabled' : 'disabled'}`, 'PortFast BPDU Guard Default  is disabled',
        'Portfast BPDU Filter Default is disabled', 'Loopguard Default            is disabled', 'EtherChannel misconfig guard is enabled', 'UplinkFast                   is disabled',
        'BackboneFast                 is disabled', 'Pathcost method used         is short', '',
        'Name                   Blocking Listening Learning Forwarding STP Active', '---------------------- -------- --------- -------- ---------- ----------', ...rows,
        '---------------------- -------- --------- -------- ---------- ----------',
        `${`${vlans.length} vlan${vlans.length === 1 ? '' : 's'}`.padEnd(23)}${[vlans.reduce((a, v) => a + count(v, 'BLK'), 0), 0, 0, vlans.reduce((a, v) => a + count(v, 'FWD'), 0), vlans.reduce((a, v) => a + me(v).ports.length, 0)].map((x, i) => String(x).padStart([8, 10, 9, 11, 11][i])).join('')}`].join('\n') };
    }
    if ((m = /^show vlan id (\d+)$/.exec(cmd))) {
      if (!M.isSwitch(sd)) return { out: invalid(cmd, 'vlan') };
      const lines = execShowRaw(ctx, d, 'show vlan brief').out.split('\n');
      const row = lines.find((l) => l.split(' ')[0] === m[1]);
      return { out: row ? [...lines.slice(0, 2), row].join('\n') : `VLAN id ${m[1]} not found in current VLAN database` };
    }
    if ((m = /^show ip route (\d+\.\d+\.\d+\.\d+)$/.exec(cmd))) {
      if (!M.canRoute(sd)) return { out: invalid(cmd, 'route') };
      const hit = S.showRoutes(sim, sd).filter((r) => r.len > 0 && N.inNet(m[1], r.net, N.lenToMask(r.len))).sort((a, b) => b.len - a.len)[0];
      if (!hit) return { out: '% Network not in table' };
      const via = { C: '"connected"', L: '"connected"', S: '"static"', O: `"ospf ${sd.routing.ospf.pid || 1}"`, R: '"rip"', B: `"bgp ${sd.routing.bgp.asn}"` }[hit.proto] || `"${hit.proto}"`;
      const conn = hit.proto === 'C' || hit.proto === 'L';
      return { out: [`Routing entry for ${hit.net}/${hit.len}`, `  Known via ${via}, distance ${conn ? 0 : hit.ad}, metric ${conn ? 0 : hit.metric}${conn ? ' (connected, via interface)' : ''}`,
        '  Routing Descriptor Blocks:', conn ? `  * directly connected, via ${hit.ifName}` : `  * ${hit.nh || 'directly connected'}${hit.ifName ? `, via ${hit.ifName}` : ''}`,
        `      Route metric is ${conn ? 0 : hit.metric}, traffic share count is 1`].join('\n') };
    }
    return null;
  }

  // The interface ID OSPFv3 shows: the port's index on its device.
  const portNumOf = (name) => +(/(\d+)(?:\.\d+)?$/.exec(name) || [0, 0])[1] + 1;

  // The MAC addresses a switch would learn, per VLAN: every router, host and SVI reachable in
  // that VLAN, learned on the port the frames arrive on, across trunks and through other
  // switches (spanning tree's blocked ports carry nothing). Assumes every device has sent.
  function macTable(sim, sd) {
    const out = [];
    Object.keys(sim.adj).filter((k) => k.startsWith(`v:${sd.id}:`)).forEach((start) => {
      const vlan = +start.split(':')[2];
      const via = { [start]: null };
      const queue = [start];
      while (queue.length) {
        const k = queue.shift();
        (sim.adj[k] || []).forEach((e) => {
          if (e.to in via) return;
          // The first cable out of this switch is the port; a null link is this switch's own SVI.
          via[e.to] = k === start ? (e.link ? M.endIf(sim.project.links.find((l) => l.id === e.link), sd.id) : 'CPU') : via[k];
          queue.push(e.to);
        });
      }
      Object.entries(via).forEach(([k, port]) => {
        if (!k.startsWith('i:') || !port || port === 'CPU') return;
        const [, devId, name] = /^i:([^:]+):(.+)$/.exec(k);
        const ps = (sim.portSec || []).find((e) => e.devId === sd.id && e.ifName === port);
        if (ps && (ps.dropped || []).includes(devId)) return;
        const mac = ifMac(devId, name);
        if (!out.some((x) => x.vlan === vlan && x.mac === mac)) out.push({ vlan, mac, port, type: ps && ps.sticky ? 'STATIC' : 'DYNAMIC' });
      });
    });
    return out.sort((a, b) => a.vlan - b.vlan || naturalCompare(a.port, b.port) || (a.mac < b.mac ? -1 : 1));
  }

  // The switch's own entries, sent to its CPU: CDP, STP and the broadcast address.
  const CPU_MACS = ['0100.0ccc.cccc', '0100.0ccc.cccd', '0180.c200.0000', '0180.c200.0001', '0180.c200.0002', '0180.c200.0003', 'ffff.ffff.ffff'];
  const macDigits = (s) => s.toLowerCase().replace(/[^0-9a-f]/g, '');

  // show mac address-table, with the filters IOS takes: dynamic, static, vlan, interface,
  // address, count and aging-time, in any order.
  function showMac(sim, sd, rest) {
    if (rest === 'aging-time') return 'Global Aging Time:  300\nVlan    Aging Time\n----    ----------';
    const f = {};
    const words = rest.split(' ').filter(Boolean);
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (w === 'dynamic' || w === 'static' || w === 'count') f[w] = true;
      else if ((w === 'vlan' || w === 'interface' || w === 'address') && words[i + 1]) f[w] = words[++i];
      else return `% Invalid input detected at '^' marker.`;
    }
    if (f.vlan && !/^\d+$/.test(f.vlan)) return `% Invalid input detected at '^' marker.`;
    if (f.address && macDigits(f.address).length !== 12) return '% Invalid MAC address. Use the form H.H.H, for example 0050.7966.6800';
    let ent = macTable(sim, sd);
    if (!f.vlan && !f.interface && !f.address && !f.dynamic) ent = [...CPU_MACS.map((mac) => ({ vlan: 'All', mac, port: 'CPU', type: 'STATIC' })), ...ent];
    ent = ent.filter((e) => (!f.dynamic || e.type === 'DYNAMIC') && (!f.static || e.type === 'STATIC') && (!f.vlan || e.vlan === +f.vlan)
      && (!f.interface || e.port === f.interface) && (!f.address || macDigits(e.mac) === macDigits(f.address)));
    if (f.count) {
      const vlans = [...new Set(ent.filter((e) => e.vlan !== 'All').map((e) => e.vlan))];
      const block = (v, list) => [`Mac Entries for Vlan ${v}:`, '---------------------------', `Dynamic Address Count  : ${list.filter((e) => e.type === 'DYNAMIC').length}`,
        `Static  Address Count  : ${list.filter((e) => e.type === 'STATIC').length}`, `Total Mac Addresses    : ${list.length}`, ''];
      return [...vlans.flatMap((v) => block(v, ent.filter((e) => e.vlan === v))), 'Total Mac Address Space Available: 8000'].join('\n');
    }
    return ['          Mac Address Table', '-------------------------------------------', '', 'Vlan    Mac Address       Type        Ports', '----    -----------       --------    -----',
      ...ent.map((e) => `${String(e.vlan).padStart(4)}    ${e.mac}    ${e.type.padEnd(8)}    ${e.port === 'CPU' ? 'CPU' : shortName(e.port)}`),
      `Total Mac Addresses for this criterion: ${ent.length}`].join('\n');
  }

  // traceroute from a router, or tracert from a PC: one line per routed hop.
  function trace(sim, d, dest) {
    const host = M.isHost(d);
    if (N.ip2n(dest) === null) return host ? `Unable to resolve target system name ${dest}.` : '% Unrecognized host or address, or protocol not running.';
    const r = S.ping(sim, d.id, dest);
    const hops = r.fwd && r.fwd.hops ? r.fwd.hops.slice(1) : [];
    const ips = hops.map((h, i) => (i === hops.length - 1 && r.ok ? dest : ((sim.byDev[h.devId] || []).find((x) => x.name === h.in) || {}).ip)).filter(Boolean);
    const lines = ips.map((ip, i) => (host ? `  ${String(i + 1).padStart(2)}   0 ms   0 ms   1 ms  ${ip}` : `  ${i + 1} ${ip} 0 msec 1 msec 0 msec`));
    if (!r.ok) {
      for (let i = 1; i <= 3; i++) lines.push(host ? `  ${String(ips.length + i).padStart(2)}     *        *        *     Request timed out.` : `  ${ips.length + i}  *  *  * `);
      lines.push(`% PatchLab: ${r.reason}`);
    }
    return host ? `\nTracing route to ${dest} over a maximum of 30 hops:\n\n${lines.join('\n')}${r.ok ? '\n\nTrace complete.' : ''}`
      : `Type escape sequence to abort.\nTracing the route to ${dest}\n${lines.join('\n')}`;
  }

  // ---------- Tab completion and ? help ----------

  const HOST_WORDS = ['arp', 'help', 'ipconfig', 'ipv6config', 'ping', 'tracert'];

  // The interface names a device has: its ports, plus the virtual ones it may create.
  function ifTypes(d) {
    const ports = MODELS[d.model].ports;
    const virt = [...(M.canRoute(d) ? ['Loopback'] : []), ...(M.isSwitch(d) ? ['Vlan'] : []), 'Port-channel'];
    return { ports, types: [...new Set([...ports.map((n) => /^[A-Za-z-]+/.exec(n)[0]), ...virt])] };
  }

  const common = (list) => list.reduce((a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return a.slice(0, i); });

  // "gig" becomes "GigabitEthernet0/" when every Gigabit port starts 0/; "g0/1" becomes
  // "GigabitEthernet0/1 " once it names one port. Returns null when nothing fits.
  function completeIf(frag, d) {
    const { ports, types } = ifTypes(d);
    const [, word, rest] = /^([A-Za-z-]*)(.*)$/.exec(frag);
    if (!word) return null;
    const hits = startsWith(types, word);
    if (hits.length !== 1) return null;
    const full = hits[0] + rest;
    const names = ports.filter((n) => n.startsWith(full));
    if (names.length === 1) return `${names[0]} `;
    return names.length ? common(names) : full;
  }

  // Tab completion for the last word, as IOS does it: a word that fits one keyword (or one
  // interface on this device) is written out in full; otherwise the line is left alone.
  function complete(mode, line, d) {
    mode = base(mode);
    if (d && M.isHost(d)) {
      const hits = /^\S*$/.test(line) ? startsWith(HOST_WORDS, line) : [];
      return hits.length === 1 ? `${hits[0]} ` : line;
    }
    const words = line.split(/\s+/);
    const last = words.pop();
    const typed = words.filter(Boolean);
    if (!last) return line;
    const exp = typed.length ? expand(mode, typed.join(' ')) : { line: '' };
    if (exp.error) return line;
    let prev = exp.line ? exp.line.split(' ') : [];
    const neg = prev[0] === 'no' && mode !== 'user' && mode !== 'priv';
    if (neg) prev = prev.slice(1);
    // "do" runs an exec command from configuration mode.
    if (prev[0] === 'do' && mode !== 'user' && mode !== 'priv') return `do ${complete('priv', line.replace(/^\s*\S+\s*/, ''), d)}`;
    const head = neg ? ['no', ...prev] : prev;
    const hits = startsWith(choices(mode, prev), last);
    if (hits.length === 1) return `${[...head, hits[0]].join(' ')} `;
    if (!hits.length && d && IF_WORDS.has(prev[prev.length - 1])) {
      const name = completeIf(last, d);
      if (name) return [...head, name].join(' ');
    }
    return line;
  }

  // What the last word could become, for listing on a second Tab: keywords, or this device's
  // interfaces ("GigabitEthernet0/" lists GigabitEthernet0/1 and GigabitEthernet0/2).
  function options(mode, line, d) {
    mode = base(mode);
    if (d && M.isHost(d)) return /^\S*$/.test(line) ? startsWith(HOST_WORDS, line) : [];
    const words = line.split(/\s+/);
    const last = words.pop();
    const typed = words.filter(Boolean);
    const exp = typed.length ? expand(mode, typed.join(' ')) : { line: '' };
    if (exp.error) return [];
    let prev = exp.line ? exp.line.split(' ') : [];
    if (prev[0] === 'no' && mode !== 'user' && mode !== 'priv') prev = prev.slice(1);
    if (prev[0] === 'do' && mode !== 'user' && mode !== 'priv') return options('priv', line.replace(/^\s*\S+\s*/, ''), d);
    const words2 = startsWith(choices(mode, prev), last || '').slice().sort();
    if (!d || !IF_WORDS.has(prev[prev.length - 1])) return words2;
    const { ports, types } = ifTypes(d);
    const [, word, rest] = /^([A-Za-z-]*)(.*)$/.exec(last || '');
    const kinds = startsWith(types, word);
    // A whole type name typed: list the ports that fit; otherwise list the types.
    if (kinds.length === 1 && (rest || word.length >= kinds[0].length)) {
      const full = kinds[0] + rest;
      const fit = ports.filter((n) => n.startsWith(full));
      return fit.length ? fit : [`${kinds[0]}<number>`];
    }
    return [...words2, ...kinds];
  }

  // "?" on its own lists what may come first; "show ?" what may follow show; "sh?" the words
  // starting sh.
  function help(mode, line, d) {
    mode = base(mode);
    const body = line.replace(/\?$/, '');
    const partial = !/(^|\s)$/.test(body);
    const words = body.trim().split(/\s+/).filter(Boolean);
    const last = partial ? words.pop() : '';
    const exp = words.length ? expand(mode, words.join(' ')) : { line: '' };
    if (exp.error) return exp.error;
    let prev = exp.line ? exp.line.split(' ') : [];
    if (prev[0] === 'no' && mode !== 'user' && mode !== 'priv') prev = prev.slice(1);
    if (prev[0] === 'do' && mode !== 'user' && mode !== 'priv') return help('priv', line.replace(/^\s*\S+\s*/, ''), d);
    let list = choices(mode, prev);
    if (d && IF_WORDS.has(prev[prev.length - 1])) list = [...(list || []), ...ifTypes(d).types];
    if (!list || !list.length) return prev.length ? '  <value>\n  <cr>' : '% Unrecognized command';
    const hits = startsWith(list, last);
    return hits.length ? hits.slice().sort().map((w) => `  ${w}`).join('\n') : '% Unrecognized command';
  }

  PL.practice = { expand, exec, promptFor, buildStudent, score, fixCommands, prompt, complete, options, serialize, applyLine, configText };
})(typeof window !== 'undefined' ? (window.PL = window.PL || {}) : (globalThis.PL = globalThis.PL || {}));
