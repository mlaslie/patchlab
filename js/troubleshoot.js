// The troubleshooting assistant. It reads a plain-English question ("why can't PC1 ping PC2?"),
// runs the matching test against the lab, and answers with the most likely cause in words,
// more detail on request, and the commands that fix it on each device. Rule based, no network
// calls, so it works offline and on Cloud Run alike. No DOM.
(function (PL) {
  'use strict';

  const { shortName } = PL.catalog;
  const N = PL.net;
  const M = PL.model;
  const S = PL.simulate;

  const SERVICES = [
    [/\bhttps\b/, 'tcp', 443, 'HTTPS'], [/\b(http|web|www|browse|website)\b/, 'tcp', 80, 'HTTP'], [/\bssh\b/, 'tcp', 22, 'SSH'],
    [/\btelnet\b/, 'tcp', 23, 'Telnet'], [/\b(dns|domain)\b/, 'udp', 53, 'DNS'], [/\bftp\b/, 'tcp', 21, 'FTP'], [/\b(smtp|mail)\b/, 'tcp', 25, 'SMTP'],
  ];

  const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sn = shortName;
  const maskOf = (len) => N.lenToMask(len);

  // ---------- Reading the question ----------

  function parseQuestion(p, text) {
    const raw = String(text || '');
    const t = ` ${raw.toLowerCase().replace(/[?!,;]/g, ' ')} `;
    const mentions = [];
    p.devices.slice().sort((a, b) => b.name.length - a.name.length).forEach((d) => {
      // "pc 1", "PC-1" and "pc1" all name PC1.
      const pat = esc(d.name.toLowerCase()).replace(/([a-z])(\d)/g, '$1[\\s-]*$2');
      const re = new RegExp(`(^|[^a-z0-9])(${pat})(?![a-z0-9])`, 'g');
      let m;
      while ((m = re.exec(t))) {
        const at = m.index + m[1].length;
        if (!mentions.some((x) => at >= x.at && at < x.at + x.len)) mentions.push({ at, len: m[2].length, dev: d });
      }
    });
    let m;
    const v4 = /(^|[^\d.])(\d{1,3}(?:\.\d{1,3}){3})(?![\d.])/g;
    while ((m = v4.exec(t))) if (N.ip2n(m[2]) !== null) mentions.push({ at: m.index + m[1].length, len: m[2].length, ip: m[2] });
    const v6 = /(^|\s)([0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7})(?=\s)/g;
    while ((m = v6.exec(t))) if (PL.ipv6.parse(m[2]) !== null) mentions.push({ at: m.index + m[1].length, len: m[2].length, ip: m[2] });
    mentions.sort((a, b) => a.at - b.at);
    const svc = SERVICES.find(([re]) => re.test(t));
    const port = /\bport (\d{1,5})\b/.exec(t);
    const service = port ? { proto: /\budp\b/.test(t) ? 'udp' : 'tcp', port: +port[1], label: `port ${port[1]}` } : svc ? { proto: svc[1], port: svc[2], label: svc[3] } : null;
    const q = { text: raw.trim(), mentions, service };
    if (/\b(ospf|neighbou?rs?|adjacenc|adjacent)\b/.test(t)) q.kind = 'ospf';
    else if (/\b(dhcp|lease|get an? (ip|address)|no (ip|address)|address from|ip address|addressing|apipa|169\.254)\b/.test(t) && mentions.filter((x) => x.dev).length <= 1 && !/\bping\b/.test(t)) q.kind = 'dhcp';
    else if (mentions.length >= 2 || /\b(ping|reach|talk|connect|communicat|get to|access|traffic|load|open)\b/.test(t)) q.kind = 'ping';
    else if (/\b(wrong|problem|issue|error|broken|fix|check|work)\b/.test(t)) q.kind = 'general';
    else q.kind = 'unknown';
    return q;
  }

  // ---------- Helpers over the simulated lab ----------

  const ifacesOf = (sim, d) => (sim.byDev[d.id] || []).filter((i) => i.ip && i.kind !== 'vip');
  const addrOf = (sim, d) => (ifacesOf(sim, d)[0] || {}).ip || '';
  const ownerOf = (sim, ip) => sim.ifaces.find((i) => i.ip === ip) || sim.vips.find((i) => i.ip === ip);
  const linkOf = (p, i) => i && i.link && p.links.find((l) => l.id === i.link);

  // Where a host's settings are typed: the CLI lab uses ipconfig; the designer, the host panel.
  function hostLine(ctx, d, ip, mask, gw) {
    if (ctx.cli) return `ipconfig ${ip} ${mask}${gw ? ` ${gw}` : ''}`;
    return `Address ${ip}, mask ${mask}${gw ? `, default gateway ${gw}` : ''}`;
  }

  // Interfaces in each broadcast domain whose mask or subnet disagrees with the majority.
  function segmentOutliers(sim) {
    const groups = {};
    sim.ifaces.filter((i) => i.ip && i.domain && i.kind !== 'loopback' && i.kind !== 'vip').forEach((i) => { (groups[i.domain] = groups[i.domain] || []).push(i); });
    const out = [];
    Object.values(groups).forEach((list) => {
      if (list.length < 3) {
        // With two devices there is no majority; prefer the router's view of the subnet.
        if (list.length === 2 && list[0].len !== list[1].len) {
          // Two routers: point-to-point links are normally the longer prefix. Router and host: trust the router.
          const r = list.every((i) => M.canRoute(i.dev)) ? (list[0].len > list[1].len ? list[0] : list[1]) : list.find((i) => M.canRoute(i.dev)) || list[0];
          const o = list.find((i) => i !== r);
          out.push({ iface: o, kind: 'mask', have: o.len, want: r.len, wantNet: r.net, by: [r] });
        }
        return;
      }
      const count = (key) => {
        const c = {};
        list.forEach((i) => { c[key(i)] = (c[key(i)] || 0) + 1; });
        return Object.entries(c).sort((a, b) => b[1] - a[1]);
      };
      const lens = count((i) => i.len);
      if (lens.length > 1 && lens[0][1] > lens[1][1]) {
        const want = +lens[0][0];
        list.filter((i) => i.len !== want).forEach((i) => out.push({ iface: i, kind: 'mask', have: i.len, want, by: list.filter((x) => x.len === want) }));
      }
      const nets = count((i) => `${N.network(i.ip, maskOf(Math.min(...list.map((x) => x.len))))}`);
      if (nets.length > 1 && nets[0][1] > nets[1][1]) {
        const wantLen = +lens[0][0];
        const majority = list.find((i) => N.network(i.ip, maskOf(Math.min(...list.map((x) => x.len)))) === nets[0][0]);
        list.filter((i) => !N.inNet(i.ip, majority.ip, maskOf(wantLen)) && i.len === wantLen).forEach((i) => out.push({ iface: i, kind: 'subnet', want: wantLen, wantNet: N.network(majority.ip, maskOf(wantLen)), by: [majority] }));
      }
    });
    return out;
  }

  function outlierText(o) {
    const i = o.iface;
    const who = M.isHost(i.dev) ? i.dev.name : `${i.dev.name} interface ${sn(i.name)}`;
    if (o.kind === 'mask') {
      return `The mask on ${who} is /${o.have} (${maskOf(o.have)}), but ${o.by.length > 1 ? 'the other devices on that segment use' : `${o.by[0].dev.name} uses`} /${o.want} (${maskOf(o.want)}).`;
    }
    return `${who} has ${i.ip}, which is outside ${o.wantNet}/${o.want}, the subnet everything else on that segment uses.`;
  }

  function outlierFix(ctx, o) {
    const i = o.iface;
    const mask = maskOf(o.want);
    let ip = i.ip;
    if (o.kind === 'subnet') {
      const hostPart = (N.ip2n(i.ip) & ~N.ip2n(mask)) >>> 0;
      ip = N.n2ip((N.ip2n(o.wantNet) + hostPart) >>> 0);
    }
    if (M.isHost(i.dev)) return { device: i.dev.name, lines: [hostLine(ctx, i.dev, ip, mask, i.dev.gateway)], host: true };
    return { device: i.dev.name, lines: [`interface ${i.name}`, ` ip address ${ip} ${mask}`] };
  }

  // The VLAN an interface puts its frames in, seen from the switch it plugs into.
  function vlanOf(p, i) {
    if (i.vlan) return { vlan: i.vlan };
    const l = linkOf(p, i);
    if (!l) return {};
    const peer = M.dev(p, M.peerOf(l, i.devId));
    if (!M.isSwitch(peer) || M.isL3End(p, l, peer.id)) return {};
    if (l.mode === 'access') return { vlan: l.vlan, sw: peer, port: M.endIf(l, peer.id), link: l };
    if (l.mode === 'trunk') return { vlan: l.nativeVlan, sw: peer, port: M.endIf(l, peer.id), link: l, trunk: true };
    return {};
  }

  // Shortest chain of cables from one device to another that only passes through switches.
  function cablePath(p, fromId, toId) {
    const prev = { [fromId]: null };
    const queue = [fromId];
    while (queue.length) {
      const cur = queue.shift();
      if (cur === toId) break;
      if (cur !== fromId && !M.isSwitch(M.dev(p, cur))) continue;
      M.linksOf(p, cur).forEach((l) => {
        const nb = M.peerOf(l, cur);
        if (!(nb in prev)) {
          prev[nb] = { from: cur, link: l };
          queue.push(nb);
        }
      });
    }
    if (!(toId in prev)) return null;
    const out = [];
    for (let k = toId; prev[k]; k = prev[k].from) out.unshift({ from: prev[k].from, to: k, link: prev[k].link });
    return out;
  }

  // Why two interfaces that should share a segment do not.
  function layer2(ctx, egress, owner) {
    const p = ctx.p;
    const a = vlanOf(p, egress);
    const b = vlanOf(p, owner);
    const who = (i) => (M.isHost(i.dev) ? i.dev.name : `${i.dev.name} ${sn(i.name)}`);
    if (a.vlan && b.vlan && a.vlan !== b.vlan) {
      const fixSide = M.isHost(egress.dev) && a.sw ? a : M.isHost(owner.dev) && b.sw ? b : a.sw ? a : b;
      const want = fixSide === a ? b.vlan : a.vlan;
      const res = {
        text: `${who(egress)} is in VLAN ${a.vlan}${a.sw ? ` (${a.sw.name} ${sn(a.port)})` : ''}, but ${who(owner)} is in VLAN ${b.vlan}${b.sw ? ` (${b.sw.name} ${sn(b.port)})` : ''}, so they never hear each other's ARP.`,
        devs: [a.sw, b.sw].filter(Boolean).map((d) => d.id),
        fixes: [],
        checks: ['show vlan brief', 'show interfaces trunk'],
      };
      if (fixSide.sw && !fixSide.trunk) res.fixes.push({ device: fixSide.sw.name, lines: [`interface ${fixSide.port}`, ` switchport access vlan ${want}`] });
      return res;
    }
    const vlan = a.vlan || b.vlan || 1;
    const path = cablePath(p, egress.devId, owner.devId);
    if (!path) return { text: `There is no chain of switches between ${who(egress)} and ${who(owner)}. Check the cabling.`, fixes: [], checks: ['show cdp neighbors'] };
    for (const step of path) {
      const l = step.link;
      const ends = [l.a, l.b].map((id) => ({ d: M.dev(p, id), name: M.endIf(l, id) }));
      const shut = ends.find((e) => M.port(e.d, e.name).shutdown);
      if (shut) return { text: `${shut.d.name} ${sn(shut.name)} is shut down, so the cable to ${ends.find((e) => e !== shut).d.name} carries nothing.`, devs: [shut.d.id], fixes: [{ device: shut.d.name, lines: [`interface ${shut.name}`, ' no shutdown'] }], checks: ['show ip interface brief'] };
      if (ctx.sim.down.has(l.id)) {
        const ps = ctx.sim.portSec.find((x) => x.linkId === l.id);
        if (ps) return portSec(ctx, ps);
      }
      const bothSwitches = ends.every((e) => M.isSwitch(e.d) && !M.isL3End(p, l, e.d.id));
      const routerEnd = ends.find((e) => M.canRoute(e.d) && (!M.isSwitch(e.d) || M.isL3End(p, l, e.d.id)));
      const swEnd = ends.find((e) => e !== routerEnd);
      if (routerEnd && swEnd && M.isSwitch(swEnd.d) && vlan !== 1 && (egress.vlan || owner.vlan) && l.mode === 'access') {
        return { text: `${swEnd.d.name} ${sn(swEnd.name)} faces the router-on-a-stick link to ${routerEnd.d.name} but is an access port. Sub-interfaces need a trunk.`, devs: [swEnd.d.id],
          fixes: [{ device: swEnd.d.name, lines: [`interface ${swEnd.name}`, ' switchport mode trunk'] }], checks: ['show interfaces trunk'] };
      }
      if (bothSwitches && l.mode === 'access' && l.vlan !== vlan) {
        return { text: `The cable between ${ends[0].d.name} and ${ends[1].d.name} is an access port in VLAN ${l.vlan}, so VLAN ${vlan} cannot cross it. It should be a trunk.`, devs: ends.map((e) => e.d.id),
          fixes: ends.map((e) => ({ device: e.d.name, lines: [`interface ${e.name}`, ' switchport mode trunk'] })), checks: ['show interfaces trunk'] };
      }
      if (l.mode === 'trunk' && !M.allowedVlans(p, l).includes(vlan)) {
        return { text: `The trunk between ${ends[0].d.name} and ${ends[1].d.name} does not allow VLAN ${vlan}.`, devs: ends.map((e) => e.d.id),
          fixes: ends.filter((e) => M.isSwitch(e.d)).map((e) => ({ device: e.d.name, lines: [`interface ${e.name}`, ` switchport trunk allowed vlan add ${vlan}`] })), checks: ['show interfaces trunk'] };
      }
    }
    const note = (p.practiceNotes || []).find((x) => new RegExp(`VLAN ${vlan}\\b`).test(x));
    if (note) {
      const sw = p.devices.find((d) => note.startsWith(`${d.name} `));
      return { text: note, devs: sw ? [sw.id] : [], fixes: sw ? [{ device: sw.name, lines: [`vlan ${vlan}`] }] : [], checks: ['show vlan brief'] };
    }
    return { text: `${who(egress)} and ${who(owner)} should share VLAN ${vlan}, but no switch path carries it between them.`, fixes: [], checks: ['show vlan brief', 'show interfaces trunk'] };
  }

  function portSec(ctx, ps) {
    const sw = M.dev(ctx.p, ps.devId);
    return {
      text: `Port security on ${sw.name} ${sn(ps.ifName)} allows ${ps.max} MAC address${ps.max > 1 ? 'es' : ''} but sees ${ps.count} (${ps.hosts.join(', ')}), so ${ps.violation === 'shutdown' ? 'it err-disabled the port' : 'it drops the extra devices'}.`,
      devs: [sw.id], checks: ['show port-security interface', 'show interfaces status err-disabled'],
      fixes: [{ device: sw.name, lines: [`interface ${ps.ifName}`, ` switchport port-security maximum ${ps.count}`, ...(ps.violation === 'shutdown' ? [' shutdown', ' no shutdown'] : [])] }],
    };
  }

  function downIface(ctx, i) {
    const p = ctx.p;
    const l = linkOf(p, i);
    if (!l) return { text: `${i.dev.name} ${sn(i.name)} has no cable.`, fixes: [], checks: [] };
    if (ctx.sim.down.has(l.id)) {
      const ps = ctx.sim.portSec.find((x) => x.linkId === l.id);
      if (ps) return portSec(ctx, ps);
    }
    const ends = [l.a, l.b].map((id) => ({ d: M.dev(p, id), name: M.endIf(l, id) }));
    const shut = ends.filter((e) => M.port(e.d, e.name).shutdown);
    if (shut.length) {
      return {
        text: `${shut.map((e) => `${e.d.name} ${sn(e.name)}`).join(' and ')} ${shut.length > 1 ? 'are' : 'is'} administratively down${shut.some((e) => M.isRouter(e.d)) ? '. Router interfaces stay shut until you type "no shutdown"' : ''}.`,
        devs: shut.map((e) => e.d.id), checks: ['show ip interface brief'],
        fixes: shut.map((e) => ({ device: e.d.name, lines: [`interface ${e.name}`, ' no shutdown'] })),
      };
    }
    return { text: `${i.dev.name} ${sn(i.name)} is down.`, fixes: [], checks: ['show ip interface brief'] };
  }

  // A permit line, placed just above the line that dropped the traffic.
  function aclFix(ctx, dev, cause) {
    const acl = dev.acls.find((a) => a.name === cause.acl);
    if (!acl) return [];
    const pk = cause.pkt;
    const seq = cause.implicit ? (acl.rules.length + 1) * 10 : cause.line * 10 - 5;
    const ports = (pk.proto === 'tcp' || pk.proto === 'udp') && pk.dport ? ` eq ${pk.dport}` : '';
    const echo = pk.proto === 'icmp' && pk.icmp ? ` ${pk.icmp}` : '';
    const rule = acl.type === 'standard' ? `permit host ${pk.src}` : `permit ${pk.proto === 'icmp' ? 'icmp' : pk.proto} host ${pk.src} host ${pk.dst}${ports}${echo}`;
    return [{ device: dev.name, lines: [`ip access-list ${acl.type} ${acl.name}`, ` ${seq} ${rule}`] }];
  }

  // ---------- Explaining one failed hop ----------

  function explain(ctx, hop, leg, pkt) {
    const p = ctx.p;
    const sim = ctx.sim;
    const dev = M.dev(p, hop.devId);
    const c = hop.cause || {};
    if (c.code === 'acl') {
      const what = c.implicit ? `the implicit "deny any" at the end of ACL ${c.acl}` : `line ${c.line} of ACL ${c.acl}`;
      return {
        text: `${dev.name} drops it with ${what}, applied ${c.dir === 'in' ? 'inbound' : 'outbound'} on ${sn(c.ifName)}. If that block is intended, the lab is working as designed.`,
        devs: [dev.id], fixes: aclFix(ctx, dev, c), checks: [`show access-lists ${c.acl}`, `show ip interface ${sn(c.ifName)} | include access list`],
      };
    }
    if (c.code === 'portsec') return portSec(ctx, c.entry);
    if (c.code === 'noaddr') return { text: `${dev.name} has no IP address.`, devs: [dev.id], fixes: [], checks: ['ipconfig'] };
    if (c.code === 'down') return downIface(ctx, c.iface);
    if (c.code === 'notrouter') {
      return { text: `${dev.name} received the packet but it does not route, so whoever sent it there has the wrong gateway or next hop.`, devs: [dev.id], fixes: [], checks: ['ipconfig', 'show ip route'] };
    }
    if (c.code === 'loop') {
      const names = [...new Set(leg.hops.slice(-6).map((h) => h.dev))];
      return { text: `The packet loops between ${names.join(' and ')} until its TTL runs out. Their routes point at each other.`, devs: leg.hops.slice(-6).map((h) => h.devId), fixes: [], checks: ['show ip route'] };
    }
    if (c.code === 'nogw') {
      const gw = gatewayFor(sim, c.iface);
      return {
        text: `${dev.name} has no default gateway, so it can only reach its own subnet.${gw ? ` The router on its segment is ${gw.label} (${gw.ip}).` : ''}`,
        devs: [dev.id], fixes: gw ? [{ device: dev.name, lines: [hostLine(ctx, dev, c.iface.ip, c.iface.mask, gw.ip)], host: true }] : [], checks: ['ipconfig'],
      };
    }
    if (c.code === 'noroute') return noRoute(ctx, dev, c);
    if (c.code === 'arp') return arp(ctx, dev, c);
    return { text: hop.fail || leg.reason, devs: [dev.id], fixes: [], checks: [] };
  }

  // The gateway a host on this interface should use: an HSRP virtual IP, else a router address.
  function gatewayFor(sim, i) {
    const vip = sim.vips.find((v) => v.hsrp && v.domain === i.domain);
    if (vip) return { ip: vip.ip, label: `the HSRP virtual IP on ${vip.dev.name}` };
    const r = sim.ifaces.find((x) => x.domain && x.domain === i.domain && x.up && M.canRoute(x.dev) && N.inNet(x.ip, i.net, i.mask));
    return r ? { ip: r.ip, label: `${r.dev.name} ${sn(r.name)}` } : null;
  }

  function arp(ctx, dev, c) {
    const p = ctx.p;
    const sim = ctx.sim;
    const eg = c.iface;
    const owner = ownerOf(sim, c.nh);
    if (M.isHost(dev) && c.nh === c.dst && dev.gateway) {
      const gwOwner = ownerOf(sim, dev.gateway);
      if (gwOwner && gwOwner.len !== eg.len) {
        return {
          text: `${dev.name}'s mask is /${eg.len}, so it thinks ${c.dst} is on its own subnet and ARPs for it directly instead of sending to its gateway. ${gwOwner.dev.name} uses /${gwOwner.len}.`,
          devs: [dev.id], fixes: [{ device: dev.name, lines: [hostLine(ctx, dev, eg.ip, maskOf(gwOwner.len), dev.gateway)], host: true }], checks: ['ipconfig'],
        };
      }
    }
    if (!owner) {
      if (M.isHost(dev)) {
        const gw = gatewayFor(sim, eg);
        if (gw) {
          return {
            text: `${dev.name} uses ${c.nh} as its default gateway, but nothing on its segment has that address. The gateway there is ${gw.label} (${gw.ip}).`,
            devs: [dev.id], fixes: [{ device: dev.name, lines: [hostLine(ctx, dev, eg.ip, eg.mask, gw.ip)], host: true }], checks: ['ipconfig', 'show ip interface brief'],
          };
        }
        const far = sim.ifaces.find((x) => M.canRoute(x.dev) && x.ip && N.inNet(x.ip, eg.net, eg.mask) && x.domain !== eg.domain);
        if (far) return layer2(ctx, eg, far);
        return { text: `${dev.name} expects a gateway at ${c.nh}, but no router has an address in ${eg.net}/${eg.len}.`, devs: [dev.id], fixes: [], checks: ['show ip interface brief'] };
      }
      const peer = S.peersOn(sim, eg).find((j) => M.canRoute(j.dev));
      const r = c.route;
      const fixes = r && r.proto === 'S' && peer ? [{ device: dev.name, lines: [`no ip route ${r.net} ${r.mask} ${c.nh}`, `ip route ${r.net} ${r.mask} ${peer.ip}`] }] : [];
      return {
        text: `${dev.name} sends it to next hop ${c.nh} out ${sn(eg.name)}, but nothing on that link has ${c.nh}.${peer ? ` The router there is ${peer.dev.name} at ${peer.ip}.` : ''}`,
        devs: [dev.id], fixes, checks: ['show ip route', 'show cdp neighbors detail'],
      };
    }
    if (!owner.up) return downIface(ctx, owner);
    if (owner.domain !== eg.domain) return layer2(ctx, eg, owner);
    return { text: `${dev.name} gets no ARP reply from ${c.nh} on ${sn(eg.name)}.`, devs: [dev.id], fixes: [], checks: ['show arp'] };
  }

  function noRoute(ctx, dev, c) {
    const p = ctx.p;
    const sim = ctx.sim;
    const dstN = N.ip2n(c.dst);
    const home = sim.ifaces.filter((i) => i.ip && i.kind !== 'vip' && i.kind !== 'loopback' && M.canRoute(i.dev) && N.inNet(c.dst, i.net, i.mask))[0]
      || sim.ifaces.find((i) => i.ip === c.dst);
    if (!home) return { text: `${dev.name} has no route to ${c.dst}, and no router has a connected subnet containing it. Check the address.`, devs: [dev.id], fixes: [], checks: ['show ip route'] };
    const O = home.dev;
    const net = `${home.net}`;
    const mask = home.mask;
    const base = `${dev.name} has no route to ${c.dst}, which is on ${O.name}'s ${net}/${home.len}.`;
    const covering = S.showRoutes(sim, dev).filter((r) => r.proto !== 'L' && N.inNet(c.dst, r.net, maskOf(r.len)));
    if (covering.length) {
      return { text: `${dev.name} has a route for ${c.dst} (${covering.map((r) => `${r.net}/${r.len} via ${r.nh || sn(r.ifName)}`).join(', ')}), but it cannot resolve the next hop, usually because two devices disagree about a subnet's mask.`,
        devs: [dev.id, O.id], fixes: [], checks: ['show ip route', 'show ip interface brief'] };
    }
    const o = dev.routing.ospf;
    if (o.enabled && O.routing.ospf.enabled) {
      const ost = sim.rt[O.id];
      if (!ost.ospfIfs.some((x) => x.i === home)) {
        const area = (O.routing.ospf.networks[0] || {}).area || 0;
        return { text: `${base} ${O.name} runs OSPF but no network statement covers ${sn(home.name)}, so it never advertises ${net}/${home.len}.`, devs: [O.id],
          fixes: [{ device: O.name, lines: [`router ospf ${O.routing.ospf.pid}`, ` network ${net} ${N.wildcard(mask)} area ${area}`] }], checks: ['show ip ospf interface brief', 'show ip protocols'] };
      }
      const st = sim.rt[dev.id];
      const down = (st.ospfNbrs || []).filter((x) => !x.ok);
      if (!(st.ospfNbrs || []).some((x) => x.ok)) {
        return { text: `${base} ${dev.name} has no OSPF neighbors, so it learns nothing.${down.length ? ` ${down[0].reason}` : ' No other OSPF router shares a subnet with it.'}`,
          devs: [dev.id, ...down.map((x) => x.them.devId)], fixes: ospfFixes(ctx, down), checks: ['show ip ospf neighbor', 'show ip ospf interface brief'] };
      }
    }
    // Suggest a static route through a neighbouring router that can reach the destination.
    const peers = ifacesOf(sim, dev).flatMap((i) => S.peersOn(sim, i).filter((j) => M.canRoute(j.dev)).map((j) => ({ me: i, j })));
    const via = peers.find(({ j }) => j.devId === O.id) || peers.find(({ j }) => S.resolve(sim, j.devId, dstN));
    const fixes = [];
    if (via) fixes.push({ device: dev.name, lines: [`ip route ${net} ${mask} ${via.j.ip}`] });
    // The reply needs a way back too.
    const src = c.pkt && c.pkt.src;
    if (src && via && !S.resolve(sim, O.id, N.ip2n(src))) {
      const srcIf = sim.ifaces.find((i) => i.ip === src);
      const back = ifacesOf(sim, O).flatMap((i) => S.peersOn(sim, i).filter((j) => M.canRoute(j.dev))).find((j) => j.devId === dev.id || S.resolve(sim, j.devId, N.ip2n(src)));
      if (srcIf && back) fixes.push({ device: O.name, lines: [`ip route ${srcIf.net} ${srcIf.mask} ${back.ip}`] });
    }
    const proto = o.enabled || dev.routing.rip.enabled || dev.routing.bgp.enabled;
    return {
      text: `${base} ${proto ? 'Its routing protocol has not learned that subnet.' : `${dev.name} runs no routing protocol and has no static route for it.`}${via ? ` A static route via ${via.j.dev.name} (${via.j.ip}) fixes it; so would enabling OSPF on both routers.` : ''}`,
      devs: [dev.id, O.id], fixes, checks: ['show ip route', 'show ip protocols'],
    };
  }

  function ospfFixes(ctx, down) {
    const fixes = [];
    down.forEach((n) => {
      const peer = n.them.dev;
      const o = peer.routing.ospf;
      if (/is passive/.test(n.reason)) fixes.push({ device: peer.name, lines: [`router ospf ${o.pid}`, ` no passive-interface ${n.them.name}`] });
      else if (/is not in OSPF/.test(n.reason)) {
        if (!o.enabled) fixes.push({ device: peer.name, lines: [`router ospf 1`, ` network ${n.them.net} ${N.wildcard(n.them.mask)} area 0`] });
        else fixes.push({ device: peer.name, lines: [`router ospf ${o.pid}`, ` network ${n.them.net} ${N.wildcard(n.them.mask)} area ${(o.networks[0] || {}).area || 0}`] });
      } else if (/Inbound ACL .* drops hellos/.test(n.reason)) {
        const at = /on (.+) drops hellos from this router/.test(n.reason) ? n.them : n.me;
        const acl = at.dev.acls.find((a) => a.name === at.aclIn);
        if (acl) fixes.push({ device: at.dev.name, lines: [`ip access-list ${acl.type} ${acl.name}`, ` 5 permit ospf any any`] });
      } else if (/Both routers use router ID/.test(n.reason)) fixes.push({ device: peer.name, lines: [`router ospf ${o.pid}`, ` router-id ${N.n2ip((N.ip2n(n.rid) + 1) >>> 0)}`, 'end', 'clear ip ospf process'] });
    });
    return fixes;
  }

  // ---------- Answers ----------

  const pathLine = (leg) => leg.hops.map((h) => [h.dev, ...(h.via || [])]).flat().filter((x, i, a) => x !== a[i - 1]).join(' → ');

  function traceLines(leg, title) {
    const lines = [`${title}:`];
    leg.hops.forEach((h) => {
      const bits = [h.in && `in ${sn(h.in)}`, h.out && `out ${sn(h.out)}`, h.via && h.via.length && `via ${h.via.join(', ')}`, h.route && `route ${h.route.net}/${h.route.len} (${h.route.proto})`, h.nat].filter(Boolean);
      lines.push(`  ${h.dev}${bits.length ? `: ${bits.join(', ')}` : ''}${h.fail ? ` ✗ ${h.fail}` : ''}`);
    });
    return lines;
  }

  // Merges fix lists so each device appears once, keeping the order found.
  function mergeFixes(list) {
    const out = [];
    list.forEach((f) => {
      const have = out.find((x) => x.device === f.device);
      if (!have) out.push({ ...f, lines: [...f.lines] });
      else {
        f.lines.forEach((l) => {
          const lastHead = [...have.lines].reverse().find((x) => !x.startsWith(' '));
          if (!l.startsWith(' ') && (l === lastHead || (have.lines.includes(l) && !/^(interface|router|ip access-list|ip dhcp pool)/.test(l)))) return;
          have.lines.push(l);
        });
      }
    });
    return out;
  }

  function endpoint(p, sim, m) {
    if (!m) return null;
    if (m.dev) {
      const ip = addrOf(sim, m.dev) || (sim.v6 && (PL.ipv6.addrList(sim).find((x) => x.dev === m.dev) || {}).addr) || '';
      return { dev: m.dev, ip, label: m.dev.name };
    }
    const o = ownerOf(sim, m.ip);
    return { dev: o ? o.dev : null, ip: m.ip, label: o ? `${o.dev.name} (${m.ip})` : m.ip };
  }

  function answerPing(ctx, q) {
    const { p, sim } = ctx;
    const [a, b] = q.mentions.map((m) => endpoint(p, sim, m));
    if (!a || !b) return { kind: 'ask', summary: `Which two devices? Try "why can't PC1 ping PC2?"${a ? ` I found ${a.label}.` : ''}` };
    if (!a.dev) return { kind: 'ask', summary: `I can't tell which device ${a.ip} is, so I can't test from it. Name the source device instead.` };
    if (!b.ip) return { kind: 'ask', summary: `${b.label} has no address to test against yet.` };
    const v6 = b.ip.includes(':');
    const svc = q.service;
    const r = v6 ? PL.ipv6.ping(sim, a.dev.id, b.ip) : S.ping(sim, a.dev.id, b.ip, svc ? { proto: svc.proto, port: svc.port } : null);
    const what = svc ? `${svc.label} from ${a.label} to ${b.label}` : `${a.label} pinging ${b.label}`;
    const legs = [r.fwd, r.back].filter(Boolean);
    const trace = { ok: r.ok, links: [...new Set(legs.flatMap((x) => x.links || []))], devices: [...new Set(legs.flatMap((x) => x.hops.map((h) => h.devId)))], legs: legs.map((x) => ({ links: x.links, hops: x.hops, ok: x.ok })) };
    if (r.ok) {
      return {
        kind: 'ok', ok: true, summary: `It works: ${what} reaches the destination and the reply comes back.`, trace,
        details: [`Path out: ${pathLine(r.fwd)}`, `Path back: ${pathLine(r.back)}`, ...traceLines(r.fwd, 'Outbound'), ...traceLines(r.back, 'Return')],
        checks: [v6 ? `ping ${b.ip}` : `ping ${b.ip}`, `traceroute ${b.ip}`], fixes: [],
      };
    }
    if (!r.fwd || !r.fwd.hops || !r.fwd.hops.length) return { kind: 'fail', summary: r.reason, trace, details: [], fixes: [], checks: [] };
    const leg = r.back && !r.back.ok ? r.back : r.fwd;
    const hop = leg.hops[leg.hops.length - 1];
    const main = explain(ctx, hop, leg);
    const onPath = new Set([...legs.flatMap((x) => x.hops.map((h) => h.devId)), ...legs.flatMap((x) => x.hops.flatMap((h) => (h.via || []).map((n) => (p.devices.find((d) => d.name === n) || {}).id)))].filter(Boolean));
    (main.devs || []).forEach((id) => onPath.add(id));
    const domains = new Set([...onPath].flatMap((id) => (sim.byDev[id] || []).map((i) => i.domain)).filter(Boolean));
    const outliers = segmentOutliers(sim).filter((o) => onPath.has(o.iface.devId) || domains.has(o.iface.domain));
    // A mask or subnet outlier on the path is usually the root cause, and the hop failure its symptom.
    // Only a wrong mask leads: an address in the wrong subnet is usually the symptom of a VLAN mix-up.
    const lead = !['acl', 'portsec'].includes((hop.cause || {}).code) ? outliers.find((o) => o.kind === 'mask') || null : null;
    const where = leg === r.back ? `The request arrives, but the reply from ${hop.dev === b.dev?.name ? b.label : hop.dev} fails. ` : '';
    // When the hop failure is the mask problem itself, say it once.
    const summary = lead
      ? `${what} fails. ${outlierText(lead)}${/\bmask\b/.test(main.text) && lead.iface.devId === hop.devId ? '' : ` ${where}${main.text}`}`
      : `${what} fails. ${where}${main.text}`;
    const issues = (ctx.issues || []).filter((i) => i.sev !== 'info' && (onPath.has(i.devId) || (i.linkId && [...onPath].some((id) => M.linksOf(p, id).some((l) => l.id === i.linkId)))));
    const details = [
      ...outliers.filter((o) => o !== lead).map(outlierText),
      ...issues.map((i) => `${i.sev === 'error' ? 'Problem' : 'Check'}: ${i.msg}${i.fix ? ` ${i.fix}` : ''}`),
      '',
      ...traceLines(r.fwd, 'Outbound'), ...(r.back ? traceLines(r.back, 'Return') : []),
    ];
    let fixes = mergeFixes([...(lead ? [outlierFix(ctx, lead)] : []), ...(main.fixes || [])]);
    if (ctx.fixFor) fixes = ctx.fixFor([...onPath]);
    return { kind: 'fail', ok: false, summary, trace, details: [...new Set(details)], fixes, checks: [...new Set(main.checks || [])] };
  }

  function answerDhcp(ctx, q) {
    const { p, sim } = ctx;
    const m = q.mentions.find((x) => x.dev && M.isHost(x.dev));
    if (!m) return { kind: 'ask', summary: 'Which host? Try "why doesn\'t PC3 get an address?"' };
    const d = m.dev;
    const lease = sim.leases[d.id];
    if (d.ipMode !== 'dhcp') {
      const c = d.ports.Ethernet0 || {};
      return c.ip
        ? { kind: 'ok', summary: `${d.name} is set to a static address (${c.ip}/${N.maskToLen(c.mask)}), so it does not use DHCP.`, details: [], fixes: [], checks: ['ipconfig'] }
        : { kind: 'fail', summary: `${d.name} is set to static but has no address. Set one, or switch it to DHCP.`, details: [], fixes: [{ device: d.name, lines: [ctx.cli ? 'ipconfig /dhcp' : 'Set the host to DHCP'], host: true }], checks: ['ipconfig'] };
    }
    if (lease && lease.ok) return { kind: 'ok', ok: true, summary: `${d.name} gets ${lease.ip}/${N.maskToLen(lease.mask)} from pool ${lease.pool} on ${lease.server}${lease.relay && lease.relay !== lease.server ? `, relayed by ${lease.relay}` : ''}, with gateway ${lease.gateway || 'none'}.`, details: [], fixes: [], checks: ['ipconfig /all', 'show ip dhcp binding'] };
    const reason = lease ? lease.reason : 'It is not cabled.';
    const fixes = [];
    let m2;
    if ((m2 = /DHCP snooping on (\S+) drops .* on untrusted (\S+)\./.exec(reason))) {
      const sw = p.devices.find((x) => x.name === m2[1]);
      const port = sw && Object.keys(sw.ports).concat(PL.catalog.MODELS[sw.model].ports).find((n) => sn(n) === m2[2]);
      if (sw && port) fixes.push({ device: sw.name, lines: [`interface ${port}`, ' ip dhcp snooping trust'] });
    } else if ((m2 = /No DHCP pool for (\S+)\/(\d+) on (\S+),/.exec(reason))) {
      const r = p.devices.find((x) => x.name === m2[3]);
      const mask = maskOf(+m2[2]);
      const gw = r && ifacesOf(sim, r).find((i) => i.net === m2[1]);
      const base = N.ip2n(m2[1]);
      fixes.push({ device: m2[3], lines: [`ip dhcp excluded-address ${N.n2ip(base + 1)} ${N.n2ip(base + 10)}`, `ip dhcp pool NET-${m2[1].replace(/\./g, '-')}`, ` network ${m2[1]} ${mask}`, ...(gw ? [` default-router ${gw.ip}`] : [])] });
    } else if ((m2 = /(\S+) has no pool covering (\S+)\/(\d+)/.exec(reason))) {
      const gw = sim.ifaces.find((i) => i.net === m2[2] && i.len === +m2[3] && M.canRoute(i.dev));
      const base = N.ip2n(m2[2]);
      fixes.push({ device: m2[1], lines: [`ip dhcp excluded-address ${N.n2ip(base + 1)} ${N.n2ip(base + 10)}`, `ip dhcp pool NET-${m2[2].replace(/\./g, '-')}`, ` network ${m2[2]} ${maskOf(+m2[3])}`, ...(gw ? [` default-router ${gw.ip}`] : [])] });
    } else if ((m2 = /inbound ACL (\S+) on (\S+) (\S+) drops DHCP/.exec(reason))) {
      const r = p.devices.find((x) => x.name === m2[2]);
      const acl = r && r.acls.find((a) => a.name === m2[1]);
      if (acl) fixes.push({ device: r.name, lines: [`ip access-list ${acl.type} ${acl.name}`, acl.type === 'standard' ? ' 5 permit any' : ' 5 permit udp any any eq 67'] });
    }
    return { kind: 'fail', summary: `${d.name} gets no DHCP lease. ${reason}`, details: [], fixes: ctx.fixFor ? ctx.fixFor([d.id, ...p.devices.filter(M.canRoute).map((x) => x.id)]) : fixes, checks: ['ipconfig /renew', 'show ip dhcp pool', 'show ip dhcp binding', 'debug ip dhcp server events'] };
  }

  function answerOspf(ctx, q) {
    const { p, sim } = ctx;
    const routers = q.mentions.filter((x) => x.dev && M.canRoute(x.dev)).map((x) => x.dev);
    const list = routers.length ? routers : p.devices.filter((d) => M.canRoute(d) && d.routing.ospf.enabled);
    const nbrs = list.flatMap((d) => (sim.rt[d.id].ospfNbrs || []).map((n) => ({ ...n, d })))
      .filter((n) => routers.length < 2 || routers.some((r) => r.id === n.them.devId));
    if (!nbrs.length) {
      const off = list.filter((d) => !d.routing.ospf.enabled);
      return { kind: 'fail', summary: off.length ? `OSPF is not enabled on ${off.map((d) => d.name).join(' and ')}.` : `${list.map((d) => d.name).join(' and ') || 'These routers'} share no subnet with another OSPF router, so there is no one to form a neighbor with.`, details: [], fixes: [], checks: ['show ip ospf neighbor', 'show ip protocols'] };
    }
    const bad = nbrs.filter((n) => !n.ok);
    const seen = new Set();
    const uniq = bad.filter((n) => { const k = [n.d.id, n.them.devId].sort().join(); if (seen.has(k)) return false; seen.add(k); return true; });
    if (!uniq.length) return { kind: 'ok', ok: true, summary: nbrs.map((n) => `${n.d.name} and ${n.them.dev.name} are neighbors (${n.state}/${n.role}) on ${sn(n.me.name)}.`).filter((x, i, a) => a.indexOf(x) === i).join(' '), details: [], fixes: [], checks: ['show ip ospf neighbor'] };
    const outl = segmentOutliers(sim).filter((o) => uniq.some((n) => n.me === o.iface || n.them === o.iface));
    return {
      kind: 'fail', summary: uniq.map((n) => `${n.d.name} and ${n.them.dev.name} are not neighbors on ${sn(n.me.name)}: ${n.reason}`).join(' '),
      details: outl.map(outlierText), fixes: ctx.fixFor ? ctx.fixFor(uniq.flatMap((n) => [n.d.id, n.them.devId])) : mergeFixes([...outl.map((o) => outlierFix(ctx, o)), ...ospfFixes(ctx, uniq)]),
      checks: ['show ip ospf neighbor', 'show ip ospf interface brief', 'show ip protocols'],
    };
  }

  function answerGeneral(ctx) {
    const errs = (ctx.issues || []).filter((i) => i.sev === 'error');
    const warns = (ctx.issues || []).filter((i) => i.sev === 'warn');
    const m = S.matrix(ctx.sim);
    const pairs = m.rows.flat().filter(Boolean);
    const okN = pairs.filter((c) => c.ok).length;
    const out = segmentOutliers(ctx.sim);
    if (!errs.length && !out.length) {
      return { kind: 'ok', ok: true, summary: `Nothing is blocking. Hosts reach each other in ${okN} of ${pairs.length} pairs${okN < pairs.length ? '; the rest are blocked on purpose (an ACL, for example) or need a closer look. Ask about a specific pair.' : '.'}`, details: warns.map((w) => `Check: ${w.msg}`), fixes: [], checks: [] };
    }
    return {
      kind: 'fail',
      summary: `I see ${errs.length + out.length} problem${errs.length + out.length > 1 ? 's' : ''}. ${out.length ? outlierText(out[0]) : errs[0].msg}${errs.length + out.length > 1 ? ' Ask about a specific pair, such as "why can\'t PC1 ping PC2", for the cause on that path.' : ''}`,
      details: [...out.slice(out.length ? 1 : 0).map(outlierText), ...errs.slice(out.length ? 0 : 1).map((e) => `${e.msg}${e.fix ? ` ${e.fix}` : ''}`), ...warns.map((w) => `Check: ${w.msg}`)],
      fixes: ctx.fixFor ? ctx.fixFor(null) : mergeFixes(out.map((o) => outlierFix(ctx, o))), checks: ['show ip interface brief', 'show ip route', 'show vlan brief'],
    };
  }

  // ctx: { p, sim, issues, cli, fixFor }. fixFor(devIds) returns exact fixes when an answer key exists.
  function ask(ctx, text) {
    const q = parseQuestion(ctx.p, text);
    let a;
    if (q.kind === 'ping') a = answerPing(ctx, q);
    else if (q.kind === 'dhcp') a = answerDhcp(ctx, q);
    else if (q.kind === 'ospf') a = answerOspf(ctx, q);
    else if (q.kind === 'general') a = answerGeneral(ctx);
    else a = { kind: 'ask', summary: 'I can answer questions like "why can\'t PC1 ping PC2?", "can Staff1 reach WEB1 on port 80?", "why doesn\'t PC3 get an address?", "why aren\'t R1 and R2 OSPF neighbors?" or "what\'s wrong with my lab?"' };
    return { question: q.text, ...a, fixes: a.fixes || [], details: a.details || [], checks: a.checks || [] };
  }

  // ---------- Presenting an answer ----------

  const html = (x) => String(x === undefined || x === null ? '' : x).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

  // view: 'summary', 'more' (troubleshooting detail) or 'fix' (commands per device).
  function render(a, view) {
    const tone = a.ok ? 'ok' : a.kind === 'fail' ? 'no' : '';
    let out = `<div class="ts-answer ${tone}"><p class="ts-q">${html(a.question)}</p><p class="ts-summary">${html(a.summary)}</p></div>`;
    if (view === 'more') {
      const lines = a.details.filter((x, i, arr) => x || (arr[i - 1] && arr[i + 1]));
      out += `<div class="ts-more">${lines.length ? `<pre class="cli scroll">${html(lines.join('\n'))}</pre>` : '<p class="note">Nothing more to add for this one.</p>'}
        ${a.checks.length ? `<p class="note">To confirm on the device, run:</p><ul class="ts-checks">${a.checks.map((c) => `<li><code>${html(c)}</code></li>`).join('')}</ul>` : ''}</div>`;
    }
    if (view === 'fix') {
      out += a.fixes.length
        ? `<div class="ts-fixes">${a.fixes.map((f) => `<div class="ts-fix"><div class="ts-dev">${html(f.device)}${f.host ? ' <span class="sub">(host settings)</span>' : ''}</div><pre class="cli scroll">${html(f.lines.join('\n'))}</pre></div>`).join('')}</div>
          <p class="note">${a.fixes.some((f) => !f.host) ? 'Type these in global configuration mode (configure terminal). ' : ''}Check the result with the same question afterwards.</p>`
        : `<p class="note">${a.ok ? 'Nothing to change: this already works.' : 'No specific commands for this one. More troubleshooting info shows what to look at.'}</p>`;
    }
    return out;
  }

  PL.troubleshoot = { ask, parseQuestion, segmentOutliers, render };
})(typeof window !== 'undefined' ? (window.PL = window.PL || {}) : (globalThis.PL = globalThis.PL || {}));
