// The right-hand panel: device, link, lab, config and verification views.
// Views are plain template strings. Inputs and buttons register closures in `binds`
// and `acts`, and one delegated listener on the panel dispatches to them.
(function (PL) {
  'use strict';

  const { MODELS, shortName, portSpeed, ACL_PORTS, ACL_PROTOCOLS, ICMP_TYPES, portNum, naturalCompare } = PL.catalog;
  const N = PL.net;
  const M = PL.model;
  const S = PL.simulate;
  const C = PL.configgen;
  const V6 = PL.ipv6;
  const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function create(App) {
    const panelBody = document.getElementById('panel-body');
    const toolsBody = document.getElementById('tools-body');
    // Tools fill their own page; everything else renders into the side panel.
    let root = panelBody;
    const tabsEl = document.getElementById('tabs');
    let binds = [];
    let acts = [];
    let seq = 0;

    const nextId = () => `f${seq++}`;
    const act = (fn) => {
      acts.push(fn);
      return acts.length - 1;
    };

    function btn(label, fn, cls) {
      return `<button type="button" class="btn small ${cls || ''}" data-a="${act(fn)}">${esc(label)}</button>`;
    }

    const del = (fn, label) => `<button type="button" class="x" aria-label="${esc(label || 'Remove')}" title="${esc(label || 'Remove')}" data-a="${act(fn)}">&times;</button>`;

    function bind(fn) {
      binds.push(fn);
      return binds.length - 1;
    }

    function input(value, set, o) {
      o = o || {};
      const id = nextId();
      const cls = [o.mono ? 'mono' : '', o.invalid ? 'invalid' : ''].join(' ');
      return `<input id="${id}" class="${cls}" data-b="${bind(set)}" value="${esc(value)}" placeholder="${esc(o.ph || '')}" aria-label="${esc(o.label || o.ph || '')}" spellcheck="false" autocomplete="off"${o.type ? ` type="${o.type}"` : ''}${o.list ? ` list="${o.list}"` : ''}>`;
    }

    function select(value, opts, set, label) {
      const id = nextId();
      const html = opts.map(([v, t]) => `<option value="${esc(v)}"${String(v) === String(value) ? ' selected' : ''}>${esc(t)}</option>`).join('');
      return `<select id="${id}" data-b="${bind(set)}" aria-label="${esc(label || '')}">${html}</select>`;
    }

    function check(label, value, set) {
      const id = nextId();
      return `<label class="check"><input type="checkbox" id="${id}" data-b="${bind(set)}"${value ? ' checked' : ''}>${esc(label)}</label>`;
    }

    const field = (label, control) => `<div class="f"><span>${esc(label)}</span>${control}</div>`;

    // Accepts "10.0.0.1/24" in the address box and fills the mask as well.
    function ipInput(c, o) {
      const bad = c.ip && N.ip2n(c.ip) === null;
      return input(c.ip, (v) => {
        const m = /^(.+)\/(\d+)$/.exec(v.trim());
        if (m) {
          c.ip = m[1];
          c.mask = N.normalizeMask(m[2]) || c.mask;
        } else {
          c.ip = v.trim();
          if (c.ip && !c.mask) c.mask = '255.255.255.0';
        }
      }, { mono: true, ph: '10.0.0.1 or 10.0.0.1/24', label: 'IP address', invalid: bad, ...o });
    }

    function maskInput(c) {
      const bad = c.mask && N.maskToLen(c.mask) === null;
      return input(c.mask, (v) => { c.mask = N.normalizeMask(v) || v.trim(); }, { mono: true, ph: '255.255.255.0', label: 'Subnet mask', invalid: bad });
    }

    const aclOptions = (d) => [['', 'None'], ...d.acls.map((a) => [a.name, `${a.name} (${a.type})`])];

    function aclPair(d, c) {
      return `<div class="grid">${field('ACL inbound', select(c.aclIn, aclOptions(d), (v) => { c.aclIn = v; }, 'Inbound ACL'))}${field('ACL outbound', select(c.aclOut, aclOptions(d), (v) => { c.aclOut = v; }, 'Outbound ACL'))}</div>`;
    }

    // HSRP and IPv6 settings for any routed interface: port, sub-interface or SVI.
    function l3Extras(d, c, ifName) {
      const st = App.sim.hsrp.find((h) => h.devId === d.id && h.ifName === ifName);
      const h = c.hsrp;
      const hsrp = check('HSRP gateway redundancy', !!h, (v) => { c.hsrp = v ? { group: 1, vip: '', priority: 100, preempt: false } : null; });
      const hsrpBody = h ? `<div class="grid">
          ${field('Group', input(h.group, (v) => { h.group = Math.max(0, Math.min(255, +v || 0)); }, { type: 'number', label: 'HSRP group' }))}
          ${field('Virtual IP', input(h.vip, (v) => { h.vip = v.trim(); }, { mono: true, ph: '10.0.0.254', label: 'HSRP virtual IP', invalid: h.vip && N.ip2n(h.vip) === null }))}
          ${field('Priority', input(h.priority, (v) => { h.priority = Math.max(0, Math.min(255, +v || 100)); }, { type: 'number', label: 'HSRP priority' }))}
        </div>${check('Preempt (take over when this router has the higher priority)', h.preempt, (v) => { h.preempt = v; })}
        ${st ? `<div class="chips"><span class="chip ${st.state === 'Active' ? 'good' : ''}">${esc(st.state)}</span><span class="sub">predicted for group ${st.group}${st.peers.length ? ` with ${esc(st.peers.map((x) => x.dev.name).join(', '))}` : ', no peer yet'}</span></div>` : ''}` : '';
      const o3 = d.routing.ospf3.enabled;
      const bad6 = c.ip6 && !V6.parsePrefix(c.ip6);
      const v6 = `<div class="grid">${field('IPv6 address', input(c.ip6 || '', (v) => { c.ip6 = v.trim(); }, { mono: true, ph: '2001:db8:1::1/64', label: 'IPv6 address', invalid: bad6 }))}
        ${o3 ? field('OSPFv3 area', input(c.ospf3 || '', (v) => { c.ospf3 = v.trim(); }, { ph: 'Not in OSPFv3', label: 'OSPFv3 area' })) : ''}</div>`;
      return `${v6}${M.canRoute(d) ? hsrp + hsrpBody : ''}`;
    }

    const vlanOptions = () => App.project.vlans.map((v) => [v.id, `${v.id} ${v.name}`]);

    function subtabs(key, list, cur) {
      return `<div class="subtabs" role="tablist">${list.map(([k, t]) => `<button type="button" class="${cur === k ? 'on' : ''}" data-a="${act(() => { App.ui[key] = k; App.renderPanel(); })}">${esc(t)}</button>`).join('')}</div>`;
    }

    // ---------- Device view ----------

    function deviceHead(d) {
      const m = MODELS[d.model];
      return `<div class="head"><div style="flex:1;min-width:0">
        <div class="f"><span>Hostname</span>${input(d.name, (v) => { d.name = v.trim().replace(/\s+/g, '-') || d.name; }, { label: 'Hostname' })}</div>
        <p>${esc(m.label)}${m.note ? `. ${esc(m.note)}` : ''}</p>
      </div><div class="btn-row">${M.isHost(d) ? '' : btn('Import config', () => App.importConfig(d))}${btn('Delete', () => App.deleteSelection(), 'danger')}</div></div>`;
    }

    function portRow(d, name) {
      const p = App.project;
      const link = M.linkOnPort(p, d.id, name) || p.links.find((l) => (l.a === d.id || l.b === d.id) && M.endIf(l, d.id) === name);
      const c = M.port(d, name);
      const key = `${d.id}:${name}`;
      const open = App.ui.open[key];
      const peer = link ? M.dev(p, M.peerOf(link, d.id)) : null;
      const l3 = !link || M.isL3End(p, link, d.id);
      let summary = '';
      if (l3) summary = c.ip ? `${c.ip}/${N.maskToLen(c.mask)}` : c.subifs.length ? `${c.subifs.length} sub-if` : '';
      else summary = link.mode === 'access' ? `VLAN ${link.vlan}` : 'Trunk';
      const dot = !link ? '' : c.shutdown ? 'down' : 'up';
      const peerText = peer ? `${peer.name} ${shortName(M.endIf(link, peer.id))}` : 'Not connected';
      const head = `<button type="button" class="row-head" aria-expanded="${!!open}" data-a="${act(() => { App.ui.open[key] = !open; App.renderPanel(); })}">
        <span class="dot ${dot}"></span><span class="row-name">${esc(shortName(name))}</span><span class="row-peer">${esc(peerText)}</span><span class="row-ip">${esc(summary)}</span></button>`;
      if (!open) return `<div class="card">${head}</div>`;
      return `<div class="card">${head}<div class="card-body">${portBody(d, name, c, link, l3)}</div></div>`;
    }

    function portBody(d, name, c, link, l3) {
      const p = App.project;
      let html = '';
      if (link) html += `<div class="btn-row">${btn('Open cable settings', () => { App.select('link', link.id); App.renderAll(); })}</div>`;
      html += `<div class="grid">${field('Description', input(c.desc, (v) => { c.desc = v; }, { ph: 'Auto from the cable', label: 'Description' }))}</div>`;
      html += check('Administratively shut down', c.shutdown, (v) => { c.shutdown = v; });
      if (!l3) {
        html += `<p class="note">This is a switchport. Its VLAN settings live on the cable.</p>`;
        return html;
      }
      html += `<div class="grid">${field('IP address', ipInput(c))}${field('Subnet mask', maskInput(c))}</div>`;
      html += aclPair(d, c);
      html += l3Extras(d, c, name);
      if (M.isRouter(d)) html += subifSection(d, name, c, link);
      return html;
    }

    function subifSection(d, name, c, link) {
      const p = App.project;
      const add = () => {
        const used = c.subifs.map((s) => s.num);
        let n = 10;
        while (used.includes(n)) n += 10;
        c.subifs.push({ num: n, vlan: n, ip: '', mask: '', native: false, desc: '', aclIn: '', aclOut: '' });
      };
      const rows = c.subifs.map((s, i) => `<div class="mini">
        <div class="mini-head"><span>${esc(shortName(name))}.${s.num}</span>${del(() => { c.subifs.splice(i, 1); App.commit(); }, 'Remove sub-interface')}</div>
        <div class="grid">
          ${field('VLAN', input(s.vlan, (v) => { s.vlan = +v || s.vlan; s.num = s.vlan; }, { label: 'VLAN', type: 'number' }))}
          ${field('IP address', ipInput(s))}
          ${field('Subnet mask', maskInput(s))}
        </div>
        ${check('Native VLAN (untagged)', s.native, (v) => { s.native = v; })}
        ${aclPair(d, s)}
        ${l3Extras(d, s, `${name}.${s.num}`)}
      </div>`).join('');
      const fromVlans = link && link.mode === 'trunk' ? btn('Create from trunk VLANs', () => {
        const n = M.subifsFromVlans(p, d, name, link);
        App.toast(n ? `Added ${n} sub-interface${n > 1 ? 's' : ''}.` : 'Every trunk VLAN already has a sub-interface.');
        App.commit();
      }) : '';
      return `<div class="sect"><div class="sect-head"><h3>${esc(d.name)} sub-interfaces</h3><div class="btn-row">${fromVlans}${btn('Add', () => { add(); App.commit(); })}</div></div>${rows}</div>`;
    }

    function loopbackSection(d) {
      const rows = d.loopbacks.map((lo, i) => `<div class="mini">
        <div class="mini-head"><span>Loopback${lo.num}</span>${del(() => { d.loopbacks.splice(i, 1); App.commit(); }, 'Remove loopback')}</div>
        <div class="grid">${field('IP address', ipInput(lo))}${field('Subnet mask', maskInput(lo))}</div>
        <div class="grid">${field('IPv6 address', input(lo.ip6 || '', (v) => { lo.ip6 = v.trim(); }, { mono: true, ph: '2001:db8::1/128', label: 'IPv6 address' }))}
        ${d.routing.ospf3.enabled ? field('OSPFv3 area', input(lo.ospf3 || '', (v) => { lo.ospf3 = v.trim(); }, { ph: 'Not in OSPFv3', label: 'OSPFv3 area' })) : ''}</div></div>`).join('');
      const add = () => {
        const n = d.loopbacks.length ? Math.max(...d.loopbacks.map((x) => x.num)) + 1 : 0;
        d.loopbacks.push({ num: n, ip: '', mask: '255.255.255.255', desc: '' });
        App.commit();
      };
      return `<div class="sect"><div class="sect-head"><h3>Loopbacks</h3>${btn('Add', add)}</div>${rows}</div>`;
    }

    function sviSection(d) {
      const l3 = M.isL3Switch(d);
      const rows = d.svis.map((s, i) => `<div class="mini">
        <div class="mini-head"><span>Vlan${s.vlan}</span>${del(() => { d.svis.splice(i, 1); App.commit(); }, 'Remove SVI')}</div>
        <div class="grid">
          ${field('VLAN', select(s.vlan, vlanOptions(), (v) => { s.vlan = +v; }, 'VLAN'))}
          ${field('IP address', ipInput(s))}
          ${field('Subnet mask', maskInput(s))}
        </div>
        ${l3 ? aclPair(d, s) + l3Extras(d, s, `Vlan${s.vlan}`) : ''}</div>`).join('');
      const add = () => {
        const have = d.svis.map((s) => s.vlan);
        const v = App.project.vlans.find((x) => !have.includes(x.id) && x.id !== 1) || App.project.vlans.find((x) => !have.includes(x.id));
        if (!v) return App.toast('Every VLAN already has an SVI.');
        d.svis.push({ vlan: v.id, ip: v.subnet ? N.n2ip(N.ip2n(v.subnet) + (l3 ? 1 : 2)) : '', mask: v.mask || '', desc: '', shutdown: false, aclIn: '', aclOut: '' });
        App.commit();
      };
      const all = l3 ? btn('Create for all VLANs', () => {
        const have = d.svis.map((s) => s.vlan);
        App.project.vlans.filter((v) => v.subnet && !have.includes(v.id)).forEach((v) => d.svis.push({ vlan: v.id, ip: N.n2ip(N.ip2n(v.subnet) + 1), mask: v.mask, desc: '', shutdown: false, aclIn: '', aclOut: '' }));
        App.commit();
      }) : '';
      return `<div class="sect"><div class="sect-head"><h3>VLAN interfaces</h3><div class="btn-row">${all}${btn('Add', add)}</div></div>
        <p class="note">${l3 ? 'SVIs act as the default gateway for each VLAN.' : 'A Layer 2 switch uses one SVI for management.'}</p>${rows}
        ${l3 ? '' : field('Default gateway', input(d.gateway, (v) => { d.gateway = v.trim(); }, { mono: true, ph: '192.168.1.1', label: 'Default gateway' }))}</div>`;
    }

    function interfacesView(d) {
      const p = App.project;
      const links = M.linksOf(p, d.id);
      const pos = links.filter((l) => l.ec).map((l) => M.endIf(l, d.id));
      const members = new Set(links.filter((l) => l.ec).flatMap((l) => l.members.map((m) => m[M.side(l, d.id)])));
      const portsAll = MODELS[d.model].ports.filter((n) => !members.has(n));
      const used = portsAll.filter((n) => M.linkOnPort(p, d.id, n));
      const free = portsAll.filter((n) => !M.linkOnPort(p, d.id, n));
      const show = M.isRouter(d) ? portsAll : used;
      let html = `<div class="sect"><div class="sect-head"><h3>Interfaces</h3></div>${[...pos, ...show].map((n) => portRow(d, n)).join('') || '<p class="note">No cables yet. Pull from the + handle on the canvas.</p>'}`;
      if (!M.isRouter(d) && free.length) html += `<p class="note">${free.length} free ports. New cables pick them automatically.</p>`;
      html += '</div>';
      if (M.isSwitch(d)) html += sviSection(d);
      if (M.canRoute(d)) html += loopbackSection(d);
      return html;
    }

    function hostView(d) {
      const c = M.port(d, 'Ethernet0');
      const link = M.linksOf(App.project, d.id)[0];
      const peer = link && M.dev(App.project, M.peerOf(link, d.id));
      const mode = (m, label) => `<button type="button" class="${d.ipMode === m ? 'on' : ''}" data-a="${act(() => { d.ipMode = m; App.commit(); })}">${label}</button>`;
      let settings;
      if (d.ipMode === 'dhcp') {
        const lease = App.sim.leases[d.id];
        settings = !lease ? '<p class="note">Cable this device to get a lease.</p>' : lease.ok
          ? `<dl class="fact"><dt>Address</dt><dd>${esc(lease.ip)}/${N.maskToLen(lease.mask)}</dd><dt>Gateway</dt><dd>${esc(lease.gateway || 'none')}</dd>
              ${lease.dns ? `<dt>DNS</dt><dd>${esc(lease.dns)}</dd>` : ''}<dt>From</dt><dd>${esc(`${lease.server} pool ${lease.pool}${lease.relay && lease.relay !== lease.server ? `, relayed by ${lease.relay}` : ''}`)}</dd></dl>
              <p class="note">The lease PatchLab expects. Real DHCP may hand out a different free address.</p>`
          : `<div class="verdict no">No lease<small>${esc(lease.reason)}</small></div>`;
      } else {
        settings = `<div class="grid">${field('IP address', ipInput(c))}${field('Subnet mask', maskInput(c))}</div>
        <div class="grid">${field('Default gateway', input(d.gateway, (v) => { d.gateway = v.trim(); }, { mono: true, ph: '192.168.1.1', label: 'Default gateway' }))}
        ${field('DNS server', input(d.dns, (v) => { d.dns = v.trim(); }, { mono: true, ph: 'Optional', label: 'DNS server' }))}</div>`;
      }
      return `<div class="sect"><div class="sect-head"><h3>Network settings</h3></div>
        <div class="subtabs" role="tablist">${mode('static', 'Static')}${mode('dhcp', 'DHCP')}</div>
        ${settings}
        <p class="note">${link ? `Cabled to ${esc(peer.name)} ${esc(shortName(M.endIf(link, peer.id)))}${link.mode === 'access' ? ` in VLAN ${link.vlan}` : ''}.` : 'Not connected yet.'}</p>
        ${link ? `<div class="btn-row">${btn('Open cable settings', () => { App.select('link', link.id); App.renderAll(); })}</div>` : ''}
      </div>${hostV6(d, c)}${d.model === 'internet' ? publicAddrs(d) : ''}`;
    }

    function hostV6(d, c) {
      const mode = (m, label) => `<button type="button" class="${d.ip6Mode === m ? 'on' : ''}" data-a="${act(() => { d.ip6Mode = m; App.commit(); })}">${label}</button>`;
      const h = App.sim.v6 && App.sim.v6.hosts[d.id];
      let body = '';
      if (d.ip6Mode === 'static') {
        body = `<div class="grid">${field('IPv6 address', input(c.ip6 || '', (v) => { c.ip6 = v.trim(); }, { mono: true, ph: '2001:db8:1::10/64', label: 'IPv6 address', invalid: c.ip6 && !V6.parsePrefix(c.ip6) }))}
          ${field('IPv6 gateway', input(d.gateway6, (v) => { d.gateway6 = v.trim(); }, { mono: true, ph: '2001:db8:1::1 or fe80::1', label: 'IPv6 gateway' }))}</div>`;
      } else if (d.ip6Mode === 'slaac') {
        body = !h ? '' : h.ok
          ? `<dl class="fact"><dt>Address</dt><dd>${esc(h.addr)}/${h.len}</dd><dt>Gateway</dt><dd>${esc(h.gateway)}</dd><dt>From</dt><dd>${esc(`${h.router} ${shortName(h.ifName)} Router Advertisement`)}</dd></dl>
            <p class="note">SLAAC joins the router's /64 prefix to an EUI-64 ID built from the MAC address. The gateway is the router's link-local address.</p>`
          : `<div class="verdict no">No IPv6 address<small>${esc(h.reason)}</small></div>`;
      }
      return `<div class="sect"><div class="sect-head"><h3>IPv6</h3></div>
        <div class="subtabs" role="tablist">${mode('none', 'Off')}${mode('slaac', 'SLAAC')}${mode('static', 'Static')}</div>${body}</div>`;
    }

    function publicAddrs(d) {
      const rows = d.loopbacks.map((lo, i) => `<div class="rule remark">${input(lo.ip, (v) => { lo.ip = v.trim(); lo.mask = '255.255.255.255'; }, { mono: true, ph: '8.8.8.8', label: 'Public address' })}${del(() => { d.loopbacks.splice(i, 1); App.commit(); })}</div>`).join('');
      return `<div class="sect"><div class="sect-head"><h3>Internet addresses</h3>${btn('Add', () => { d.loopbacks.push({ num: d.loopbacks.length, ip: '', mask: '255.255.255.255', desc: '' }); App.commit(); })}</div>
        <p class="note">Addresses this cloud answers for, such as 8.8.8.8, so inside hosts have something to reach through NAT. Its own address and gateway face your edge router.</p>${rows}</div>`;
    }

    // ---------- DHCP view ----------

    function dhcpView(d) {
      const p = App.project;
      const x = d.dhcp;
      const pools = x.pools.map((pl, i) => `<div class="mini">
        <div class="mini-head"><span>Pool ${esc(pl.name)}</span>${del(() => { x.pools.splice(i, 1); App.commit(); }, 'Remove pool')}</div>
        <div class="grid">
          ${field('Name', input(pl.name, (v) => { pl.name = v.trim().replace(/\s+/g, '_'); }, { label: 'Pool name' }))}
          ${field('Network', input(pl.network, (v) => {
            const m = /^(.+)\/(\d+)$/.exec(v.trim());
            pl.network = m ? m[1] : v.trim();
            if (m) pl.mask = N.normalizeMask(m[2]) || pl.mask;
          }, { mono: true, ph: '192.168.10.0', label: 'Pool network' }))}
          ${field('Mask', maskInput(pl))}
        </div>
        <div class="grid">
          ${field('Default router', input(pl.gateway, (v) => { pl.gateway = v.trim(); }, { mono: true, ph: '192.168.10.1', label: 'Default router' }))}
          ${field('DNS server', input(pl.dns, (v) => { pl.dns = v.trim(); }, { mono: true, ph: 'Optional', label: 'DNS server' }))}
          ${field('Domain name', input(pl.domain, (v) => { pl.domain = v.trim(); }, { ph: 'Optional', label: 'Domain name' }))}
        </div></div>`).join('');
      const addPool = () => {
        x.pools.push({ name: `POOL${x.pools.length + 1}`, network: '', mask: '255.255.255.0', gateway: '', dns: '', domain: '' });
        App.commit();
      };
      const fromGw = btn('Create from interfaces', () => {
        const n = M.dhcpPoolsFromGateways(p, d);
        App.toast(n ? `Added ${n} pool${n > 1 ? 's' : ''}, each excluding its first ten addresses.` : 'Every addressed interface already has a pool.');
        App.commit();
      });
      const excl = x.excluded.map((e, i) => `<tr>
        <td>${input(e.from, (v) => { e.from = v.trim(); }, { mono: true, ph: '192.168.10.1', label: 'First excluded address' })}</td>
        <td>${input(e.to, (v) => { e.to = v.trim(); }, { mono: true, ph: 'Optional', label: 'Last excluded address' })}</td>
        <td style="width:20px">${del(() => { x.excluded.splice(i, 1); App.commit(); }, 'Remove range')}</td></tr>`).join('');
      // Relays live on the interfaces facing the clients.
      const relayIfs = (App.sim.byDev[d.id] || []).filter((i) => i.kind !== 'loopback' && i.ip);
      const relays = relayIfs.map((i) => `<div class="grid">${field(`${shortName(i.name)} (${i.net}/${i.len})`, input(i.cfg.helper || '', (v) => { i.cfg.helper = v.trim(); }, { mono: true, ph: 'Server address', label: `${i.name} helper address` }))}</div>`).join('');
      return `<div class="sect"><div class="sect-head"><h3>Pools</h3><div class="btn-row">${fromGw}${btn('Add', addPool)}</div></div>
          <p class="note">${esc(d.name)} answers DHCP requests that arrive on an interface in a pool's network, directly or through a relay. Set hosts to DHCP on their own panel.</p>
          ${pools}</div>
        <div class="sect"><div class="sect-head"><h3>Excluded addresses</h3>${btn('Add', () => { x.excluded.push({ from: '', to: '' }); App.commit(); })}</div>
          ${excl ? `<table><thead><tr><th>From</th><th>To</th><th></th></tr></thead><tbody>${excl}</tbody></table>` : ''}
          <p class="note">Keep gateways, servers and printers out of the pools.</p></div>
        <div class="sect"><div class="sect-head"><h3>Relay (ip helper-address)</h3></div>
          ${relays || '<p class="note">Address an interface first.</p>'}
          <p class="note">When the DHCP server is on another subnet, set the helper on the gateway interface of the clients' subnet to the server's address.</p></div>`;
    }

    // ---------- Routing view ----------

    const connected = (d) => (App.sim.byDev[d.id] || []).filter((i) => i.ip && i.kind !== 'vip');

    function passiveChecks(d, proto) {
      const ifs = connected(d);
      if (!ifs.length) return '';
      return `<div class="f"><span>Passive interfaces (no routing updates sent)</span><div class="checks">${ifs.map((i) => check(shortName(i.name), proto.passive.includes(i.name), (v) => {
        proto.passive = v ? [...proto.passive, i.name] : proto.passive.filter((n) => n !== i.name);
      })).join('')}</div></div>`;
    }

    function redistChecks(d, proto, self) {
      const opts = ['connected', 'static', 'ospf', 'rip', 'bgp'].filter((x) => x !== self && (x === 'connected' || x === 'static' || d.routing[x].enabled));
      return `<div class="f"><span>Redistribute into ${self.toUpperCase()}</span><div class="checks">${opts.map((x) => check(x, proto.redistribute.includes(x), (v) => {
        proto.redistribute = v ? [...proto.redistribute, x] : proto.redistribute.filter((n) => n !== x);
      })).join('')}</div></div>`;
    }

    function staticSection(d) {
      const r = d.routing;
      const rows = r.static.map((s, i) => `<tr>
        <td>${input(s.net, (v) => {
          const m = /^(.+)\/(\d+)$/.exec(v.trim());
          s.net = m ? m[1] : v.trim();
          if (m) s.mask = N.normalizeMask(m[2]) || s.mask;
        }, { mono: true, ph: '0.0.0.0', label: 'Destination network' })}</td>
        <td>${input(s.mask, (v) => { s.mask = N.normalizeMask(v) || v.trim(); }, { mono: true, ph: '0.0.0.0', label: 'Mask' })}</td>
        <td>${input(s.via, (v) => { s.via = v.trim(); }, { mono: true, ph: 'Next hop', label: 'Next hop' })}</td>
        <td style="width:46px">${input(s.ad, (v) => { s.ad = +v || 1; }, { label: 'Administrative distance' })}</td>
        <td style="width:20px">${del(() => { r.static.splice(i, 1); App.commit(); })}</td></tr>`).join('');
      return `<div class="sect"><div class="sect-head"><h3>Static routes</h3><div class="btn-row">
        ${btn('Add default route', () => { r.static.push({ net: '0.0.0.0', mask: '0.0.0.0', via: '', ad: 1 }); App.commit(); })}
        ${btn('Add', () => { r.static.push({ net: '', mask: '255.255.255.0', via: '', ad: 1 }); App.commit(); })}</div></div>
        ${rows ? `<table><thead><tr><th>Network</th><th>Mask</th><th>Via</th><th>AD</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : ''}</div>`;
    }

    // The columns of "show ip ospf neighbor" (priority is always 1, timers are not modelled), plus the reasons for any
    // router on a shared subnet that would not become a neighbor.
    function ospfNeighbors(d, st) {
      const o = d.routing.ospf;
      const nbrs = st.ospfNbrs || [];
      const up = nbrs.filter((n) => n.ok);
      const down = nbrs.filter((n) => !n.ok);
      const source = N.ip2n(o.routerId) !== null ? 'set with router-id'
        : (App.sim.byDev[d.id] || []).some((i) => i.up && i.kind === 'loopback' && i.ip === st.ospfRid) ? 'highest loopback address' : 'highest interface address';
      const table = up.length ? `<table class="nbrs"><thead><tr><th>Neighbor ID</th><th>State</th><th>Address</th><th>Interface</th></tr></thead><tbody>${up.map((n) => `<tr>
          <td class="mono" title="${esc(n.them.dev.name)}">${esc(n.rid)}</td><td><span class="chip ${n.state === 'FULL' ? 'good' : ''}">${esc(`${n.state}/${n.role}`)}</span></td>
          <td class="mono">${esc(n.them.ip)}</td><td class="mono">${esc(shortName(n.me.name))}</td></tr>`).join('')}</tbody></table>`
        : `<p class="note">${down.length ? 'No neighbors formed.' : 'No neighbors. OSPF needs another router on a shared subnet in the same area.'}</p>`;
      const roles = Object.entries(st.ospfRoles || {}).map(([name, role]) => `<span class="chip">${esc(role)} on ${esc(shortName(name))}</span>`).join(' ');
      return `<div class="f"><span>Router ID</span><div class="chips"><span class="chip">${esc(st.ospfRid || 'none')}</span><span class="sub">${st.ospfRid ? esc(source) : 'no up interface has an address'}</span></div></div>
        <div class="sect-head"><h3>show ip ospf neighbor (predicted)</h3></div>
        ${table}
        ${roles ? `<div class="f"><span>This router's role</span><div class="chips">${roles}</div></div>` : ''}
        ${down.map((n) => `<div class="verdict no">No adjacency with ${esc(n.them.dev.name)} on ${esc(shortName(n.me.name))}<small>${esc(n.reason)}</small></div>`).join('')}
        ${up.length ? '<p class="note">The DR and BDR shown assume every router started at the same time. In a real lab the first router up usually keeps DR, because the election does not preempt.</p>' : ''}`;
    }

    function ospfSection(d) {
      const o = d.routing.ospf;
      const st = App.sim.rt[d.id] || {};
      const body = !o.enabled ? '' : `<div class="grid">
          ${field('Process ID', input(o.pid, (v) => { o.pid = +v || 1; }, { label: 'OSPF process ID' }))}
          ${field('Router ID', input(o.routerId, (v) => { o.routerId = v.trim(); }, { mono: true, ph: '1.1.1.1', label: 'Router ID' }))}
        </div>
        <div class="sect-head"><h3>Networks</h3><div class="btn-row">
          ${btn('Add connected networks', () => {
            connected(d).forEach((i) => {
              const net = i.kind === 'loopback' ? i.ip : i.net;
              const wild = i.kind === 'loopback' ? '0.0.0.0' : N.wildcard(i.mask);
              if (!o.networks.some((n) => n.net === net && n.wild === wild)) o.networks.push({ net, wild, area: 0 });
            });
            App.commit();
          })}
          ${btn('Add', () => { o.networks.push({ net: '', wild: '0.0.0.255', area: 0 }); App.commit(); })}</div></div>
        ${o.networks.length ? `<table><thead><tr><th>Network</th><th>Wildcard</th><th>Area</th><th></th></tr></thead><tbody>${o.networks.map((n, i) => `<tr>
          <td>${input(n.net, (v) => {
            const m = /^(.+)\/(\d+)$/.exec(v.trim());
            n.net = m ? m[1] : v.trim();
            if (m && N.normalizeMask(m[2])) n.wild = N.wildcard(N.normalizeMask(m[2]));
          }, { mono: true, ph: '10.0.0.0', label: 'Network' })}</td>
          <td>${input(n.wild, (v) => { n.wild = v.trim(); }, { mono: true, ph: '0.0.0.255', label: 'Wildcard' })}</td>
          <td style="width:56px">${input(n.area, (v) => { n.area = v.trim(); }, { label: 'Area' })}</td>
          <td style="width:20px">${del(() => { o.networks.splice(i, 1); App.commit(); })}</td></tr>`).join('')}</tbody></table>` : ''}
        ${passiveChecks(d, o)}${redistChecks(d, o, 'ospf')}
        ${check('Advertise this router\'s default route', o.defaultOriginate, (v) => { o.defaultOriginate = v; })}
        ${ospfNeighbors(d, st)}`;
      return `<div class="card"><div class="row-head" style="grid-template-columns:1fr auto">${check('OSPF', o.enabled, (v) => { o.enabled = v; })}<span class="chip">AD 110</span></div>${body ? `<div class="card-body">${body}</div>` : ''}</div>`;
    }

    function ripSection(d) {
      const r = d.routing.rip;
      const body = !r.enabled ? '' : `<p class="note">Version 2 with auto-summary off. Network statements are classful.</p>
        <div class="sect-head"><h3>Networks</h3><div class="btn-row">
          ${btn('Add connected networks', () => {
            connected(d).filter((i) => i.kind !== 'loopback').forEach((i) => {
              const net = N.classfulNet(i.ip);
              if (!r.networks.includes(net)) r.networks.push(net);
            });
            App.commit();
          })}
          ${btn('Add', () => { r.networks.push(''); App.commit(); })}</div></div>
        ${r.networks.map((n, i) => `<div class="rule remark">${input(n, (v) => { r.networks[i] = v.trim(); }, { mono: true, ph: '10.0.0.0', label: 'Network' })}${del(() => { r.networks.splice(i, 1); App.commit(); })}</div>`).join('')}
        ${passiveChecks(d, r)}${redistChecks(d, r, 'rip')}
        ${check('Advertise this router\'s default route', r.defaultOriginate, (v) => { r.defaultOriginate = v; })}`;
      return `<div class="card"><div class="row-head" style="grid-template-columns:1fr auto">${check('RIP', r.enabled, (v) => { r.enabled = v; })}<span class="chip">AD 120</span></div>${body ? `<div class="card-body">${body}</div>` : ''}</div>`;
    }

    function bgpSection(d) {
      const b = d.routing.bgp;
      const st = App.sim.rt[d.id] || {};
      const sess = (n) => (st.bgpSessions || []).find((s) => s.neighbor === n);
      const srcs = [['', 'Exit interface'], ...connected(d).filter((i) => i.kind === 'loopback').map((i) => [i.name, i.name])];
      const addPeers = () => {
        connected(d).forEach((i) => S.peersOn(App.sim, i).forEach((j) => {
          if (j.dev.routing && j.dev.routing.bgp.enabled && !b.neighbors.some((n) => n.ip === j.ip)) {
            b.neighbors.push({ ip: j.ip, remoteAs: j.dev.routing.bgp.asn, desc: j.dev.name, updateSource: '', nextHopSelf: false });
          }
        }));
        App.commit();
      };
      const addNets = () => {
        connected(d).forEach((i) => {
          const net = i.kind === 'loopback' ? i.ip : i.net;
          const mask = i.kind === 'loopback' ? '255.255.255.255' : i.mask;
          if (i.kind === 'loopback' || !S.peersOn(App.sim, i).some((j) => j.dev.routing && j.dev.routing.bgp.enabled)) {
            if (!b.networks.some((n) => n.net === net && n.mask === mask)) b.networks.push({ net, mask: i.kind === 'loopback' ? i.mask : mask });
          }
        });
        App.commit();
      };
      const body = !b.enabled ? '' : `<div class="grid">
          ${field('Local AS', input(b.asn, (v) => { b.asn = v.trim(); }, { label: 'Local AS', ph: '65001' }))}
          ${field('Router ID', input(b.routerId, (v) => { b.routerId = v.trim(); }, { mono: true, ph: '1.1.1.1', label: 'Router ID' }))}
        </div>
        <div class="sect-head"><h3>Neighbors</h3><div class="btn-row">${btn('Add connected peers', addPeers)}${btn('Add', () => { b.neighbors.push({ ip: '', remoteAs: '', desc: '', updateSource: '', nextHopSelf: false }); App.commit(); })}</div></div>
        ${b.neighbors.map((n, i) => {
          const s = sess(n);
          const chip = s ? `<span class="chip ${s.state === 'Established' ? 'good' : 'bad'}">${s.state}</span>` : '';
          return `<div class="mini"><div class="mini-head"><span>${esc(n.desc || n.ip || 'New neighbor')}</span><span>${chip}${del(() => { b.neighbors.splice(i, 1); App.commit(); })}</span></div>
            <div class="grid">
              ${field('Neighbor IP', input(n.ip, (v) => { n.ip = v.trim(); }, { mono: true, ph: '203.0.113.2', label: 'Neighbor IP' }))}
              ${field('Remote AS', input(n.remoteAs, (v) => { n.remoteAs = v.trim(); }, { label: 'Remote AS', ph: '64500' }))}
              ${field('Update source', select(n.updateSource, srcs, (v) => { n.updateSource = v; }, 'Update source'))}
            </div>
            ${check('next-hop-self (needed on iBGP peers)', n.nextHopSelf, (v) => { n.nextHopSelf = v; })}
            ${s && s.reason ? `<p class="note">${esc(s.reason)}</p>` : ''}</div>`;
        }).join('')}
        <div class="sect-head"><h3>Advertised networks</h3><div class="btn-row">${btn('Add connected LANs', addNets)}${btn('Add', () => { b.networks.push({ net: '', mask: '255.255.255.0' }); App.commit(); })}</div></div>
        ${b.networks.length ? `<table><thead><tr><th>Network</th><th>Mask</th><th></th></tr></thead><tbody>${b.networks.map((n, i) => `<tr>
          <td>${input(n.net, (v) => { n.net = v.trim(); }, { mono: true, ph: '172.16.1.0', label: 'Network' })}</td>
          <td>${input(n.mask, (v) => { n.mask = N.normalizeMask(v) || v.trim(); }, { mono: true, ph: '255.255.255.0', label: 'Mask' })}</td>
          <td style="width:20px">${del(() => { b.networks.splice(i, 1); App.commit(); })}</td></tr>`).join('')}</tbody></table>` : ''}
        ${redistChecks(d, b, 'bgp')}`;
      return `<div class="card"><div class="row-head" style="grid-template-columns:1fr auto">${check('BGP', b.enabled, (v) => { b.enabled = v; })}<span class="chip">AD 20 / 200</span></div>${body ? `<div class="card-body">${body}</div>` : ''}</div>`;
    }

    function static6Section(d) {
      const r = d.routing;
      const rows = r.static6.map((s, i) => `<tr>
        <td>${input(s.net, (v) => { s.net = v.trim(); }, { mono: true, ph: '::/0', label: 'IPv6 prefix', invalid: s.net && !V6.parsePrefix(s.net) })}</td>
        <td>${input(s.via, (v) => { s.via = v.trim(); }, { mono: true, ph: 'Next hop or interface', label: 'Next hop' })}</td>
        <td style="width:20px">${del(() => { r.static6.splice(i, 1); App.commit(); })}</td></tr>`).join('');
      return `<div class="sect"><div class="sect-head"><h3>IPv6 static routes</h3><div class="btn-row">
        ${btn('Add default route', () => { r.static6.push({ net: '::/0', via: '' }); App.commit(); })}
        ${btn('Add', () => { r.static6.push({ net: '', via: '' }); App.commit(); })}</div></div>
        ${rows ? `<table><thead><tr><th>Prefix</th><th>Via</th><th></th></tr></thead><tbody>${rows}</tbody></table><p class="note">Use a global next hop, or an exit interface name such as GigabitEthernet0/1.</p>` : ''}</div>`;
    }

    function ospf3Section(d) {
      const o = d.routing.ospf3;
      const st = (App.sim.v6 && App.sim.v6.rt[d.id]) || {};
      const nbrs = st.nbrs || [];
      const body = !o.enabled ? '' : `<div class="grid">
          ${field('Process ID', input(o.pid, (v) => { o.pid = +v || 1; }, { label: 'OSPFv3 process ID' }))}
          ${field('Router ID', input(o.routerId, (v) => { o.routerId = v.trim(); }, { mono: true, ph: st.rid || '1.1.1.1', label: 'OSPFv3 router ID' }))}
        </div>
        <p class="note">Set an OSPFv3 area on each interface (Interfaces tab) to join it. ${st.rid ? `Router ID ${esc(st.rid)}.` : '<b>No router ID</b>: this router has no IPv4 address to borrow one from, so set it here.'}</p>
        ${btn('Put every IPv6 interface in area 0', () => {
          const all = [...Object.values(d.ports), ...Object.values(d.ports).flatMap((c) => c.subifs || []), ...d.svis, ...d.loopbacks];
          all.filter((c) => c.ip6 && !c.ospf3).forEach((c) => { c.ospf3 = '0'; });
          App.commit();
        })}
        ${nbrs.length ? `<table class="nbrs"><thead><tr><th>Neighbor ID</th><th>State</th><th>Interface</th></tr></thead><tbody>${nbrs.map((n) => `<tr><td class="mono">${esc(n.rid || n.them.dev.name)}</td>
          <td><span class="chip ${n.ok ? 'good' : 'bad'}">${n.ok ? 'FULL' : 'Down'}</span></td><td class="mono">${esc(shortName(n.me.name))}</td></tr>${n.ok ? '' : `<tr><td colspan="3" class="sub">${esc(n.reason)}</td></tr>`}`).join('')}</tbody></table>` : ''}`;
      return `<div class="card"><div class="row-head" style="grid-template-columns:1fr auto">${check('OSPFv3 (IPv6)', o.enabled, (v) => { o.enabled = v; })}<span class="chip">AD 110</span></div>${body ? `<div class="card-body">${body}</div>` : ''}</div>`;
    }

    function hsrpSummary(d) {
      const mine = App.sim.hsrp.filter((h) => h.devId === d.id);
      if (!mine.length) return '';
      return `<div class="sect"><div class="sect-head"><h3>show standby brief (predicted)</h3></div>
        ${cliBlock(d, 'show standby brief', ['                     P indicates configured to preempt.', 'Interface   Grp  Pri P State   Active          Standby         Virtual IP',
          ...mine.map((h) => {
            const all = App.sim.hsrp.filter((x) => x.iface.domain === h.iface.domain && x.group === h.group);
            const act = all.find((x) => x.state === 'Active');
            const sby = all.find((x) => x.state === 'Standby');
            const show = (x) => (!x ? 'unknown' : x === h ? 'local' : x.iface.ip);
            return `${shortName(h.ifName).padEnd(12)}${String(h.group).padEnd(5)}${String(h.priority).padEnd(4)}${h.preempt ? 'P' : ' '} ${h.state.padEnd(8)}${show(act).padEnd(16)}${show(sby).padEnd(16)}${h.vip}`;
          })])}
        <p class="note">Without preempt, the first router up stays active whatever its priority.</p></div>`;
    }

    function routingView(d) {
      const count = S.showRoutes(App.sim, d).length;
      return `${staticSection(d)}<div class="sect">${ospfSection(d)}${ripSection(d)}${bgpSection(d)}${ospf3Section(d)}</div>${static6Section(d)}${hsrpSummary(d)}
        <div class="sect"><div class="sect-head"><h3>Routing table</h3>${btn(`Show ${count} route${count === 1 ? '' : 's'}`, () => { App.ui.devTab = 'routes'; App.renderPanel(); })}</div>
        <p class="note">The Routes tab has the predicted show ip route, where each route came from, neighbors and peers, and the BGP table.</p></div>`;
    }

    // ---------- Routes view ----------

    const PROTO_NAMES = { C: 'Connected', L: 'Local', S: 'Static', O: 'OSPF', R: 'RIP', B: 'BGP' };
    const ROUTE_CODES = 'Codes: L - local, C - connected, S - static, R - RIP, B - BGP\n       O - OSPF, E2 - OSPF external type 2, * - candidate default';

    function gatewayLine(lines) {
      const def = lines.find((r) => r.len === 0);
      if (!def) return 'Gateway of last resort is not set';
      return def.nh ? `Gateway of last resort is ${def.nh} to network 0.0.0.0` : `Gateway of last resort is 0.0.0.0 to network 0.0.0.0 via ${shortName(def.ifName)}`;
    }

    // "via 10.0.0.2 from R2, Gi0/0" or "directly connected, Gi0/0", with the AS path for BGP.
    function routeDetail(r) {
      const parts = [r.nh ? `via ${r.nh}${r.from ? ` from ${r.from}` : ''}` : 'directly connected'];
      if (r.ifName) parts.push(shortName(r.ifName));
      if (r.path) parts.push(`AS path ${r.path.length ? r.path.join(' ') : '(local)'}`);
      return parts.join(', ');
    }

    function routeRow(r, extra) {
      const cost = r.proto === 'C' || r.proto === 'L' ? '' : `[${r.ad}/${r.metric}]`;
      return `<div class="route"><span class="code c-${esc(r.proto)}" title="${esc(PROTO_NAMES[r.proto] || '')}">${esc(r.code)}</span>
        <div><div class="route-main"><span class="mono">${esc(r.net)}/${r.len}</span><span class="cost">${esc(cost)}</span></div>
        <div class="route-sub">${esc(routeDetail(r))}${extra || ''}</div></div></div>`;
    }

    function neighborRows(d) {
      const st = App.sim.rt[d.id] || {};
      const rows = [];
      const lines = S.showRoutes(App.sim, d);
      const learned = (name, proto) => lines.filter((r) => r.from === name && r.proto === proto).length;
      (st.ospfNbrs || []).forEach((n) => rows.push({ proto: 'OSPF', who: n.them.dev.name, ip: n.them.ip, ifName: n.me.name, ok: n.ok,
        state: n.ok ? `${n.state}/${n.role}` : 'Down', note: n.ok ? `Router ID ${n.rid}` : n.reason, routes: n.ok ? learned(n.them.dev.name, 'O') : null }));
      (st.ripAdj || []).forEach((a) => rows.push({ proto: 'RIP', who: a.them.dev.name, ip: a.them.ip, ifName: a.me.name, ok: true,
        state: 'Updating', note: 'RIPv2 updates every 30 seconds', routes: learned(a.them.dev.name, 'R') }));
      (st.aclBlocks || []).filter((b) => b.what.startsWith('RIP')).forEach((b) => rows.push({ proto: 'RIP', who: b.from.dev.name, ip: b.from.ip, ifName: b.at.name, ok: false,
        state: 'Blocked', note: `Inbound ACL ${b.at.aclIn} drops RIP updates.`, routes: null }));
      ((App.sim.v6 && App.sim.v6.rt[d.id] && App.sim.v6.rt[d.id].nbrs) || []).forEach((n) => rows.push({ proto: 'OSPFv3', who: n.them.dev.name, ip: V6.format(n.them.ll), ifName: n.me.name, ok: n.ok,
        state: n.ok ? 'FULL' : 'Down', note: n.ok ? `Router ID ${n.rid}` : n.reason, routes: n.ok ? V6.showRoutes(App.sim, d).filter((r) => r.from === n.them.dev.name).length : null }));
      (st.bgpSessions || []).forEach((s) => {
        const peer = (App.sim.ifaces.find((i) => i.ip === s.neighbor.ip) || {}).dev;
        const ok = s.state === 'Established';
        rows.push({ proto: 'BGP', who: peer ? peer.name : s.neighbor.ip, ip: s.neighbor.ip, ifName: '', ok, state: s.state,
          note: ok ? `Remote AS ${s.neighbor.remoteAs}` : s.reason, routes: ok && peer ? S.bgpTable(App.sim, d).filter((r) => r.from === peer.name).length : null });
      });
      return rows;
    }

    function routesView(d) {
      const ui = App.ui.routes;
      const lines = S.showRoutes(App.sim, d);
      const shown = ui.proto === 'all' ? lines : lines.filter((r) => r.proto === ui.proto);
      const counts = Object.keys(PROTO_NAMES).map((k) => [k, lines.filter((r) => r.proto === k).length]).filter(([, n]) => n);
      const filter = select(ui.proto, [['all', `All (${lines.length})`], ...counts.map(([k, n]) => [k, `${PROTO_NAMES[k]} (${n})`])], (v) => { ui.proto = v; App.ui.skipCommit = true; }, 'Route source');
      const viewTabs = `<div class="subtabs" role="tablist">${[['table', 'List'], ['cli', 'CLI']].map(([k, t]) => `<button type="button" class="${ui.view === k ? 'on' : ''}" data-a="${act(() => { ui.view = k; App.renderPanel(); })}">${t}</button>`).join('')}</div>`;
      const cli = ui.view === 'cli';
      const routeCmd = ROUTE_CMDS[ui.proto] || ROUTE_CMDS.all;
      let body;
      if (!lines.length) body = '<p class="note">No routes yet. Bring up an interface with an address.</p>';
      else if (cli) {
        const rows = shown.map((r) => `${r.code.padEnd(5)}${r.text}`);
        body = cliBlock(d, routeCmd, ui.proto === 'L' ? rows : [ROUTE_CODES, '', gatewayLine(lines), '', ...rows]);
      } else {
        body = `${cmdHint(routeCmd)}<p class="note">${esc(gatewayLine(lines))}.</p>${shown.map((r) => routeRow(r)).join('') || '<p class="note">No routes from that source.</p>'}`;
      }

      const nbrs = neighborRows(d);
      const protos = ['OSPF', 'RIP', 'BGP', 'OSPFv3'].filter((x) => nbrs.some((n) => n.proto === x));
      let nbrHtml;
      if (!nbrs.length) nbrHtml = '<p class="note">No routing protocol neighbors. Turn on OSPF, RIP, BGP or OSPFv3 on the Routing tab.</p>';
      else if (cli) {
        const down = nbrs.filter((n) => !n.ok);
        nbrHtml = protos.map((x) => neighborCli(d, x)).join('')
          + (down.length ? `<p class="note">IOS lists only working neighbors. Not shown above: ${down.map((n) => `${esc(n.who)} (${esc(n.proto)}, ${esc(n.state)}: ${esc(n.note)})`).join('; ')}</p>` : '')
          + '<p class="note">Timers and message counters are example values. PatchLab does not model them.</p>';
      } else {
        nbrHtml = cmdHint(protos.map((x) => NEIGHBOR_CMDS[x]).join('  ·  ')) + nbrs.map((n) => `<div class="route"><span class="code">${esc(n.proto)}</span><div>
          <div class="route-main"><span>${esc(n.who)} <span class="mono">${esc(n.ip)}</span></span><span class="chip ${n.ok ? 'good' : 'bad'}">${esc(n.state)}</span></div>
          <div class="route-sub">${esc([n.ifName ? shortName(n.ifName) : '', n.note, n.routes === null ? '' : `${n.routes} route${n.routes === 1 ? '' : 's'} learned`].filter(Boolean).join(', '))}</div></div></div>`).join('');
      }

      const hidden = S.hiddenRoutes(App.sim, d);
      const dbCmds = [...new Set(hidden.map((r) => HIDDEN_CMDS[r.proto]).filter(Boolean))];
      const hiddenHtml = hidden.length ? `<div class="sect"><div class="sect-head"><h3>Known but not installed</h3></div>
        <p class="note">Another source offered these prefixes with a lower administrative distance, so show ip route lists only the winner.${dbCmds.length ? ' On the device, look in the protocol\'s own table:' : ''}</p>
        ${dbCmds.length ? cmdHint(dbCmds.join('  ·  '), true) : ''}
        ${hidden.map((r) => routeRow(r, `<br>Lost to ${esc(PROTO_NAMES[r.winner.proto])} [${r.winner.ad}/${r.winner.metric}]`)).join('')}</div>` : '';

      const bgp = S.bgpTable(App.sim, d);
      let bgpBody = '<p class="note">The BGP table is empty. Add network statements or bring up a peer.</p>';
      if (bgp.length && cli) bgpBody = cliBlock(d, 'show ip bgp', bgpCliLines(d, bgp));
      else if (bgp.length) {
        bgpBody = `${cmdHint('show ip bgp')}<table class="nbrs"><thead><tr><th></th><th>Network</th><th>Next hop</th><th>Path</th></tr></thead><tbody>${bgp.map((r) => `<tr>
          <td class="mono" title="${r.best ? 'valid, best' : r.valid ? 'valid' : 'next hop unreachable'}">${r.valid ? '*' : ''}${r.best ? '&gt;' : ''}${r.ibgp ? 'i' : ''}</td>
          <td class="mono">${esc(r.net)}/${r.len}</td><td class="mono" title="${esc(r.from)}">${esc(r.nh)}</td><td class="mono">${esc([...r.path, 'i'].join(' '))}</td></tr>`).join('')}</tbody></table>
          <p class="note">* valid, &gt; best, i (first column) learned over iBGP. The trailing i is the origin code for routes added with a network statement.</p>`;
      }
      const bgpHtml = d.routing.bgp.enabled ? `<div class="sect"><div class="sect-head"><h3>BGP table (predicted)</h3></div>${bgpBody}</div>` : '';

      const v6 = V6.showRoutes(App.sim, d);
      const v6Html = !v6.length ? '' : `<div class="sect"><div class="sect-head"><h3>IPv6 routing table (predicted)</h3></div>
        ${cli ? cliBlock(d, 'show ipv6 route', ['IPv6 Routing Table - default', 'Codes: C - Connected, L - Local, S - Static, O - OSPF Intra', '',
          ...v6.flatMap((r) => [`${r.code.padEnd(3)}${r.net}/${r.len}${r.proto === 'C' || r.proto === 'L' ? '' : ` [${r.ad}/${r.metric}]`}`,
            `     ${r.nh ? `via ${r.nh}${r.ifName ? `, ${r.ifName}` : ''}` : `via ${r.ifName}, ${r.proto === 'L' ? 'receive' : 'directly connected'}`}`])])
          : cmdHint('show ipv6 route') + v6.map((r) => routeRow({ ...r, code: r.code }, '')).join('')}</div>`;
      return `<div class="sect"><div class="sect-head"><h3>Routing table (predicted)</h3>${viewTabs}</div>
          ${lines.length ? field('Show', filter) : ''}${body}</div>
        <div class="sect"><div class="sect-head"><h3>Neighbors and peers</h3></div>${nbrHtml}</div>
        ${hiddenHtml}${bgpHtml}${v6Html}`;
    }

    // The IOS command that prints each view, so students can run the same check on real gear.
    const ROUTE_CMDS = {
      all: 'show ip route', C: 'show ip route connected', L: 'show ip route | include ^L', S: 'show ip route static',
      O: 'show ip route ospf', R: 'show ip route rip', B: 'show ip route bgp',
    };
    const NEIGHBOR_CMDS = { OSPF: 'show ip ospf neighbor', RIP: 'show ip protocols | section rip', BGP: 'show ip bgp summary', OSPFv3: 'show ipv6 ospf neighbor' };
    const HIDDEN_CMDS = { O: 'show ip ospf database', R: 'show ip rip database', B: 'show ip bgp', S: 'show running-config | include ip route' };

    function cmdHint(cmd, bare) {
      return `<p class="cmd-hint">${bare ? '' : 'On the device: '}<code>${esc(cmd)}</code></p>`;
    }

    // A terminal block: the prompt and command, then the predicted output.
    function cliBlock(d, cmd, out) {
      return `<pre class="cli scroll" tabindex="0"><span class="prompt">${esc(d.name)}#</span><span class="typed">${esc(cmd)}</span>\n${esc(out.join('\n'))}</pre>`;
    }

    function bgpRouterId(d) {
      if (N.ip2n(d.routing.bgp.routerId) !== null) return d.routing.bgp.routerId;
      const ups = (App.sim.byDev[d.id] || []).filter((i) => i.up && i.ip).sort((a, b) => N.ip2n(b.ip) - N.ip2n(a.ip));
      return (ups.find((i) => i.kind === 'loopback') || ups[0] || {}).ip || '0.0.0.0';
    }

    function bgpCliLines(d, bgp) {
      return [
        `BGP table version is ${bgp.length + 1}, local router ID is ${bgpRouterId(d)}`,
        'Status codes: * valid, > best, i - internal',
        'Origin codes: i - IGP, e - EGP, ? - incomplete',
        '',
        '     Network          Next Hop            Metric LocPrf Weight Path',
        ...bgp.map((r) => {
          const status = `${r.valid ? '*' : ' '}${r.best ? '>' : ' '}${r.ibgp ? 'i' : ' '}`;
          const metric = r.local ? '0' : '';
          const locPrf = r.ibgp ? '100' : '';
          const weight = r.local ? '32768' : '0';
          return ` ${status} ${`${r.net}/${r.len}`.padEnd(17)}${r.nh.padEnd(20)}${metric.padStart(6)}${locPrf.padStart(7)}${weight.padStart(7)} ${[...r.path, 'i'].join(' ')}`;
        }),
      ];
    }

    function neighborCli(d, proto) {
      const st = App.sim.rt[d.id] || {};
      if (proto === 'OSPF') {
        const up = (st.ospfNbrs || []).filter((n) => n.ok);
        return cliBlock(d, NEIGHBOR_CMDS.OSPF, [
          '',
          'Neighbor ID     Pri   State           Dead Time   Address         Interface',
          ...up.map((n) => `${n.rid.padEnd(16)}${'1'.padStart(3)}   ${`${n.state}/${n.role}`.padEnd(16)}00:00:35    ${n.them.ip.padEnd(16)}${n.me.name}`),
        ]);
      }
      if (proto === 'OSPFv3') {
        const up = ((App.sim.v6.rt[d.id] || {}).nbrs || []).filter((n) => n.ok);
        return cliBlock(d, NEIGHBOR_CMDS.OSPFv3, [
          '', '            OSPFv3 Router with ID (' + App.sim.v6.rt[d.id].rid + ') (Process ID ' + d.routing.ospf3.pid + ')', '',
          'Neighbor ID     Pri   State           Dead Time   Interface ID    Interface',
          ...up.map((n) => `${n.rid.padEnd(16)}${'1'.padStart(3)}   ${'FULL/  -'.padEnd(16)}00:00:35    ${'3'.padEnd(16)}${n.me.name}`),
        ]);
      }
      if (proto === 'RIP') {
        const r = d.routing.rip;
        return cliBlock(d, NEIGHBOR_CMDS.RIP, [
          'Routing Protocol is "rip"',
          '  Sending updates every 30 seconds, next due in 12 seconds',
          '  Default version control: send version 2, receive version 2',
          `  Automatic network summarization is not in effect`,
          '  Routing for Networks:',
          ...[...new Set(r.networks.filter((n) => N.ip2n(n) !== null).map((n) => N.classfulNet(n)))].map((n) => `    ${n}`),
          ...(r.passive.length ? ['  Passive Interface(s):', ...r.passive.map((n) => `    ${n}`)] : []),
          '  Routing Information Sources:',
          '    Gateway         Distance      Last Update',
          ...(st.ripAdj || []).map((a) => `    ${a.them.ip.padEnd(16)}${'120'.padStart(8)}      00:00:12`),
          '  Distance: (default is 120)',
        ]);
      }
      const sessions = st.bgpSessions || [];
      const table = S.bgpTable(App.sim, d);
      return cliBlock(d, NEIGHBOR_CMDS.BGP, [
        `BGP router identifier ${bgpRouterId(d)}, local AS number ${d.routing.bgp.asn}`,
        '',
        'Neighbor        V           AS MsgRcvd MsgSent   TblVer  InQ OutQ Up/Down  State/PfxRcd',
        ...sessions.map((s) => {
          const ok = s.state === 'Established';
          const peer = (App.sim.ifaces.find((i) => i.ip === s.neighbor.ip) || {}).dev;
          const pfx = ok && peer ? String(table.filter((r) => r.from === peer.name).length) : s.state;
          return `${s.neighbor.ip.padEnd(16)}4 ${String(s.neighbor.remoteAs).padStart(12)}${(ok ? '12' : '0').padStart(8)}${(ok ? '12' : '0').padStart(8)}${String(ok ? table.length + 1 : 1).padStart(9)}    0    0 ${(ok ? '00:05:12' : 'never').padEnd(9)}${pfx.padStart(12)}`;
        }),
      ]);
    }

    // ---------- ACL view ----------

    const newRule = () => ({ action: 'permit', proto: 'ip', src: 'any', dst: 'any', srcOp: 'any', srcPort: '', srcPort2: '', op: 'any', port: '', port2: '' });

    function ruleRow(acl, r, i, d) {
      const remove = del(() => { acl.rules.splice(i, 1); App.commit(); }, 'Remove line');
      if (r.remark !== undefined) {
        return `<div class="rule remark">${input(r.remark, (v) => { r.remark = v; }, { ph: 'Remark', label: 'Remark' })}${remove}</div>`;
      }
      const action = select(r.action, [['permit', 'permit'], ['deny', 'deny']], (v) => { r.action = v; }, 'Action');
      const addr = (key, ph) => input(r[key], (v) => { r[key] = v.trim(); }, { mono: true, ph, label: key === 'src' ? 'Source' : 'Destination', invalid: !N.parseAclAddr(r[key]) });
      const log = check('log', r.log, (v) => { r.log = v; });
      if (acl.type === 'standard') return `<div class="rule standard">${action}${addr('src', 'any, host x, net/nn')}${remove}</div><div class="rule-extra">${log}</div>`;
      const proto = select(r.proto, ACL_PROTOCOLS, (v) => { r.proto = v; }, 'Protocol');
      let extra = '';
      if (r.proto === 'tcp' || r.proto === 'udp') {
        extra = `<div class="rule-extra ports">${portMatch(r, 'Source port', 'srcOp', 'srcPort', 'srcPort2')}</div>
          <div class="rule-extra ports">${portMatch(r, 'Dest. port', 'op', 'port', 'port2')}
          ${r.proto === 'tcp' ? check('established', r.established, (v) => { r.established = v; }) : ''}${log}</div>`;
      } else if (r.proto === 'icmp') {
        extra = `<div class="rule-extra"><span class="lbl">ICMP type</span>${select(r.icmpType || '', [['', 'any type'], ...ICMP_TYPES.map((x) => [x, x])], (v) => { r.icmpType = v; }, 'ICMP type')}${log}</div>`;
      } else {
        extra = `<div class="rule-extra">${log}</div>`;
      }
      return `<div class="rule">${action}${proto}${addr('src', 'source')}${addr('dst', 'destination')}${remove}</div>${extra}`;
    }

    // Operator plus one or two port boxes. A blank box matches any port.
    function portMatch(r, label, opKey, loKey, hiKey) {
      const op = r[opKey] && r[opKey] !== 'any' ? r[opKey] : 'any';
      const box = (key, ph) => input(r[key], (v) => { r[key] = v.trim(); }, { mono: true, ph, label: `${label} ${ph}`, list: 'acl-port-list', invalid: r[key] !== undefined && r[key] !== '' && portNum(r.proto, r[key]) === null });
      const ops = select(op, [['any', 'any'], ['eq', 'eq'], ['neq', 'neq'], ['gt', 'gt'], ['lt', 'lt'], ['range', 'range']], (v) => { r[opKey] = v; }, `${label} match`);
      return `<span class="lbl">${esc(label)}</span>${ops}${op === 'any' ? '' : box(loKey, op === 'range' ? 'from' : 'port')}${op === 'range' ? box(hiKey, 'to') : ''}`;
    }

    function aclCard(d, acl, i) {
      const uses = [];
      Object.entries(d.ports).forEach(([name, c]) => {
        [[c, name], ...(c.subifs || []).map((s) => [s, `${name}.${s.num}`])].forEach(([x, n]) => {
          if (x.aclIn === acl.name) uses.push(`${shortName(n)} in`);
          if (x.aclOut === acl.name) uses.push(`${shortName(n)} out`);
        });
      });
      d.svis.forEach((s) => {
        if (s.aclIn === acl.name) uses.push(`Vlan${s.vlan} in`);
        if (s.aclOut === acl.name) uses.push(`Vlan${s.vlan} out`);
      });
      if (d.vtyAcl === acl.name) uses.push('VTY lines');
      const rename = (v) => {
        const name = v.trim().replace(/\s+/g, '_');
        if (!name || name === acl.name) return;
        const swap = (x) => {
          if (x.aclIn === acl.name) x.aclIn = name;
          if (x.aclOut === acl.name) x.aclOut = name;
        };
        Object.values(d.ports).forEach((c) => { swap(c); (c.subifs || []).forEach(swap); });
        d.svis.forEach(swap);
        if (d.vtyAcl === acl.name) d.vtyAcl = name;
        acl.name = name;
      };
      const remove = () => {
        const clear = (x) => {
          if (x.aclIn === acl.name) x.aclIn = '';
          if (x.aclOut === acl.name) x.aclOut = '';
        };
        Object.values(d.ports).forEach((c) => { clear(c); (c.subifs || []).forEach(clear); });
        d.svis.forEach(clear);
        if (d.vtyAcl === acl.name) d.vtyAcl = '';
        d.acls.splice(i, 1);
        App.commit();
      };
      const addRule = () => {
        acl.rules.push(acl.type === 'standard' ? { action: 'permit', src: 'any' } : newRule());
        App.commit();
      };
      // Sub-interfaces and SVIs show up in sim.ifaces; uncabled ports do not need an ACL.
      const targets = connected(d).filter((x) => x.kind !== 'loopback');
      const apply = App.ui.apply[acl.id] || { name: targets[0] ? targets[0].name : '', dir: 'in' };
      App.ui.apply[acl.id] = apply;
      const applyRow = targets.length ? `<div class="grid">
        ${field('Apply to', select(apply.name, [...targets.map((t) => [t.name, shortName(t.name)]), ['__vty', 'VTY lines (remote login)']], (v) => { apply.name = v; App.renderPanel(); }, 'Interface'))}
        ${field('Direction', select(apply.dir, [['in', 'Inbound'], ['out', 'Outbound']], (v) => { apply.dir = v; App.renderPanel(); }, 'Direction'))}
        <div class="f"><span>&nbsp;</span>${btn('Apply', () => {
          if (apply.name === '__vty') d.vtyAcl = acl.name;
          else {
            const t = targets.find((x) => x.name === apply.name);
            if (t) t.cfg[apply.dir === 'in' ? 'aclIn' : 'aclOut'] = acl.name;
          }
          App.commit();
        })}</div></div>` : '<p class="note">Address an interface first, then apply this list to it.</p>';
      return `<div class="card"><div class="card-body" style="border-top:0">
        <div class="mini-head"><span>${esc(acl.type)}</span>${del(remove, 'Delete ACL')}</div>
        ${field('Name or number', input(acl.name, rename, { mono: true, label: 'ACL name' }))}
        ${acl.rules.map((r, j) => ruleRow(acl, r, j, d)).join('')}
        <div class="rule-num">deny all traffic (implicit, always last)</div>
        <div class="btn-row">${btn('Add rule', addRule)}${btn('Add remark', () => { acl.rules.push({ remark: '' }); App.commit(); })}</div>
        ${applyRow}
        <div class="chips">${uses.length ? uses.map((u) => `<span class="chip good">${esc(u)}</span>`).join('') : '<span class="chip warn">Not applied</span>'}</div>
      </div></div>`;
    }

    function aclView(d) {
      const nextNum = (lo, hi) => {
        for (let n = lo; n <= hi; n++) if (!d.acls.some((a) => a.name === String(n))) return String(n);
        return `ACL_${Date.now()}`;
      };
      const add = (type) => {
        d.acls.push({ id: M.uid('a'), type, name: type === 'standard' ? nextNum(10, 99) : nextNum(100, 199), rules: [] });
        const acl = d.acls[d.acls.length - 1];
        acl.rules.push(type === 'standard' ? { action: 'permit', src: 'any' } : newRule());
        App.commit();
      };
      return `<div class="sect"><div class="sect-head"><h3>Access lists</h3><div class="btn-row">${btn('New standard', () => add('standard'))}${btn('New extended', () => add('extended'))}</div></div>
        <p class="note">Addresses accept any, host 10.0.0.1, 10.0.0.0/24 or 10.0.0.0 0.0.0.255. Rules run top to bottom and the first match wins.
        Extended lists also match the protocol and, for tcp and udp, the source and destination ports: type a number or an IOS keyword such as www, or pick from the list.</p>
        <datalist id="acl-port-list">${ACL_PORTS.map(([n, t]) => `<option value="${n}">${esc(t)}</option>`).join('')}</datalist>
        ${d.acls.map((a, i) => aclCard(d, a, i)).join('')}</div>`;
    }

    // ---------- Spanning tree view ----------

    function stpView(d) {
      const stp = App.sim.stp;
      const vlans = Object.keys(stp.byVlan).map(Number).filter((v) => stp.byVlan[v].bridges[d.id]);
      const ui = App.ui.stp;
      if (!vlans.includes(ui.vlan)) ui.vlan = vlans.find((v) => v !== 1) || vlans[0];
      const prioOpts = PL.stp.PRIORITIES.map((x) => [x, x === 32768 ? '32768 (default)' : String(x)]);
      const setAll = (val) => { vlans.forEach((v) => { d.stp.priority[v] = val; }); App.commit(); };
      const rows = vlans.map((v) => {
        const r = stp.byVlan[v];
        const me = r.bridges[d.id];
        const root = M.dev(App.project, me.rootDev || d.id);
        const blocked = me.ports.filter((x) => x.state === 'BLK');
        return `<tr><td>${v}</td><td style="width:132px">${select(d.stp.priority[v] === undefined ? 32768 : d.stp.priority[v], prioOpts, (val) => { d.stp.priority[v] = +val; }, `VLAN ${v} priority`)}</td>
          <td>${root === d ? '<span class="chip good">Root</span>' : esc(root.name)}</td><td>${root === d ? '0' : me.cost}</td>
          <td>${blocked.length ? `<span class="chip bad">${esc(blocked.map((x) => shortName(x.name)).join(', '))}</span>` : ''}</td></tr>`;
      }).join('');
      const v = ui.vlan;
      const r = stp.byVlan[v];
      const me = r && r.bridges[d.id];
      const roleName = { root: 'Root', designated: 'Designated', alternate: 'Alternate (blocking)' };
      const detail = !me ? '' : ui.view === 'cli' ? cliBlock(d, `show spanning-tree vlan ${v}`, PL.stp.showLines(stp, d, v))
        : `${cmdHint(`show spanning-tree vlan ${v}`)}<dl class="fact"><dt>Bridge ID</dt><dd>${me.prio} ${esc(me.mac)}</dd><dt>Root</dt><dd>${esc(M.dev(App.project, me.rootDev || d.id).name)}${me.rootDev === d.id ? ' (this switch)' : `, cost ${me.cost}`}</dd></dl>
          ${me.ports.map((x) => `<div class="route"><span class="code ${x.state === 'BLK' ? 'c-blk' : ''}">${x.role === 'root' ? 'RP' : x.role === 'designated' ? 'DP' : 'ALT'}</span><div>
            <div class="route-main"><span class="mono">${esc(shortName(x.name))}</span><span class="chip ${x.state === 'BLK' ? 'bad' : 'good'}">${x.state === 'BLK' ? 'Blocking' : 'Forwarding'}</span></div>
            <div class="route-sub">${esc(`${roleName[x.role]} to ${x.peer}, cost ${x.cost}, port 128.${x.id}${x.edge ? ', edge' : ''}`)}</div></div></div>`).join('')}`;
      const viewTabs = `<div class="subtabs" role="tablist">${[['table', 'List'], ['cli', 'CLI']].map(([k, t]) => `<button type="button" class="${ui.view === k ? 'on' : ''}" data-a="${act(() => { ui.view = k; App.renderPanel(); })}">${t}</button>`).join('')}</div>`;
      return `<div class="sect"><div class="sect-head"><h3>Bridge priority per VLAN</h3><div class="btn-row">${btn('Make root', () => setAll(4096))}${btn('Make backup root', () => setAll(8192))}${btn('Reset', () => setAll(32768))}</div></div>
          <p class="note">Rapid PVST+ runs one tree per VLAN. The lowest priority becomes root, then the lowest MAC (${esc(d.stp.mac)} here, a stand-in for the real one).</p>
          ${vlans.length ? `<table><thead><tr><th>VLAN</th><th>Priority</th><th>Root</th><th>Cost</th><th>Blocking</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="note">No VLANs on this switch yet.</p>'}</div>
        ${me ? `<div class="sect"><div class="sect-head"><h3>Ports in VLAN</h3>${viewTabs}</div>${field('VLAN', select(v, vlans.map((x) => [x, `VLAN ${x}`]), (val) => { ui.vlan = +val; App.ui.skipCommit = true; }, 'VLAN'))}${detail}</div>` : ''}`;
    }

    // ---------- Security view (switches) ----------

    function securityView(d) {
      const p = App.project;
      const sn = d.snooping;
      const links = M.linksOf(p, d.id).filter((l) => !M.isL3End(p, l, d.id)).sort((a, b) => naturalCompare(M.endIf(a, d.id), M.endIf(b, d.id)));
      const access = links.filter((l) => l.mode === 'access');
      const ps = access.map((l) => {
        const name = M.endIf(l, d.id);
        const c = M.port(d, name);
        const peer = M.dev(p, M.peerOf(l, d.id));
        const st = App.sim.portSec.find((x) => x.devId === d.id && x.ifName === name);
        const sec = c.portSec;
        return `<div class="mini"><div class="mini-head"><span>${esc(shortName(name))} <span class="sub">to ${esc(peer.name)}</span></span>
          ${st ? `<span class="chip ${st.violated ? 'bad' : 'good'}">${st.count}/${st.max} MAC${st.violated ? (st.violation === 'shutdown' ? ', err-disabled' : `, ${st.violation}`) : ''}</span>` : ''}</div>
          ${check('Port security', !!sec, (v) => { c.portSec = v ? { max: 1, sticky: true, violation: 'shutdown' } : null; })}
          ${sec ? `<div class="grid">${field('Maximum MACs', input(sec.max, (v) => { sec.max = Math.max(1, Math.min(132, +v || 1)); }, { type: 'number', label: 'Maximum MAC addresses' }))}
            ${field('Violation', select(sec.violation, [['shutdown', 'shutdown (err-disable)'], ['restrict', 'restrict (drop and log)'], ['protect', 'protect (drop silently)']], (v) => { sec.violation = v; }, 'Violation mode'))}</div>
            ${check('Sticky (learned MACs saved to the config)', sec.sticky, (v) => { sec.sticky = v; })}` : ''}</div>`;
      }).join('');
      const trust = links.map((l) => {
        const name = M.endIf(l, d.id);
        const peer = M.dev(p, M.peerOf(l, d.id));
        return check(`${shortName(name)} to ${peer.name}`, !!M.port(d, name).trust, (v) => { M.port(d, name).trust = v; });
      }).join('');
      return `<div class="sect"><div class="sect-head"><h3>DHCP snooping</h3></div>
          ${check('Enable DHCP snooping', sn.on, (v) => { sn.on = v; if (v && !sn.vlans) sn.vlans = N.compressList(M.vlansOnSwitch(p, d)); })}
          ${sn.on ? `${field('VLANs', input(sn.vlans, (v) => { sn.vlans = v.trim(); }, { mono: true, ph: '10,20', label: 'Snooping VLANs' }))}
            <div class="f"><span>Trusted ports (toward the real DHCP server)</span><div class="checks">${trust || '<span class="sub">No switchports cabled.</span>'}</div></div>
            <p class="note">Untrusted ports drop DHCP offers, so a rogue server on an access port cannot hand out addresses. Verify shows which offers are dropped.</p>` : ''}</div>
        <div class="sect"><div class="sect-head"><h3>Port security on access ports</h3></div>
          <p class="note">Limits how many MAC addresses a port learns. Verify counts the devices behind each port.</p>
          ${ps || '<p class="note">No access ports yet.</p>'}</div>`;
    }

    // ---------- NAT view ----------

    function natView(d) {
      const n = d.nat;
      const ifs = connected(d).filter((i) => i.kind !== 'loopback');
      const roles = ifs.map((i) => field(shortName(i.name), select(i.cfg.nat || '', [['', 'Not NAT'], ['inside', 'inside'], ['outside', 'outside']], (v) => { i.cfg.nat = v; }, `${i.name} NAT role`))).join('');
      const outside = ifs.filter((i) => i.cfg.nat === 'outside');
      const std = d.acls.filter((a) => a.type === 'standard');
      const pat = n.pat;
      const patBody = pat ? `<div class="grid">
          ${field('Inside addresses (ACL)', select(pat.acl, [['', 'Pick a standard ACL'], ...std.map((a) => [a.name, a.name])], (v) => { pat.acl = v; }, 'PAT ACL'))}
          ${field('Overload interface', select(pat.iface, [['', 'Pick the outside interface'], ...outside.map((i) => [i.name, shortName(i.name)])], (v) => { pat.iface = v; }, 'PAT interface'))}</div>
          ${std.length ? '' : `<div class="btn-row">${btn('Create ACL for inside subnets', () => {
            const name = String([...Array(99).keys()].map((x) => x + 1).find((x) => !d.acls.some((a) => a.name === String(x))));
            const rules = ifs.filter((i) => i.cfg.nat === 'inside').map((i) => ({ action: 'permit', src: `${i.net} ${N.wildcard(i.mask)}` }));
            d.acls.push({ id: M.uid('a'), name, type: 'standard', rules: rules.length ? rules : [{ action: 'permit', src: 'any' }] });
            pat.acl = name;
            App.commit();
          })}</div>`}` : '';
      const statics = n.statics.map((x, i) => `<tr><td>${input(x.local, (v) => { x.local = v.trim(); }, { mono: true, ph: '192.168.1.10', label: 'Inside local' })}</td>
        <td>${input(x.global, (v) => { x.global = v.trim(); }, { mono: true, ph: '203.0.113.10', label: 'Inside global' })}</td><td style="width:20px">${del(() => { n.statics.splice(i, 1); App.commit(); })}</td></tr>`).join('');
      const last = App.ui.pingResult && (App.ui.pingResult.res.nat || []).filter((x) => x.dev === d.id);
      const trans = [...n.statics.map((x) => ['---', x.global, x.local]), ...(last || []).filter((x) => x.kind === 'pat').map((x) => [App.ui.pingResult.svc.proto, `${x.global}:${x.port || 1}`, `${x.local}:${x.port || 1}`])];
      return `<div class="sect"><div class="sect-head"><h3>Interfaces</h3></div><div class="grid">${roles || '<p class="note">Address an interface first.</p>'}</div>
          <p class="note">Inside faces your LAN, outside faces the ISP. Translation happens as traffic crosses from one to the other.</p></div>
        <div class="sect"><div class="sect-head"><h3>PAT (overload)</h3></div>${check('Translate inside hosts to the outside interface address', !!pat, (v) => { n.pat = v ? { acl: '', iface: outside[0] ? outside[0].name : '' } : null; })}${patBody}</div>
        <div class="sect"><div class="sect-head"><h3>Static NAT</h3>${btn('Add', () => { n.statics.push({ local: '', global: '' }); App.commit(); })}</div>
          ${statics ? `<table><thead><tr><th>Inside local</th><th>Inside global</th><th></th></tr></thead><tbody>${statics}</tbody></table>` : ''}
          <p class="note">A static entry also lets outside hosts open connections to the inside server through its global address.</p></div>
        <div class="sect"><div class="sect-head"><h3>show ip nat translations (predicted)</h3></div>
          ${trans.length ? cliBlock(d, 'show ip nat translations', ['Pro  Inside global         Inside local          Outside local         Outside global', ...trans.map(([pr, g, l]) => `${pr.padEnd(5)}${g.padEnd(22)}${l.padEnd(22)}---                   ---`)]) : ''}
          <p class="note">PAT entries appear after test traffic crosses this router. Run one on the Verify tab.</p></div>`;
    }

    function deviceView(d) {
      if (M.isHost(d)) return deviceHead(d) + hostView(d);
      const list = [['if', M.isRouter(d) ? 'Interfaces' : 'Ports']];
      if (M.canRoute(d)) list.push(['routing', 'Routing'], ['routes', 'Routes'], ['dhcp', 'DHCP']);
      if (M.isSwitch(d)) list.push(['stp', 'STP'], ['security', 'Security']);
      if (M.canRoute(d)) list.push(['nat', 'NAT']);
      list.push(['acl', 'ACLs']);
      let cur = App.ui.devTab;
      if (!list.some(([k]) => k === cur)) cur = 'if';
      const views = { routing: routingView, routes: routesView, dhcp: dhcpView, acl: aclView, stp: stpView, security: securityView, nat: natView };
      const body = (views[cur] || interfacesView)(d);
      return deviceHead(d) + subtabs('devTab', list, cur) + body;
    }

    // ---------- Link view ----------

    function linkView(l) {
      const p = App.project;
      const a = M.dev(p, l.a);
      const b = M.dev(p, l.b);
      const modes = M.allowedModes(a, b);
      const sameRole = (x, y) => M.isSwitch(x) === M.isSwitch(y);
      const cable = sameRole(a, b) ? 'Crossover (auto-MDIX ports accept straight-through)' : 'Straight-through';
      const speedText = (n) => {
        const sp = portSpeed(n);
        return sp ? `, ${sp >= 1000 ? `${sp / 1000} Gbps` : `${sp} Mbps`}` : '';
      };
      // Each end offers its own free ports plus the one it already uses.
      const portPick = (m, s) => {
        const d = s === 'a' ? a : b;
        const opts = MODELS[d.model].ports.filter((n) => n === m[s] || !M.linkOnPort(p, d.id, n)).sort(naturalCompare);
        return select(m[s], opts.map((n) => [n, `${shortName(n)}${speedText(n)}`]), (v) => {
          if (!l.ec) M.renameCfg(d, m[s], v);
          m[s] = v;
          M.port(d, v);
        }, `${d.name} interface`);
      };
      const groupOf = (x) => (x.a === l.a ? x.ec.groupA : x.ec.groupB);

      const modeNames = { access: 'Access', trunk: 'Trunk', routed: 'Routed' };
      let html = `<div class="head"><div><h2>${esc(a.name)} to ${esc(b.name)}</h2><p>Ethernet cable. ${esc(cable)}</p></div>${btn('Delete', () => App.deleteSelection(), 'danger')}</div>`;

      html += `<div class="sect"><div class="sect-head"><h3>Interfaces</h3></div>`;
      if (!l.ec) {
        html += `<div class="grid">${field(`Source: ${a.name}`, portPick(l.members[0], 'a'))}${field(`Destination: ${b.name}`, portPick(l.members[0], 'b'))}</div>`;
      } else {
        html += `<p class="note">Bundled as ${esc(`Port-channel${l.ec.groupA}`)} on ${esc(a.name)} and ${esc(`Port-channel${l.ec.groupB}`)} on ${esc(b.name)}. Each row is one physical cable.</p>
          <table><thead><tr><th>Source: ${esc(a.name)}</th><th>Destination: ${esc(b.name)}</th><th></th></tr></thead><tbody>${l.members.map((m, i) => `<tr><td>${portPick(m, 'a')}</td><td>${portPick(m, 'b')}</td>
            <td style="width:20px">${l.members.length > 1 ? del(() => {
              const r = M.splitMember(p, l, i);
              if (r.error) App.toast(r.error);
              App.commit();
            }, 'Take this cable out of the bundle') : ''}</td></tr>`).join('')}</tbody></table>`;
      }
      html += '</div>';

      if (modes.length > 1) {
        html += `<div class="subtabs" role="tablist">${modes.map((m) => `<button type="button" class="${l.mode === m ? 'on' : ''}" data-a="${act(() => {
          l.mode = m;
          App.commit();
        })}">${modeNames[m]}</button>`).join('')}</div>`;
      }

      if (l.mode === 'access') {
        html += `<div class="sect"><div class="sect-head"><h3>Access VLAN</h3></div>
          ${select(l.vlan, vlanOptions(), (v) => { l.vlan = +v; }, 'Access VLAN')}
          <p class="note">Every device behind this port joins this one VLAN. Add VLANs on the Lab tab.</p></div>`;
      }

      if (l.mode === 'trunk') {
        const list = M.allowedVlans(p, l);
        const toggle = (id, on) => {
          const cur = l.allowed === 'all' ? p.vlans.map((v) => v.id) : N.expandList(l.allowed);
          const next = on ? [...cur, id] : cur.filter((x) => x !== id);
          l.allowed = next.length === p.vlans.length ? 'all' : N.compressList(next);
        };
        html += `<div class="sect"><div class="sect-head"><h3>Trunk</h3></div>
          <div class="grid">${field('Native VLAN', select(l.nativeVlan, vlanOptions(), (v) => { l.nativeVlan = +v; }, 'Native VLAN'))}</div>
          <div class="f"><span>Allowed VLANs</span><div class="checks">${p.vlans.map((v) => check(`${v.id} ${v.name}`, list.includes(v.id), (on) => toggle(v.id, on))).join('')}</div></div>
          </div>`;
      }

      // L3 ends expose their addressing here too, since this is where students are looking.
      const l3Ends = [a, b].filter((d) => M.isL3End(p, l, d.id) && !M.isHost(d));
      const subs = l3Ends.filter((d) => M.isRouter(d) && l.mode === 'trunk');
      subs.forEach((d) => {
        const name = M.endIf(l, d.id);
        html += subifSection(d, name, M.port(d, name), l);
      });
      if (l.mode !== 'trunk') {
        const ends = [a, b].filter((d) => M.isL3End(p, l, d.id));
        if (ends.length) {
          const assign = ends.length === 2 ? btn('Assign a /30', () => {
            const s = M.nextP2P(p);
            Object.assign(M.port(a, M.endIf(l, a.id)), { ip: s.a, mask: s.mask });
            Object.assign(M.port(b, M.endIf(l, b.id)), { ip: s.b, mask: s.mask });
            App.commit();
          }) : '';
          html += `<div class="sect"><div class="sect-head"><h3>Addressing</h3>${assign}</div>
            ${ends.map((d) => {
              const c = M.port(d, M.endIf(l, d.id));
              return `<div class="grid">${field(`${d.name} ${shortName(M.endIf(l, d.id))} IP`, ipInput(c))}${field('Mask', maskInput(c))}</div>`;
            }).join('')}</div>`;
        }
      }

      const presets = M.ecPresetsFor(a, b);
      if (presets.length) {
        html += '<div class="sect"><div class="sect-head"><h3>EtherChannel</h3></div>';
        if (!l.ec) {
          const others = M.channelsFor(p, l);
          const opts = [['', 'Not bundled'],
            ...others.map((x) => [x.id, `Add to Port-channel${groupOf(x)} (${x.members.length} cable${x.members.length > 1 ? 's' : ''})`]),
            ['new', 'New Port-channel with this cable']];
          html += select('', opts, (v) => {
            if (!v) return;
            const r = v === 'new' ? M.setChannel(p, l, true, { single: true }) : M.joinChannel(p, l, others.find((x) => x.id === v));
            if (r.error) return App.toast(r.error);
            if (r.link) App.select('link', r.link.id);
          }, 'EtherChannel');
          html += `<p class="note">${others.length
            ? `${esc(a.name)} and ${esc(b.name)} already have a bundle. Add this cable to it, and it takes the bundle's VLAN and IP settings.`
            : `Draw more cables between ${esc(a.name)} and ${esc(b.name)}, then add each one to the same Port-channel.`}</p>`;
        } else {
          const fieldsGroup = (key, name) => field(`${name} channel group`, input(l.ec[key], (v) => {
            const n = +v;
            if (!(n >= 1 && n <= 64)) return;
            const d = key === 'groupA' ? a : b;
            const from = `Port-channel${l.ec[key]}`;
            l.ec[key] = n;
            M.renameCfg(d, from, `Port-channel${n}`);
          }, { type: 'number', label: `${name} channel group` }));
          html += `<div class="grid">${field('Protocol', select(l.ec.preset, presets.map((k) => [k, M.EC_PRESETS[k].label]), (v) => { l.ec.preset = v; }, 'Channel protocol'))}</div>
            <div class="grid">${fieldsGroup('groupA', a.name)}${fieldsGroup('groupB', b.name)}</div>
            <div class="btn-row">${btn('Add member', () => {
              const r = M.addMember(p, l);
              if (r.error) App.toast(r.error);
              App.commit();
            })}${btn('Unbundle', () => {
              M.setChannel(p, l, false);
              App.commit();
            })}</div>
            <p class="note">Add member picks the next free matching ports. Unbundle keeps the first cable and removes the others.</p>`;
        }
        html += '</div>';
      }

      const speeds = l.members.map((m) => [portSpeed(m.a), portSpeed(m.b)]).flat().filter(Boolean);
      if (new Set(speeds).size > 1 && !l.ec) html += '<p class="note">These ports run at different top speeds. The link negotiates down to the slower one.</p>';
      return html;
    }

    // ---------- Nothing selected ----------

    function overview() {
      const p = App.project;
      const count = (kind) => p.devices.filter((d) => M.kindOf(d) === kind).length;
      return `<div class="head"><div><h2>${esc(p.name)}</h2><p>Select a device or cable to configure it.</p></div></div>
        <dl class="fact">
          <dt>Routers</dt><dd>${count('router')}</dd>
          <dt>Switches</dt><dd>${count('l2switch') + count('l3switch')}</dd>
          <dt>End devices</dt><dd>${count('host')}</dd>
          <dt>Cables</dt><dd>${p.links.length}</dd>
          <dt>VLANs</dt><dd>${p.vlans.length}</dd>
        </dl>
        <div class="sect"><div class="sect-head"><h3>How it fits together</h3></div>
        <p class="note">Drag devices in from the left. Pick the Ethernet tool, press on a device and drag to another to cable them; PatchLab picks free ports and a link type. Click a cable to choose its source and destination interfaces, VLANs, trunking and EtherChannel. The Configs tab writes the CLI, and Verify checks that traffic really gets through.</p></div>`;
    }

    function inspectView() {
      const s = App.sel;
      if (s && s.type === 'device') {
        const d = M.dev(App.project, s.id);
        if (d) return deviceView(d);
      }
      if (s && s.type === 'link') {
        const l = App.project.links.find((x) => x.id === s.id);
        if (l) return linkView(l);
      }
      return overview();
    }

    // ---------- Lab view ----------

    function labView() {
      const p = App.project;
      const s = p.settings;
      const rows = p.vlans.map((v, i) => `<tr>
        <td style="width:62px">${v.id === 1 ? '<span class="row-name">1</span>' : input(v.id, (val) => {
          const n = +val;
          if (n >= 2 && n <= 4094 && !p.vlans.some((x) => x.id === n)) {
            p.links.forEach((l) => {
              if (l.vlan === v.id) l.vlan = n;
              if (l.nativeVlan === v.id) l.nativeVlan = n;
            });
            v.id = n;
            p.vlans.sort((x, y) => x.id - y.id);
          } else App.toast('VLAN IDs must be unique and between 2 and 4094.');
        }, { type: 'number', label: 'VLAN ID' })}</td>
        <td>${input(v.name, (val) => { v.name = val.trim().replace(/\s+/g, '_'); }, { label: 'VLAN name' })}</td>
        <td>${input(v.subnet ? `${v.subnet}/${N.maskToLen(v.mask)}` : '', (val) => {
          const m = /^(.+)\/(\d+)$/.exec(val.trim());
          const mask = m ? N.normalizeMask(m[2]) : '255.255.255.0';
          const ip = m ? m[1] : val.trim();
          if (!val.trim()) { v.subnet = ''; v.mask = ''; return; }
          if (N.ip2n(ip) === null || !mask) return App.toast('Enter a subnet such as 10.10.10.0/24.');
          v.subnet = N.network(ip, mask);
          v.mask = mask;
        }, { mono: true, ph: '10.10.10.0/24', label: 'VLAN subnet' })}</td>
        <td style="width:20px">${v.id === 1 ? '' : del(() => {
          p.links.forEach((l) => {
            if (l.vlan === v.id) l.vlan = 1;
            if (l.nativeVlan === v.id) l.nativeVlan = 1;
          });
          p.vlans.splice(i, 1);
          App.commit();
        }, 'Remove VLAN')}</td></tr>`).join('');
      const addVlan = () => {
        let id = 10;
        while (p.vlans.some((v) => v.id === id)) id += 10;
        p.vlans.push({ id, name: `VLAN${id}`, subnet: '', mask: '' });
        p.vlans.sort((x, y) => x.id - y.id);
        App.commit();
      };
      return `<div class="sect"><div class="sect-head"><h3>VLANs</h3><div class="btn-row">
          ${btn('Auto-address hosts', () => {
            const n = M.autoAddressHosts(p);
            App.toast(n ? `Addressed ${n} host${n > 1 ? 's' : ''} from their VLAN subnets.` : 'No unaddressed hosts in a VLAN with a subnet.');
            App.commit();
          })}${btn('Add VLAN', addVlan)}</div></div>
          <table><thead><tr><th>ID</th><th>Name</th><th>Subnet</th><th></th></tr></thead><tbody>${rows}</tbody></table>
          <p class="note">Subnets are optional. They let PatchLab fill in gateways and host addresses.</p></div>
        <div class="sect"><div class="sect-head"><h3>Base settings for every device</h3></div>
          <div class="grid">
            ${field('Enable secret', input(s.enableSecret, (v) => { s.enableSecret = v; }, { label: 'Enable secret' }))}
            ${field('Console password', input(s.consolePassword, (v) => { s.consolePassword = v; }, { label: 'Console password' }))}
            ${field('VTY password', input(s.vtyPassword, (v) => { s.vtyPassword = v; }, { label: 'VTY password' }))}
            ${field('Domain name', input(s.domainName, (v) => { s.domainName = v.trim(); }, { ph: 'lab.local', label: 'Domain name' }))}
          </div>
          ${field('Login banner', input(s.banner, (v) => { s.banner = v; }, { label: 'Login banner' }))}
          <p class="note">These are lab defaults and appear as plain text in the configs. Change them on anything beyond a classroom.</p>
          ${check('Portfast and BPDU guard on host ports', s.portfastHosts, (v) => { s.portfastHosts = v; })}
          ${check('Disable DTP on trunks (switchport nonegotiate)', s.nonegotiate, (v) => { s.nonegotiate = v; })}
          ${check('Shut down unused switch ports', s.shutUnused, (v) => { s.shutUnused = v; })}
          ${check('Use SSH instead of Telnet (needs a domain name)', s.ssh, (v) => { s.ssh = v; })}
        </div>`;
    }

    // ---------- Config view ----------

    function highlight(text) {
      return text.split('\n').map((line) => {
        const e = esc(line);
        if (/^!!!/.test(line)) return `<span class="s">${e}</span>`;
        if (/^!\s/.test(line)) return `<span class="s">${e}</span>`;
        if (/^!/.test(line) || /^#/.test(line)) return `<span class="c">${e}</span>`;
        const m = /^(\s*)(no |ip address |switchport |interface |router |network |neighbor |encapsulation |channel-group |vlan )?(.*)$/.exec(e);
        if (/^interface |^router |^vlan |^line |^ip access-list |^ip dhcp pool /.test(line)) return `<span class="k">${e}</span>`;
        return m ? `${m[1]}${m[2] ? `<span class="v">${m[2]}</span>` : ''}${m[3]}` : e;
      }).join('\n');
    }

    function configView() {
      const p = App.project;
      if (!p.devices.length) return '<p class="note">Add a device and its configuration appears here.</p>';
      const opt = App.ui.cfg;
      let target = opt.device === 'all' ? null : M.dev(p, opt.device);
      if (opt.device !== 'all' && !target) {
        const sel = App.sel && App.sel.type === 'device' && M.dev(p, App.sel.id);
        target = sel || p.devices[0];
      }
      const gen = { ...opt, sim: App.sim };
      const text = target ? C.generate(p, target, gen) : C.generateAll(p, gen);
      const feature = C.FEATURES.find((f) => f.id === opt.feature);
      const name = `${target ? target.name : p.name.replace(/\s+/g, '-')}${feature ? `-${feature.id}` : ''}`;
      const features = select(opt.feature, [['all', 'Full configuration'], ...C.FEATURES.map((f) => [f.id, f.label])], (v) => { opt.feature = v; App.ui.skipCommit = true; }, 'Feature');
      const chips = [...p.devices.map((d) => [d.id, d.name]), ['all', 'All devices']].map(([id, label]) => {
        const on = target ? target.id === id : id === 'all';
        return `<button type="button" class="pick ${on ? 'on' : ''}" data-a="${act(() => { App.ui.cfg.device = id; App.renderPanel(); })}">${esc(label)}</button>`;
      }).join('');
      return `<div class="chips">${chips}</div>
        <div class="grid">${field('Show', features)}</div>
        ${feature ? `<p class="note">Only the ${esc(feature.label)} lines, with each interface's name and description for context. Paste the full configuration to build a device from scratch.</p>` : ''}
        <div class="sect-head"><div class="checks">
          ${check('Explain each section', opt.notes, (v) => { opt.notes = v; App.ui.skipCommit = true; })}
          ${check('Paste-ready', opt.paste, (v) => { opt.paste = v; App.ui.skipCommit = true; })}</div>
          <div class="btn-row">${btn('Copy', () => App.copy(text))}${btn('Download', () => App.download(`${name}.txt`, text))}</div></div>
        <pre class="cli" tabindex="0">${highlight(text)}</pre>`;
    }

    // ---------- Verify view ----------

    function hopList(r) {
      return `<ol class="hops">${r.hops.map((h) => `<li class="${h.fail ? 'fail' : ''}"><div><b>${esc(h.dev)}</b>
        <span class="sub">${[h.in && `in ${shortName(h.in)}`, h.out && `out ${shortName(h.out)}`, h.via.length && `via ${h.via.join(', ')}`].filter(Boolean).map(esc).join(' · ')}</span>
        ${h.route ? `<span class="sub">matched ${esc(h.route.net)}/${h.route.len} (${esc(h.route.proto)})</span>` : ''}
        ${h.nat ? `<span class="sub nat">${esc(h.nat)}</span>` : ''}
        ${h.fail ? `<span class="why">${esc(h.fail)}</span>` : ''}</div></li>`).join('')}</ol>`;
    }

    function runPing(from, to, svc) {
      const v6 = String(to).includes(':');
      const res = v6 ? V6.ping(App.sim, from, to) : S.ping(App.sim, from, to, svc);
      if (v6) svc = { proto: 'icmp', port: 0, v6: true };
      App.ui.pingResult = { res, to, svc, from };
      const legs = [res.fwd, res.back].filter(Boolean);
      const failLeg = legs.find((x) => !x.ok);
      const lastHop = failLeg && failLeg.hops[failLeg.hops.length - 1];
      App.trace = {
        ok: res.ok,
        links: [...new Set(legs.flatMap((x) => x.links))],
        devices: [...new Set(legs.flatMap((x) => x.hops.map((h) => h.devId)))],
        failDev: lastHop ? lastHop.devId : null,
        legs: legs.map((x) => ({ links: x.links, hops: x.hops, ok: x.ok })),
      };
      App.renderAll();
      App.canvas.animate(App.trace);
    }

    function pingSection() {
      const p = App.project;
      const pg = App.ui.ping;
      const v6list = V6.addrList(App.sim).filter((x) => !V6.isLinkLocal(V6.parse(x.addr)));
      const sources = p.devices.filter((d) => (App.sim.byDev[d.id] || []).some((i) => i.ip) || v6list.some((x) => x.dev === d));
      if (sources.length < 2) return '<div class="sect"><div class="sect-head"><h3>Test traffic</h3></div><p class="note">Address at least two devices to test traffic between them.</p></div>';
      if (!sources.some((d) => d.id === pg.from)) pg.from = sources[0].id;
      const destinations = [];
      sources.forEach((d) => App.sim.byDev[d.id].filter((i) => i.ip).forEach((i) => destinations.push([i.ip, M.isHost(d) ? `${d.name} ${i.ip}` : `${d.name} ${shortName(i.name)} ${i.ip}`])));
      App.sim.vips.filter((i) => i.hsrp).forEach((i) => destinations.push([i.ip, `HSRP virtual IP ${i.ip} (${i.dev.name} active)`]));
      v6list.forEach((x) => destinations.push([x.addr, `${x.dev.name}${M.isHost(x.dev) ? '' : ` ${shortName(x.ifName)}`} ${x.addr}`]));
      if (!destinations.some(([ip]) => ip === pg.to)) pg.to = (destinations.find(([ip]) => !App.sim.byDev[pg.from].some((i) => i.ip === ip)) || destinations[0])[0];
      const r = App.ui.pingResult;
      let result = '';
      if (r) {
        const svc = r.svc.v6 ? 'IPv6 ping' : r.svc.proto === 'icmp' ? 'Ping' : `${r.svc.proto.toUpperCase()} ${r.svc.port}`;
        result = `<div class="verdict ${r.res.ok ? 'ok' : 'no'}">${esc(svc)} to ${esc(r.to)}: ${r.res.ok ? 'reaches the destination and returns' : 'fails'}${r.res.ok ? '' : `<small>${esc(r.res.reason)}</small>`}</div>
          <div class="sect-head"><h3>Outbound</h3><div class="btn-row">${App.trace ? btn('Replay', () => App.canvas.animate(App.trace)) : ''}${btn('Clear path', () => { App.ui.pingResult = null; App.trace = null; App.canvas.animate(null); App.renderAll(); }, 'ghosted')}</div></div>${r.res.fwd ? hopList(r.res.fwd) : ''}
          ${r.res.back ? `<div class="sect-head"><h3>Return</h3></div>${hopList(r.res.back)}` : ''}`;
      }
      return `<div class="sect"><div class="sect-head"><h3>Test traffic</h3></div>
        <div class="grid">
          ${field('From', select(pg.from, sources.map((d) => [d.id, d.name]), (v) => { pg.from = v; App.ui.skipCommit = true; }, 'Source device'))}
          ${field('To', select(pg.to, destinations, (v) => { pg.to = v; App.ui.skipCommit = true; }, 'Destination'))}
        </div>
        <div class="grid">
          ${field('Traffic', select(pg.proto, [['icmp', 'Ping (ICMP)'], ['tcp', 'TCP'], ['udp', 'UDP']], (v) => { pg.proto = v; App.ui.skipCommit = true; }, 'Traffic type'))}
          ${pg.proto === 'icmp' ? '' : field('Port', select(pg.port, ACL_PORTS.map(([n, t]) => [n, `${n} ${t}`]), (v) => { pg.port = +v; App.ui.skipCommit = true; }, 'Destination port'))}
          <div class="f"><span>&nbsp;</span>${btn('Run test', () => runPing(pg.from, pg.to, { proto: pg.proto, port: pg.port }), 'primary')}</div>
        </div>${result}</div>`;
    }

    function matrixSection() {
      const m = S.matrix(App.sim);
      if (m.hosts.length < 2) return '';
      const short = (d) => esc(d.name);
      const rows = m.hosts.map((h, i) => `<tr><th scope="row">${short(h)}</th>${m.rows[i].map((c, j) => {
        if (!c) return '<td><span class="cell self"></span></td>';
        const dest = S.hostAddr(App.sim, m.hosts[j]);
        const title = c.ok ? `${h.name} reaches ${m.hosts[j].name}` : c.reason;
        const go = act(() => {
          if (!dest) return App.toast(c.reason);
          App.ui.ping = { ...App.ui.ping, from: h.id, to: dest, proto: 'icmp' };
          runPing(h.id, dest, { proto: 'icmp', port: 0 });
        });
        return `<td><button type="button" class="cell ${c.ok ? 'ok' : 'no'}" title="${esc(title)}" aria-label="${esc(title)}" data-a="${go}">${c.ok ? '✓' : '✕'}</button></td>`;
      }).join('')}</tr>`).join('');
      const head = m.hosts.map((h) => `<th scope="col">${short(h)}</th>`).join('');
      const pairs = m.rows.flat().filter(Boolean);
      const okCount = pairs.filter((c) => c.ok).length;
      return `<div class="sect"><div class="sect-head"><h3>End-to-end ping matrix</h3><span class="chip ${okCount === pairs.length ? 'good' : 'warn'}">${okCount} of ${pairs.length} pairs</span></div>
        <div class="matrix-wrap"><table class="matrix"><thead><tr><th></th>${head}</tr></thead><tbody>${rows}</tbody></table></div>
        <p class="note">Rows ping columns. Select a cell to see its path.</p></div>`;
    }

    function issueSection() {
      const list = App.issues;
      const n = (s) => list.filter((i) => i.sev === s).length;
      const items = list.map((i) => `<button type="button" class="issue ${i.sev}" data-a="${act(() => {
        if (i.linkId) App.select('link', i.linkId);
        else if (i.devId) App.select('device', i.devId);
        App.tab = 'inspect';
        App.renderAll();
      })}"><i></i><span><b>${esc(i.msg)}</b>${i.fix ? `<small>${esc(i.fix)}</small>` : ''}</span></button>`).join('');
      const tally = `<div class="tally">${n('error') ? `<span class="chip bad">${n('error')} blocking</span>` : '<span class="chip good">Nothing blocking</span>'}${n('warn') ? `<span class="chip warn">${n('warn')} to review</span>` : ''}${n('info') ? `<span class="chip">${n('info')} notes</span>` : ''}</div>`;
      return `<div class="sect"><div class="sect-head"><h3>Configuration checks</h3>${tally}</div>${items}</div>`;
    }

    function verifyView() {
      return `${issueSection()}${matrixSection()}${pingSection()}<p class="note">These results come from PatchLab's model of the configuration, so they predict behaviour rather than run IOS. Confirm on real gear with ping, show ip route and show interfaces trunk.</p>`;
    }

    // ---------- Tools view ----------

    function subnetTool() {
      const t = App.ui.tools;
      const quiet = (fn) => (v) => { fn(v); App.ui.skipCommit = true; };
      const r = PL.subnet.calc(t.ip, t.mask);
      const facts = r.error ? `<p class="note">${esc(r.error)}</p>` : `<dl class="fact">
        <dt>Network</dt><dd>${esc(r.network)}/${r.len}</dd><dt>Mask</dt><dd>${esc(r.mask)}</dd><dt>Wildcard</dt><dd>${esc(r.wildcard)}</dd>
        <dt>Usable range</dt><dd>${esc(r.first)} to ${esc(r.last)}</dd>${r.broadcast ? `<dt>Broadcast</dt><dd>${esc(r.broadcast)}</dd>` : ''}
        <dt>Usable hosts</dt><dd>${r.hosts.toLocaleString()}</dd><dt>Class</dt><dd>${esc(r.cls)}${r.private ? ', private (RFC 1918)' : ''}</dd></dl>
        ${r.isNetwork ? '<p class="note">That is the network address itself, so no host can use it.</p>' : r.isBroadcast ? '<p class="note">That is the broadcast address, so no host can use it.</p>' : ''}`;
      const plan = PL.subnet.vlsm(t.base.split('/')[0], t.base.split('/')[1] || '', t.rows);
      const rows = t.rows.map((x, i) => `<tr><td>${input(x.name, quiet((v) => { x.name = v.trim().replace(/\s+/g, '_'); }), { label: 'Segment name', ph: 'Name' })}</td>
        <td style="width:80px">${input(x.hosts, quiet((v) => { x.hosts = +v || 0; }), { type: 'number', label: 'Hosts needed' })}</td>
        <td style="width:20px">${del(() => { t.rows.splice(i, 1); App.renderPanel(); })}</td></tr>`).join('');
      const out = plan.rows && plan.rows.length ? `<table class="nbrs"><thead><tr><th>Segment</th><th>Network</th><th>Usable range</th><th>Broadcast</th></tr></thead><tbody>${plan.rows.map((x) => `<tr>
          <td>${esc(x.name)}<div class="sub">${x.hosts} needed, ${x.usable} usable</div></td><td class="mono">${esc(x.net)}/${x.len}</td><td class="mono">${esc(x.first)}<br>${esc(x.last)}</td><td class="mono">${esc(x.broadcast)}</td></tr>`).join('')}</tbody></table>
        ${plan.error ? '' : `<p class="note">${plan.used} of ${plan.total} addresses allocated${plan.next ? `; the next free block starts at ${esc(plan.next)}` : ''}.</p>`}` : '';
      const apply = () => {
        const p = App.project;
        let added = 0;
        plan.rows.forEach((x) => {
          let v = p.vlans.find((y) => y.name.toLowerCase() === x.name.toLowerCase());
          if (!v) {
            let id = 10;
            while (p.vlans.some((y) => y.id === id)) id += 10;
            v = { id, name: x.name, subnet: '', mask: '' };
            p.vlans.push(v);
            added++;
          }
          v.subnet = x.net;
          v.mask = x.mask;
        });
        p.vlans.sort((a, b) => a.id - b.id);
        App.toast(`Set ${plan.rows.length} VLAN subnet${plan.rows.length > 1 ? 's' : ''}${added ? `, adding ${added} VLAN${added > 1 ? 's' : ''}` : ''}. See the Lab tab.`);
        App.commit();
      };
      const fromVlans = () => {
        t.rows = App.project.vlans.filter((v) => v.id !== 1).map((v) => ({ name: v.name, hosts: v.subnet ? 2 ** (32 - N.maskToLen(v.mask)) - 2 : 20 }));
        App.renderPanel();
      };
      return `<div class="tool-cols"><div class="sect"><div class="sect-head"><h3>Subnet calculator</h3></div>
          <div class="grid">${field('Address', input(t.ip, quiet((v) => { const m = /^(.+)\/(\d+)$/.exec(v.trim()); t.ip = m ? m[1] : v.trim(); if (m) t.mask = `/${m[2]}`; }), { mono: true, ph: '192.168.10.77/26', label: 'Address' }))}
          ${field('Mask or prefix', input(t.mask, quiet((v) => { t.mask = v.trim(); }), { mono: true, ph: '/26', label: 'Mask' }))}</div>${facts}</div>
        <div class="sect"><div class="sect-head"><h3>VLSM planner</h3><div class="btn-row">${btn('From VLANs', fromVlans)}${btn('Add segment', () => { t.rows.push({ name: `NET${t.rows.length + 1}`, hosts: 10 }); App.renderPanel(); })}</div></div>
          ${field('Address block', input(t.base, quiet((v) => { t.base = v.trim(); }), { mono: true, ph: '192.168.1.0/24', label: 'Address block' }))}
          ${rows ? `<table><thead><tr><th>Segment</th><th>Hosts</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : ''}
          <p class="note">The largest segment is placed first, each on the next boundary its size allows. Point-to-point links need 2 hosts, which gives a /30.</p>
          ${plan.error ? `<div class="verdict no">Does not fit<small>${esc(plan.error)}</small></div>` : ''}${out}
          ${plan.rows && plan.rows.length && !plan.error ? `<div class="btn-row">${btn('Apply to VLANs', apply, 'primary')}</div><p class="note">Segments are matched to VLANs by name; new names become new VLANs.</p>` : ''}</div></div>`;
    }

    function subnet6Tool() {
      const t = App.ui.tools.v6;
      const quiet = (fn) => (v) => { fn(v); App.ui.skipCommit = true; };
      const c = PL.subnet.calc6(t.prefix);
      const facts = c.error ? `<p class="note">${esc(c.error)}</p>` : `<dl class="fact">
        <dt>Prefix</dt><dd>${esc(c.network)}/${c.len}</dd><dt>Written out</dt><dd class="mono">${esc(c.networkLong)}</dd>
        <dt>Last address</dt><dd>${esc(c.last)}</dd><dt>Addresses</dt><dd>${esc(c.addresses)}</dd>
        ${c.sixtyFours ? `<dt>/64 subnets</dt><dd>${esc(c.sixtyFours)}</dd>` : ''}<dt>Type</dt><dd>${esc(c.type)}</dd></dl>
        ${c.isNetwork ? '' : `<p class="note">${esc(c.addr)} is a host address inside this prefix.</p>`}
        ${c.nibble ? '' : '<p class="note">This prefix length is not a multiple of 4, so the boundary falls inside a hex digit. Work that digit out in binary.</p>'}`;
      const sp = c.error ? null : PL.subnet.split6(`${c.network}/${c.len}`, t.newLen, t.from, 8);
      const step = (delta) => () => {
        const next = BigInt(sp.from) + BigInt(delta);
        t.from = (next < 0n ? 0n : next).toString();
        App.renderPanel();
      };
      const lens = [48, 52, 56, 60, 64, 112, 126, 127, 128].filter((n) => !c.error && n > c.len);
      const splitHtml = !sp ? '' : sp.error ? `<p class="note">${esc(sp.error)}</p>` : `
        <p class="note">${esc(sp.block)} holds ${esc(sp.totalText)} subnets of /${t.newLen}, using ${sp.bits} subnet bit${sp.bits === 1 ? '' : 's'}.
          ${sp.nibble ? 'The subnet ID is the hex digits that change between rows.' : 'The subnet bits do not fill whole hex digits, so the changing digit steps by more than 1.'}</p>
        <table class="nbrs"><thead><tr><th>#</th><th>Subnet and last address</th></tr></thead><tbody>${sp.rows.map((r) => `<tr>
          <td class="mono">${esc(r.index)}</td><td class="mono">${esc(r.net)}/${r.len}<div class="sub wrap">to ${esc(r.last)}</div></td></tr>`).join('')}</tbody></table>
        <div class="btn-row">${btn('Previous', step(-8))}${btn('Next', step(8))}${btn('Last', () => { t.from = (BigInt(sp.total) - 8n < 0n ? 0n : BigInt(sp.total) - 8n).toString(); App.renderPanel(); })}</div>`;
      return `<div class="tool-cols"><div class="sect"><div class="sect-head"><h3>IPv6 prefix calculator</h3></div>
          ${field('Prefix or address', input(t.prefix, quiet((v) => { t.prefix = v.trim(); t.from = '0'; }), { mono: true, ph: '2001:db8:acad::/48', label: 'IPv6 prefix' }))}${facts}</div>
        ${c.error ? '' : `<div class="sect"><div class="sect-head"><h3>Split into subnets</h3></div>
          <div class="grid">${field('New prefix length', select(t.newLen, (lens.includes(+t.newLen) ? lens : [...lens, +t.newLen].filter((n) => n > c.len && n <= 128).sort((a, b) => a - b)).map((n) => [n, `/${n}${n === 64 ? ' (LAN)' : n === 127 ? ' (point-to-point)' : ''}`]), quiet((v) => { t.newLen = +v; t.from = '0'; }), 'New prefix length'))}
          ${field('Jump to subnet #', input(t.from, quiet((v) => { t.from = /^\d+$/.test(v.trim()) ? v.trim() : '0'; }), { mono: true, label: 'Subnet number' }))}</div>
          ${splitHtml}
          <p class="note">LANs use /64 so SLAAC works. Sites usually get a /48 (65,536 LANs) or a /56 (256 LANs). Links between routers often use /64 or /127.</p></div>`}</div>`;
    }

    function guideTool() {
      const p = App.project;
      if (!p.devices.length) return '<p class="note">Add devices and the build order appears here.</p>';
      const g = PL.guide.guide(p, App.sim);
      const pick = App.ui.tools.guideDev;
      const shown = g.filter((x) => !pick || x.device.id === pick);
      const chips = [['', 'All devices'], ...g.map((x) => [x.device.id, x.device.name])].map(([id, label]) => `<button type="button" class="pick ${(pick || '') === id ? 'on' : ''}" data-a="${act(() => { App.ui.tools.guideDev = id; App.renderPanel(); })}">${esc(label)}</button>`).join('');
      const text = PL.guide.guideText(p, App.sim);
      return `<div class="sect-head"><h3>Build guide</h3><div class="btn-row">${btn('Copy', () => App.copy(text))}${btn('Download', () => App.download(`${p.name.replace(/\s+/g, '-')}-build-guide.md`, text, 'text/markdown'))}</div></div>
        <p class="note">Each device's configuration in the order you would type it, switches first, with a check after every step. Run checks from privileged EXEC, or put "do" in front inside configuration mode.</p>
        <div class="chips">${chips}</div>
        ${shown.map(({ device: d, steps }) => `<div class="sect"><div class="sect-head"><h3>${esc(d.name)}</h3><span class="sub">${esc(MODELS[d.model].label)}</span></div>
          <div class="guide-steps">${steps.map((st, i) => `<div class="step"><div class="step-head"><span class="step-n">${i + 1}</span><b>${esc(st.title)}</b></div>
            <pre class="cli scroll">${esc(st.commands.join('\n'))}</pre>
            ${st.check.cmd || st.check.expect.length ? `<div class="step-check">${st.check.cmd ? `Check <code>${esc(st.check.cmd)}</code>` : 'Check'}${st.check.expect.length ? `<ul>${st.check.expect.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}</div>` : ''}</div>`).join('')}</div></div>`).join('')}`;
    }

    function exportTool() {
      const p = App.project;
      const table = PL.exporter.cmlPortTable(p).filter((x) => x.map.length);
      return `<div class="tool-cols"><div class="sect"><div class="sect-head"><h3>Topology drawing</h3></div>
          <div class="btn-row">${btn('Download SVG', () => App.exportSvg())}${btn('Download PNG', () => App.exportPng())}</div>
          <p class="note">The canvas as it stands, cropped to the devices, in light colours for printing or slides.</p></div>
        <div class="sect"><div class="sect-head"><h3>Answer sheet</h3></div>
          <div class="btn-row">${btn('Open printable sheet', () => App.answerSheet('print'), 'primary')}${btn('Download HTML', () => App.answerSheet('download'))}</div>
          <p class="note">One page with the topology, VLAN and addressing tables, and every device's full configuration.</p></div>
        <div class="sect"><div class="sect-head"><h3>Cisco Modeling Labs</h3></div>
          <div class="btn-row">${btn('Download CML lab (.yaml)', () => App.download(`${p.name.replace(/\s+/g, '-')}.cml.yaml`, PL.exporter.cmlYaml(p, App.sim), 'application/yaml'))}</div>
          <p class="note">Import it in CML 2 with Import lab. Routers become IOSv, switches IOSvL2 and end devices Alpine desktops, each with its configuration. Ports are renumbered in order:</p>
          ${table.length ? `<table class="nbrs"><thead><tr><th>Device</th><th>Node</th><th>Ports</th></tr></thead><tbody>${table.map((x) => `<tr><td>${esc(x.name)}</td><td class="mono">${esc(x.def)}</td>
            <td class="mono">${esc(x.map.map(([a, b]) => `${shortName(a)}→${shortName(b)}`).join(', '))}</td></tr>`).join('')}</tbody></table>` : ''}</div></div>`;
    }

    function toolsView() {
      const list = [['subnet', 'IPv4 subnets'], ['subnet6', 'IPv6 subnets'], ['guide', 'Build guide'], ['export', 'Export']];
      const cur = App.ui.toolTab;
      const body = cur === 'guide' ? guideTool() : cur === 'export' ? exportTool() : cur === 'subnet6' ? subnet6Tool() : subnetTool();
      return `<div class="tools-head"><h2>Tools</h2>${subtabs('toolTab', list, cur)}</div>${body}`;
    }

    // ---------- Frame ----------

    function renderTabs() {
      const e = App.issues.filter((i) => i.sev === 'error').length;
      const w = App.issues.filter((i) => i.sev === 'warn').length;
      const badge = e ? `<span class="count">${e}</span>` : w ? `<span class="count warn">${w}</span>` : '<span class="count good">OK</span>';
      const list = [['inspect', 'Inspect'], ['lab', 'Lab'], ['config', 'Configs'], ['verify', `Verify ${badge}`]];
      tabsEl.innerHTML = list.map(([k, t]) => `<button type="button" role="tab" aria-selected="${App.tab === k}" class="tab ${App.tab === k ? 'on' : ''}" data-tab="${k}">${t}</button>`).join('');
    }

    function render() {
      const active = document.activeElement;
      const target = App.view === 'tools' ? toolsBody : panelBody;
      const focusId = active && target.contains(active) ? active.id : null;
      const scroll = target.scrollTop;
      binds = [];
      acts = [];
      seq = 0;
      renderTabs();
      root = App.view === 'tools' ? toolsBody : panelBody;
      root.innerHTML = App.view === 'tools' ? toolsView() : App.tab === 'lab' ? labView() : App.tab === 'config' ? configView() : App.tab === 'verify' ? verifyView() : inspectView();
      root.scrollTop = target === root ? scroll : root.scrollTop;
      if (focusId) {
        const el = document.getElementById(focusId);
        if (el) el.focus();
      }
    }

    const onChange = (e) => {
      const i = e.target.getAttribute('data-b');
      if (i === null) return;
      const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
      binds[+i](value);
      if (App.ui.skipCommit) {
        App.ui.skipCommit = false;
        App.renderPanel();
      } else App.commit();
    };

    const onClick = (e) => {
      const el = e.target.closest('[data-a]');
      if (el) acts[+el.getAttribute('data-a')]();
    };
    [panelBody, toolsBody].forEach((el) => {
      el.addEventListener('change', onChange);
      el.addEventListener('click', onClick);
    });

    tabsEl.addEventListener('click', (e) => {
      const el = e.target.closest('[data-tab]');
      if (!el) return;
      App.tab = el.getAttribute('data-tab');
      App.renderPanel();
    });

    return { render };
  }

  PL.inspector = { create };
})(window.PL = window.PL || {});
