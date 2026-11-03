// The step-by-step build guide and the printable answer sheet. Both reorder or present the
// generated configuration; neither invents commands of its own. No DOM.
(function (PL) {
  'use strict';

  const { MODELS, shortName, naturalCompare } = PL.catalog;
  const N = PL.net;
  const M = PL.model;
  const C = PL.configgen;
  const S = PL.simulate;

  // The order a student would type a device's configuration in, and how to check each step.
  const STEPS = [
    { id: 'base', title: 'Base settings' },
    { id: 'vlans', title: 'VLANs and spanning tree' },
    { id: 'trunks', title: 'Trunks and EtherChannel' },
    { id: 'access', title: 'Access ports' },
    { id: 'addressing', title: 'Interface addressing' },
    { id: 'redundancy', title: 'Gateway redundancy (HSRP)' },
    { id: 'routing', title: 'Routing' },
    { id: 'dhcp', title: 'DHCP' },
    { id: 'security', title: 'Port security and DHCP snooping' },
    { id: 'nat', title: 'NAT' },
    { id: 'acl', title: 'Access lists' },
    { id: 'ipv6', title: 'IPv6' },
    { id: 'remote', title: 'Console and remote access' },
  ];

  // Interface child lines that belong to a later step than the interface itself.
  const CHILD_STEP = [
    [/^ (ip access-group|access-class)/, 'acl'],
    [/^ ip helper-address/, 'dhcp'],
    [/^ standby /, 'redundancy'],
    [/^ (switchport port-security|ip dhcp snooping)/, 'security'],
    [/^ ip nat /, 'nat'],
    [/^ ipv6 /, 'ipv6'],
  ];

  function topStep(head) {
    if (/^(hostname|no ip domain-lookup|enable secret|service password|banner|ip domain-name)/.test(head)) return 'base';
    if (/^(vlan \d|spanning-tree)/.test(head)) return 'vlans';
    if (/^(ip routing$|ip default-gateway)/.test(head)) return 'addressing';
    if (/^(ip route |router )/.test(head)) return 'routing';
    if (/^ip dhcp (snooping)/.test(head) || /^no ip dhcp snooping/.test(head)) return 'security';
    if (/^ip dhcp /.test(head)) return 'dhcp';
    if (/^ip nat /.test(head)) return 'nat';
    if (/^(access-list|ip access-list)/.test(head)) return 'acl';
    if (/^(ipv6 |router ospfv3)/.test(head)) return 'ipv6';
    if (/^(line |username|crypto key|ip ssh)/.test(head)) return 'remote';
    return 'base';
  }

  function interfaceStep(head, kids) {
    if (/^interface range /.test(head)) return 'access';
    if (/^interface Port-channel/.test(head) || kids.some((k) => /^ (channel-group|switchport mode trunk)/.test(k))) return 'trunks';
    if (kids.some((k) => /^ switchport mode access/.test(k))) return 'access';
    return 'addressing';
  }

  // Splits generated CLI (no notes, not paste-ready) into top-level blocks.
  function blocks(text) {
    const out = [];
    text.split('\n').forEach((line) => {
      if (!line || line.startsWith('!')) return;
      if (line.startsWith(' ') && out.length) out[out.length - 1].kids.push(line);
      else out.push({ head: line, kids: [] });
    });
    return out;
  }

  function stepCommands(p, d, sim) {
    const text = C.generate(p, d, { paste: false, notes: false, sim });
    const by = {};
    const add = (step, lines) => { (by[step] = by[step] || []).push(...lines); };
    blocks(text).forEach((b) => {
      if (!b.head.startsWith('interface ')) return add(topStep(b.head), [b.head, ...b.kids]);
      const later = {};
      const own = [];
      b.kids.forEach((k) => {
        const hit = CHILD_STEP.find(([re]) => re.test(k));
        if (hit) (later[hit[1]] = later[hit[1]] || []).push(k);
        else own.push(k);
      });
      add(interfaceStep(b.head, own), [b.head, ...own]);
      Object.entries(later).forEach(([step, kids]) => add(step, [b.head, ...kids.filter((k) => !/^ description/.test(k))]));
    });
    return by;
  }

  const upLine = (name, ip) => `${shortName(name).padEnd(22)}${(ip || 'unassigned').padEnd(16)}up / up`;

  // The command to run after a step and what it should show if the step went in correctly.
  function checkpoint(p, d, sim, step) {
    const st = sim.rt[d.id] || {};
    const ifs = (sim.byDev[d.id] || []).filter((i) => i.ip && i.kind !== 'vip');
    switch (step) {
      case 'base': return { cmd: '', expect: [`The prompt changes to ${d.name}(config)#.`] };
      case 'vlans': {
        const v = M.vlansOnSwitch(p, d);
        return { cmd: 'show vlan brief', expect: v.length ? v.map((id) => `${id} ${(p.vlans.find((x) => x.id === id) || {}).name || ''} active`) : ['Only VLAN 1 and the 1002-1005 defaults.'] };
      }
      case 'trunks': {
        const out = [];
        const links = M.linksOf(p, d.id);
        links.filter((l) => l.mode === 'trunk' && !M.isL3End(p, l, d.id)).forEach((l) => {
          out.push(`${shortName(M.endIf(l, d.id))} trunking, native ${l.nativeVlan}, allowed ${l.allowed === 'all' ? '1-4094' : N.compressList(N.expandList(l.allowed))}`);
        });
        links.filter((l) => l.ec).forEach((l) => {
          const po = M.endIf(l, d.id);
          out.push(`${shortName(po)}(${M.isL3End(p, l, d.id) ? 'RU' : 'SU'}) with ${l.members.map((m) => `${shortName(m[M.side(l, d.id)])}(P)`).join(' ')}`);
        });
        const cmd = [links.some((l) => l.mode === 'trunk') ? 'show interfaces trunk' : '', links.some((l) => l.ec) ? 'show etherchannel summary' : ''].filter(Boolean).join(' ; ');
        return { cmd, expect: out };
      }
      case 'access': {
        const out = [];
        const vlans = {};
        M.linksOf(p, d.id).filter((l) => l.mode === 'access' && !M.isL3End(p, l, d.id)).forEach((l) => {
          (vlans[l.vlan] = vlans[l.vlan] || []).push(shortName(M.endIf(l, d.id)));
        });
        Object.entries(vlans).forEach(([v, ports]) => out.push(`VLAN ${v}: ${ports.sort(naturalCompare).join(', ')}`));
        return { cmd: 'show vlan brief', expect: out };
      }
      case 'addressing': return { cmd: 'show ip interface brief', expect: ifs.filter((i) => i.up).map((i) => upLine(i.name, i.ip)) };
      case 'redundancy': return { cmd: 'show standby brief', expect: (st.hsrp || []).map((h) => `${shortName(h.ifName)} grp ${h.group} ${h.state} virtual IP ${h.vip}`) };
      case 'routing': {
        const lines = S.showRoutes(sim, d).filter((r) => r.proto !== 'C' && r.proto !== 'L');
        const out = lines.map((r) => `${r.code} ${r.net}/${r.len}${r.nh ? ` via ${r.nh}` : ''}`);
        const extra = [];
        (st.ospfNbrs || []).filter((n) => n.ok).forEach((n) => extra.push(`OSPF neighbor ${n.rid} ${n.state}`));
        (st.bgpSessions || []).forEach((s) => extra.push(`BGP ${s.neighbor.ip} ${s.state}`));
        return { cmd: ['show ip route', (st.ospfNbrs || []).length ? 'show ip ospf neighbor' : '', d.routing.bgp.enabled ? 'show ip bgp summary' : ''].filter(Boolean).join(' ; '), expect: [...out, ...extra] };
      }
      case 'dhcp': {
        const leases = Object.entries(sim.leases).filter(([, l]) => l.ok && l.server === d.name).map(([id, l]) => `${l.ip} for ${M.dev(p, id).name}`);
        return { cmd: leases.length ? 'show ip dhcp binding' : 'show ip dhcp pool', expect: leases.length ? leases : d.dhcp.pools.map((x) => `Pool ${x.name}: ${x.network} ${x.mask}`) };
      }
      case 'security': return { cmd: 'show port-security ; show ip dhcp snooping', expect: ['Secure ports listed with their maximum; snooping enabled on the listed VLANs with trusted uplinks.'] };
      case 'nat': return { cmd: 'show ip nat translations', expect: ((st.natStatics) || []).map((s) => `${s.global} -> ${s.local} (static)`).concat(['PAT entries appear once inside hosts send traffic.']) };
      case 'acl': return { cmd: 'show access-lists ; show ip interface | include access list', expect: d.acls.map((a) => `${a.type === 'standard' ? 'Standard' : 'Extended'} IP access list ${a.name} with ${a.rules.filter((r) => r.remark === undefined).length} lines`) };
      case 'ipv6': return { cmd: 'show ipv6 interface brief ; show ipv6 route', expect: ((sim.v6 && sim.v6.byDev[d.id]) || []).filter((i) => i.up).map((i) => `${shortName(i.name)} ${i.addr}/${i.len}`) };
      case 'remote': return { cmd: 'copy running-config startup-config', expect: ['Building configuration... [OK]'] };
      default: return { cmd: '', expect: [] };
    }
  }

  // Switches first, then routers, then hosts: a VLAN must exist before a gateway on it can come up.
  function deviceOrder(p) {
    const rank = { l2switch: 0, l3switch: 1, router: 2, host: 3 };
    return p.devices.slice().sort((a, b) => rank[M.kindOf(a)] - rank[M.kindOf(b)] || naturalCompare(a.name, b.name));
  }

  function hostSteps(p, d, sim) {
    const c = d.ports.Ethernet0 || {};
    const lease = sim.leases[d.id];
    const gw = S.gatewayOf(sim, d);
    const cmds = d.ipMode === 'dhcp'
      ? ['Set the adapter to obtain an address automatically (DHCP).']
      : [`IP address ${c.ip || '(not set)'}`, `Subnet mask ${c.mask || '(not set)'}`, `Default gateway ${d.gateway || '(not set)'}`];
    return [{
      id: 'host', title: 'Network settings', commands: cmds, host: true,
      check: { cmd: gw ? `ping ${gw}` : 'ipconfig', expect: [d.ipMode === 'dhcp' ? (lease && lease.ok ? `Lease ${lease.ip} from ${lease.server}` : `No lease: ${lease ? lease.reason : 'not cabled'}`) : 'Replies from the gateway.'] },
    }];
  }

  function guide(p, sim) {
    return deviceOrder(p).map((d) => {
      if (M.isHost(d)) return { device: d, steps: hostSteps(p, d, sim) };
      const by = stepCommands(p, d, sim);
      const steps = STEPS.filter((s) => by[s.id]).map((s) => ({ id: s.id, title: s.title, commands: by[s.id], check: checkpoint(p, d, sim, s.id) }));
      return { device: d, steps };
    });
  }

  function guideText(p, sim) {
    const out = [`# Build guide: ${p.name}`, ''];
    guide(p, sim).forEach(({ device: d, steps }) => {
      out.push(`## ${d.name} (${MODELS[d.model].label})`, '');
      if (!M.isHost(d)) out.push('enable', 'configure terminal', '');
      steps.forEach((s, i) => {
        out.push(`### Step ${i + 1}: ${s.title}`, ...s.commands, '');
        if (s.check.cmd || s.check.expect.length) {
          out.push(`Check${s.check.cmd ? `: ${s.check.cmd}` : ''}${s.check.cmd && !M.isHost(d) ? ' (from privileged EXEC, or prefix with "do")' : ''}`);
          s.check.expect.forEach((e) => out.push(`  ${e}`));
          out.push('');
        }
      });
      if (!M.isHost(d)) out.push('end', 'write memory', '');
    });
    return out.join('\n');
  }

  // ---------- Answer sheet ----------

  const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function addressRows(p, sim) {
    const rows = [];
    deviceOrder(p).forEach((d) => {
      (sim.byDev[d.id] || []).filter((i) => i.ip && i.kind !== 'vip').forEach((i) => {
        const link = i.link && p.links.find((l) => l.id === i.link);
        const peer = link ? M.dev(p, M.peerOf(link, d.id)) : null;
        const lease = M.isHost(d) && sim.leases[d.id];
        rows.push({
          device: d.name, ifName: M.isHost(d) ? 'NIC' : shortName(i.name), ip: i.ip, mask: i.mask, len: i.len,
          gateway: M.isHost(d) ? S.gatewayOf(sim, d) || '' : '', vlan: i.vlan || (link && link.mode === 'access' ? link.vlan : ''),
          note: lease ? `DHCP from ${lease.server}` : peer ? `to ${peer.name}` : i.kind === 'loopback' ? 'loopback' : '',
        });
      });
    });
    return rows;
  }

  function answerSheet(p, sim, svg, issues) {
    const errs = (issues || []).filter((i) => i.sev === 'error');
    const date = new Date().toISOString().slice(0, 10);
    const rows = addressRows(p, sim);
    const vlans = p.vlans.map((v) => `<tr><td>${v.id}</td><td>${esc(v.name)}</td><td>${v.subnet ? `${esc(v.subnet)}/${N.maskToLen(v.mask)}` : ''}</td></tr>`).join('');
    const addr = rows.map((r) => `<tr><td>${esc(r.device)}</td><td>${esc(r.ifName)}</td><td>${esc(r.ip)}</td><td>${esc(r.mask)} (/${r.len})</td><td>${esc(r.gateway)}</td><td>${esc(r.vlan)}</td><td>${esc(r.note)}</td></tr>`).join('');
    const m = S.matrix(sim);
    const pairs = m.rows.flat().filter(Boolean);
    const configs = deviceOrder(p).map((d) => `<section class="cfg"><h3>${esc(d.name)} <small>${esc(MODELS[d.model].label)}</small></h3><pre>${esc(C.generate(p, d, { paste: true, notes: false, sim }))}</pre></section>`).join('');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(p.name)}: answer sheet</title>
<style>
body{font:13px/1.45 "Helvetica Neue",Arial,sans-serif;color:#15211f;margin:24px;max-width:1000px}
h1{font-size:22px;margin:0 0 2px}h2{font-size:16px;margin:22px 0 6px;border-bottom:1px solid #cfd8d5;padding-bottom:3px}
h3{font-size:14px;margin:14px 0 4px}h3 small{font-weight:400;color:#5a6b67}.meta{color:#5a6b67;margin:0 0 12px}
table{border-collapse:collapse;width:100%;font-size:12px}th,td{border:1px solid #cfd8d5;padding:3px 6px;text-align:left;vertical-align:top}
th{background:#f1f4f3}td:nth-child(3),td:nth-child(4),td:nth-child(5){font-family:Menlo,Consolas,monospace}
pre{font:11px/1.35 Menlo,Consolas,monospace;background:#f5f7f6;border:1px solid #cfd8d5;padding:8px;white-space:pre-wrap;margin:0}
.topo svg{max-width:100%;height:auto;border:1px solid #cfd8d5}.cols{columns:2;column-gap:16px}.cfg{break-inside:avoid-page}
.ok{color:#14794f}.bad{color:#bb2d24}
@media print{body{margin:0}.cfg{break-inside:auto}h2{break-after:avoid}}
</style></head><body>
<h1>${esc(p.name)}</h1><p class="meta">Answer sheet generated by PatchLab on ${date}. ${p.devices.length} devices, ${p.links.length} cables.
${errs.length ? `<span class="bad">${errs.length} blocking problem${errs.length > 1 ? 's' : ''} remain.</span>` : '<span class="ok">No blocking problems.</span>'}
${pairs.length ? ` Hosts reach each other in ${pairs.filter((c) => c.ok).length} of ${pairs.length} pairs.` : ''}</p>
<h2>Topology</h2><div class="topo">${svg || ''}</div>
<h2>VLANs</h2><table><thead><tr><th>ID</th><th>Name</th><th>Subnet</th></tr></thead><tbody>${vlans}</tbody></table>
<h2>Addressing</h2><table><thead><tr><th>Device</th><th>Interface</th><th>Address</th><th>Mask</th><th>Gateway</th><th>VLAN</th><th>Notes</th></tr></thead><tbody>${addr}</tbody></table>
<h2>Configurations</h2>${configs}
</body></html>`;
  }

  PL.guide = { guide, guideText, answerSheet, addressRows, STEPS };
})(typeof window !== 'undefined' ? (window.PL = window.PL || {}) : (globalThis.PL = globalThis.PL || {}));
