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
    user: ['enable', 'exit', 'ping', 'show', 'traceroute'],
    priv: ['configure', 'copy', 'disable', 'end', 'exit', 'ping', 'show', 'write', 'traceroute'],
    config: ['access-list', 'banner', 'do', 'enable', 'end', 'exit', 'hostname', 'interface', 'ip', 'ipv6', 'line', 'no', 'router', 'service', 'spanning-tree', 'username', 'vlan', 'crypto'],
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
    configure: ['terminal'], write: ['memory'], copy: ['running-config', 'startup-config'],
    show: ['access-lists', 'etherchannel', 'interfaces', 'ip', 'ipv6', 'running-config', 'spanning-tree', 'standby', 'startup-config', 'version', 'vlan'],
    'show ip': ['access-lists', 'bgp', 'dhcp', 'interface', 'nat', 'ospf', 'protocols', 'route'],
    'show ip interface': ['brief'], 'show ip ospf': ['neighbor', 'interface'], 'show ip dhcp': ['binding', 'pool', 'snooping'],
    'show ip nat': ['translations'], 'show ip bgp': ['summary'], 'show vlan': ['brief'], 'show interfaces': ['trunk', 'status'],
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
  };

  // Real IOS commands outside what PatchLab models: accepted as valid but not applied.
  const NOT_SIMULATED = /^(no )?(snmp-server|ntp|logging|cdp|clock|lldp|vtp|aaa|archive|errdisable|mls|power|boot|license|monitor|privilege|alias|key|track|object-group|class-map|policy-map|ip sla|ip ftp|ip tftp|ip scp|ip name-server|security|login|memory|vrf|udld|storm-control|speed|duplex|mdix|cdp|lldp|keepalive|bandwidth|delay|mtu|ip mtu|ip ospf|ip split-horizon|ip summary-address|ip rip|ip pim|ip igmp|ip verify|ip arp|arp|mac|exec-timeout)\b/i;

  const IF_WORDS = new Set(['interface', 'passive-interface', 'update-source']);

  // Expands IOS abbreviations: "conf t", "int g0/1", "sh ip int br", "no shut".
  function expand(mode, line) {
    const words = line.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return { line: '' };
    const sub = mode === 'config-if' || mode === 'config-subif';
    const out = [];
    let negate = false;
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const lw = w.toLowerCase();
      let list;
      const prev = out.slice(negate ? 1 : 0);
      if (!prev.length) list = mode === 'priv' && negate ? [] : FIRST[mode];
      else {
        const phrase = prev.join(' ');
        const scoped = `${sub ? 'if' : 'config'} ${phrase}`;
        list = NEXT[scoped] || NEXT[phrase] || null;
        if (!list && prev[0] === 'show') list = null;
      }
      if (i === 0 && lw === 'no' && mode !== 'user' && mode !== 'priv') {
        out.push('no');
        negate = true;
        continue;
      }
      if (prev.length && IF_WORDS.has(prev[prev.length - 1]) && /\d/.test(w)) {
        out.push(IMP.ifName(w));
        continue;
      }
      if (prev.length >= 2 && prev[prev.length - 1] === 'interface' && /^[a-z-]+$/i.test(w) && words[i + 1] && /^\d/.test(words[i + 1])) {
        out.push(IMP.ifName(w + words[i + 1]));
        i++;
        continue;
      }
      if (!list || !list.length) {
        out.push(w);
        continue;
      }
      const exact = list.find((x) => x.toLowerCase() === lw);
      const hits = exact ? [exact] : list.filter((x) => x.toLowerCase().startsWith(lw));
      if (hits.length === 1) out.push(hits[0]);
      else if (hits.length > 1) return { error: `% Ambiguous command:  "${line.trim()}"` };
      else if (!prev.length) return { error: invalid(line, w) };
      else out.push(w);
    }
    // "interface g0/1" style names after the first word.
    if (out[0] === 'interface' || (out[0] === 'no' && out[1] === 'interface')) {
      const at = out[0] === 'no' ? 2 : 1;
      if (out[at]) out.splice(at, out.length - at, IMP.ifName(out.slice(at).join('')));
    }
    return { line: out.join(' ') };
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

  // The prompt for a device: its typed hostname, or the factory "Router"/"Switch".
  function promptFor(ctx, devId) {
    const d = M.dev(ctx.target, devId);
    if (M.isHost(d)) return 'C:\\>';
    const dev = ctx.practice.devices[devId];
    const hn = dev && dev.blocks.find((b) => /^hostname /.test(b.head));
    const name = hn ? hn.head.slice(9) : M.isRouter(d) ? 'Router' : 'Switch';
    return prompt(name, ctx.session.mode, false);
  }

  const help = (mode) => (FIRST[mode] || []).map((w) => `  ${w}`).join('\n');

  // Runs one line on a device. `ctx` carries the target and practice state plus the per-device
  // session ({ mode, cur }); the practice state is updated in place when configuration changes.
  function exec(ctx, devId, raw) {
    const target = ctx.target;
    const d = M.dev(target, devId);
    const ses = ctx.session;
    const store = ctx.practice;
    if (M.isHost(d)) return hostExec(ctx, d, raw);
    store.devices[devId] = store.devices[devId] || blank();
    const dev = store.devices[devId];
    const line = raw.trim();
    if (!line) return { out: '' };
    if (line === '?' || line.endsWith(' ?')) return { out: help(ses.mode) };
    const mode = ses.mode;
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
        }
      }
    }
    if (exp.error) return { out: cfgMode && NOT_SIMULATED.test(line) ? '% PatchLab does not simulate this command, so it was not applied.' : exp.error };
    const cmd = exp.line;

    if (cfgMode && /^do /.test(cmd)) {
      const inner = expand('priv', cmd.slice(3));
      if (inner.error) return { out: inner.error };
      return execShow(ctx, d, inner.line);
    }
    if (cmd === 'end' && cfgMode) { ses.mode = 'priv'; ses.cur = null; return { out: '' }; }
    if (cmd === 'exit') {
      if (mode === 'config') { ses.mode = 'priv'; return { out: '' }; }
      if (cfgMode) { ses.mode = 'config'; ses.cur = null; return { out: '' }; }
      ses.mode = 'user';
      return { out: '' };
    }
    if (mode === 'user') {
      if (cmd === 'enable') { ses.mode = 'priv'; return { out: '' }; }
      if (/^(show|ping|traceroute)\b/.test(cmd)) return execShow(ctx, d, cmd);
      return { out: invalid(line, line.split(/\s+/)[0]) };
    }
    if (mode === 'priv') {
      if (cmd === 'disable') { ses.mode = 'user'; return { out: '' }; }
      if (cmd === 'configure terminal' || cmd === 'configure') { ses.mode = 'config'; ses.cur = null; return { out: 'Enter configuration commands, one per line.  End with CNTL/Z.' }; }
      if (/^(write memory|write|copy running-config startup-config)$/.test(cmd)) return { out: 'Building configuration...\n[OK]' };
      return execShow(ctx, d, cmd);
    }
    const check = validateInterface(target, d, cmd);
    if (check) return { out: check };
    const res = applyLine(dev.blocks, ses.cur, ses.mode, cmd);
    // The importer is the arbiter of what PatchLab understands.
    const ser = serialize(res.blocks);
    const parsed = IMP.parse(ser.text);
    const bad = parsed.skipped.find((x) => {
      const [bi, ki] = ser.where[x.n - 1];
      const b = res.blocks[bi];
      return (ki < 0 ? b.head : b.kids[ki]) === cmd.replace(/^no /, '') || (ki < 0 ? b.head : b.kids[ki]) === cmd;
    });
    if (bad) return { out: NOT_SIMULATED.test(cmd) ? '% PatchLab does not simulate this command, so it was not applied.' : '% Invalid input, or a command PatchLab does not simulate. Nothing was applied.' };
    dev.blocks = res.blocks;
    ses.mode = res.mode;
    ses.cur = res.cur;
    return { out: '', changed: true };
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
    if (/^(help|\?)$/i.test(line)) return { out: 'ipconfig                       show the address\nipconfig <ip> <mask> [gateway] set a static address\nipconfig /dhcp                 get an address by DHCP\nipv6config auto                use SLAAC\nipv6config <addr/len> <gw>     set a static IPv6 address\nping <address>' };
    if (/^ipconfig$/i.test(line)) {
      const sim = S.simulate(buildStudent(ctx.target, store));
      const lease = sim.leases[d.id];
      const v6 = sim.v6 && sim.v6.hosts[d.id];
      const four = h.mode === 'dhcp' ? (lease && lease.ok ? [lease.ip, lease.mask, lease.gateway] : ['0.0.0.0', '0.0.0.0', '0.0.0.0']) : [h.ip || '0.0.0.0', h.mask || '0.0.0.0', h.gateway || '0.0.0.0'];
      return { out: `FastEthernet0 Connection:${h.mode === 'dhcp' ? ' (DHCP)' : ''}\n   IPv6 Address....................: ${v6 && v6.ok ? v6.addr : '::'}\n   IPv4 Address....................: ${four[0]}\n   Subnet Mask.....................: ${four[1]}\n   Default Gateway.................: ${four[2]}${h.mode === 'dhcp' && lease && !lease.ok ? `\n\nDHCP request failed. ${lease.reason}` : ''}` };
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
    return { out: `Invalid Command. Type help for the list.` };
  }

  // ---------- show and ping ----------

  // "show run | include route": run the command, then filter its lines as IOS does.
  function execShow(ctx, d, cmd) {
    const pipe = /^(.*?)\s*\|\s*(i|in|inc|incl|include|e|ex|exclude|s|sec|section|b|be|begin)\w*\s+(.+)$/i.exec(cmd);
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
    if (M.isHost(d)) return { out: 'Invalid Command.' };
    if (/^show (running-config|startup-config)$/.test(cmd)) {
      return { out: `Building configuration...\n\nCurrent configuration:\n!\n${C.generate(student, sd, { paste: false, notes: false, sim }).split('\n').filter((l) => !/^! /.test(l)).join('\n')}\n!\nend` };
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
    if (/^show ip route/.test(cmd)) {
      if (!M.canRoute(sd)) return { out: 'Default gateway is ' + (sd.gateway || 'not set') };
      const lines = S.showRoutes(sim, sd);
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
    if (/^show /.test(cmd)) return { out: '% PatchLab does not simulate this show command.' };
    return { out: invalid(cmd, cmd.split(' ')[0]) };
  }

  // Tab completion for the last word.
  function complete(mode, line) {
    const words = line.split(/\s+/);
    const last = words.pop();
    const typed = words.filter(Boolean);
    const exp = typed.length ? expand(mode, typed.join(' ')) : { line: '' };
    if (exp.error) return line;
    const prev = exp.line ? exp.line.split(' ').filter((w) => w !== 'no' || typed[0] !== 'no') : [];
    const sub = mode === 'config-if' || mode === 'config-subif';
    const list = !prev.length ? FIRST[mode] : NEXT[`${sub ? 'if' : 'config'} ${prev.join(' ')}`] || NEXT[prev.join(' ')] || [];
    const hits = (list || []).filter((x) => x.toLowerCase().startsWith((last || '').toLowerCase()));
    const head = typed[0] === 'no' ? ['no', ...prev] : prev;
    return hits.length === 1 ? `${[...head, hits[0]].join(' ')} ` : line;
  }

  PL.practice = { expand, exec, promptFor, buildStudent, score, fixCommands, prompt, complete, serialize, applyLine };
})(typeof window !== 'undefined' ? (window.PL = window.PL || {}) : (globalThis.PL = globalThis.PL || {}));
