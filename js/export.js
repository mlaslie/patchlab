// Exports: the topology drawing as standalone SVG, and the lab as a Cisco Modeling Labs
// (CML 2.x) topology file. No DOM, so both can be tested in Node.
(function (PL) {
  'use strict';

  const { MODELS, naturalCompare, shortName } = PL.catalog;
  const M = PL.model;
  const C = PL.configgen;

  // Light colours, so a printed or pasted drawing reads the same whatever theme is on screen.
  const SVG_CSS = `
.body{fill:#e4eef0;stroke:#1f3f46;stroke-width:1.5}.top{fill:#f7fbfb;stroke:#1f3f46;stroke-width:1.5}
.side{fill:#c6d8db;stroke:#1f3f46;stroke-width:1.5}.screen{fill:#bfe0e6;stroke:#1f3f46;stroke-width:1.5}
.mark{fill:none;stroke:#1f3f46;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.led{fill:#1f3f46}
.glyph{font:600 15px "Barlow Condensed","Arial Narrow",Arial,sans-serif;fill:#1f3f46}
.hit,.halo,.lnk-hit,.handle,.badge{display:none}
.nname{font:600 15px "Barlow Condensed","Arial Narrow",Arial,sans-serif;fill:#15211f;text-anchor:middle;paint-order:stroke;stroke:#fff;stroke-width:3px}
.nsub{font:400 11px "IBM Plex Mono",Menlo,Consolas,monospace;fill:#5a6b67;text-anchor:middle;paint-order:stroke;stroke:#fff;stroke-width:3px}
.lnk{fill:none;stroke-linecap:round}.mode-access .lnk{stroke:#2467c9;stroke-width:2.2}.mode-trunk .lnk{stroke:#b97a00;stroke-width:3.6}
.mode-routed .lnk{stroke:#16835a;stroke-width:2.6}.bundled .lnk{stroke-width:2}.ec-ring{fill:none;stroke:#15211f;stroke-width:1.5}
.stp-block{fill:#bb2d24}.stp-block-x{stroke:#fff;stroke-width:1.6}
.plabel{font:500 11px "IBM Plex Mono",Menlo,Consolas,monospace;fill:#5a6b67;text-anchor:middle;paint-order:stroke;stroke:#fff;stroke-width:3.5px}
.pill rect{fill:#fbfcfb;stroke:#a9b6b2}.pill text{font:500 11px "IBM Plex Mono",Menlo,Consolas,monospace;fill:#15211f;text-anchor:middle}
.title{font:600 18px "Barlow Condensed","Arial Narrow",Arial,sans-serif;fill:#15211f}`;

  // Wraps canvas markup in a self-contained SVG cropped to the devices.
  function standaloneSvg(p, markup, symbols, title) {
    const ds = p.devices;
    const xs = ds.map((d) => d.x);
    const ys = ds.map((d) => d.y);
    const minX = (ds.length ? Math.min(...xs) : 0) - 110;
    const minY = (ds.length ? Math.min(...ys) : 0) - 80 - (title ? 30 : 0);
    const w = (ds.length ? Math.max(...xs) : 0) + 110 - minX;
    const h = (ds.length ? Math.max(...ys) : 0) + 90 - minY;
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="${minX} ${minY} ${w} ${h}" width="${Math.round(w)}" height="${Math.round(h)}">
<style>${SVG_CSS}</style><defs>${symbols}</defs>
<rect x="${minX}" y="${minY}" width="${w}" height="${h}" fill="#fff"/>
${title ? `<text class="title" x="${minX + 16}" y="${minY + 26}">${esc(title)}</text>` : ''}
${markup.replace(/<use href="([^"]+)"/g, '<use href="$1" xlink:href="$1"')}
</svg>`;
  }

  // ---------- CML ----------

  // CML reference platforms: IOSv routers, IOSvL2 switches (which also route), and Alpine
  // desktops for end devices. Their interface names differ from the lab hardware, so each
  // device's cabled and configured ports are renumbered in order onto the CML node.
  const CML = {
    router: { def: 'iosv', names: Array.from({ length: 16 }, (_, i) => `GigabitEthernet0/${i}`) },
    l2switch: { def: 'iosvl2', names: Array.from({ length: 16 }, (_, i) => `GigabitEthernet${Math.floor(i / 4)}/${i % 4}`) },
    l3switch: { def: 'iosvl2', names: Array.from({ length: 16 }, (_, i) => `GigabitEthernet${Math.floor(i / 4)}/${i % 4}`) },
    host: { def: 'desktop', names: ['eth0'] },
  };

  function portsUsed(p, d) {
    const set = new Set();
    M.linksOf(p, d.id).forEach((l) => l.members.forEach((m) => set.add(m[M.side(l, d.id)])));
    Object.entries(d.ports).forEach(([n, c]) => {
      if (!/^Port-channel/.test(n) && (c.ip || (c.subifs || []).length || set.has(n))) set.add(n);
    });
    return MODELS[d.model].ports.filter((n) => set.has(n));
  }

  function interfaceMap(p, d) {
    const kind = M.kindOf(d);
    const names = CML[kind].names;
    const map = {};
    portsUsed(p, d).forEach((n, i) => { if (names[i]) map[n] = names[i]; });
    return map;
  }

  // Renames interfaces everywhere they appear, long and short forms, without touching
  // Gi0/10 when renaming Gi0/1.
  function renameInConfig(text, map, peerMaps) {
    // Descriptions name the peer's port, so they are renamed with the peer's map.
    const lines = text.split('\n').map((line) => {
      const m = /^( description (?:Member of \S+ )?[Tt]o )(\S+) (\S+)$/.exec(line);
      if (!m || !peerMaps || !peerMaps[m[2]]) return line;
      return `${m[1]}${m[2]} ${renameInConfig(m[3], peerMaps[m[2]])}`;
    });
    text = lines.join('\n');
    const pairs = [];
    Object.entries(map).forEach(([from, to]) => {
      pairs.push([from, to]);
      if (shortName(from) !== from) pairs.push([shortName(from), shortName(to)]);
    });
    pairs.sort((a, b) => b[0].length - a[0].length);
    const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    if (!pairs.length) return text;
    const lookup = Object.fromEntries(pairs);
    const re = new RegExp(`(?<![\\w/])(${pairs.map(([f]) => reEsc(f)).join('|')})(?![\\d/])`, 'g');
    return text.split('\n').map((line) => (/^ description /.test(line) && peerMaps ? line : line.replace(re, (m) => lookup[m]))).join('\n');
  }

  // IOSvL2 needs the trunk encapsulation set before it accepts "switchport mode trunk",
  // and the shut-unused ranges name ports the CML node does not have.
  function adaptForCml(text, kind) {
    const out = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^interface range /.test(line)) {
        while (lines[i + 1] && lines[i + 1].startsWith(' ')) i++;
        continue;
      }
      if (kind !== 'router' && line === ' switchport mode trunk' && out[out.length - 1] !== ' switchport trunk encapsulation dot1q') {
        out.push(' switchport trunk encapsulation dot1q');
      }
      out.push(line);
    }
    return out.join('\n');
  }

  function hostScript(p, d, sim) {
    const c = d.ports.Ethernet0 || {};
    const lease = sim && sim.leases[d.id];
    const lines = [`# ${d.name}: Alpine desktop. Applied at boot by CML.`, `hostname ${d.name}`];
    if (d.ipMode === 'dhcp') lines.push('udhcpc -i eth0', `# PatchLab expects ${lease && lease.ok ? lease.ip : 'no lease'}`);
    else if (c.ip && c.mask) {
      lines.push(`ip address add ${c.ip}/${PL.net.maskToLen(c.mask)} dev eth0`, 'ip link set dev eth0 up');
      if (d.gateway) lines.push(`ip route add default via ${d.gateway}`);
    }
    if (d.dns) lines.push(`echo "nameserver ${d.dns}" > /etc/resolv.conf`);
    return lines.join('\n');
  }

  const yamlStr = (s) => JSON.stringify(String(s));
  const block = (text, indent) => text.split('\n').map((l) => (l ? indent + l : '')).join('\n');

  function cmlYaml(p, sim) {
    const nodes = [];
    const ifIds = {};
    const byName = Object.fromEntries(p.devices.map((d) => [d.name, interfaceMap(p, d)]));
    const out = ['lab:', `  title: ${yamlStr(p.name)}`, '  description: "Exported from PatchLab. Interfaces are renumbered onto CML reference platforms."', '  notes: ""', '  version: 0.2.2', 'nodes:'];
    p.devices.forEach((d, ni) => {
      const kind = M.kindOf(d);
      const map = interfaceMap(p, d);
      const id = `n${ni}`;
      nodes.push({ d, id, map });
      let cfg;
      if (kind === 'host') cfg = hostScript(p, d, sim);
      else cfg = adaptForCml(renameInConfig(C.generate(p, d, { paste: false, notes: false, sim }), map, byName), kind);
      out.push(`  - id: ${id}`, `    label: ${yamlStr(d.name)}`, `    node_definition: ${CML[kind].def}`, `    x: ${Math.round(d.x * 1.4)}`, `    y: ${Math.round(d.y * 1.4)}`,
        '    configuration: |-', block(cfg, '      '), '    tags: []', '    interfaces:');
      const names = Object.values(map);
      // CML numbers every slot up to the highest one used.
      const count = kind === 'host' ? 1 : Math.max(names.length ? CML[kind].names.indexOf(names[names.length - 1]) + 1 : 1, kind === 'router' ? 4 : 8);
      for (let s = 0; s < count; s++) {
        const name = CML[kind].names[s];
        const iid = `i${s}`;
        ifIds[`${d.id}|${name}`] = iid;
        out.push(`      - id: ${iid}`, `        label: ${name}`, `        slot: ${s}`, '        type: physical');
      }
    });
    out.push('links:');
    let li = 0;
    p.links.forEach((l) => l.members.forEach((m) => {
      const a = nodes.find((n) => n.d.id === l.a);
      const b = nodes.find((n) => n.d.id === l.b);
      const ia = ifIds[`${l.a}|${a.map[m.a]}`];
      const ib = ifIds[`${l.b}|${b.map[m.b]}`];
      if (!ia || !ib) return;
      out.push(`  - id: l${li++}`, `    n1: ${a.id}`, `    i1: ${ia}`, `    n2: ${b.id}`, `    i2: ${ib}`, `    label: ${yamlStr(`${a.d.name}-${a.map[m.a]}<->${b.d.name}-${b.map[m.b]}`)}`);
    }));
    return out.join('\n') + '\n';
  }

  // Which CML interface each lab port became, for the export notes.
  function cmlPortTable(p) {
    return p.devices.map((d) => ({ name: d.name, def: CML[M.kindOf(d)].def, map: Object.entries(interfaceMap(p, d)).sort((a, b) => naturalCompare(a[0], b[0])) }));
  }

  PL.exporter = { standaloneSvg, cmlYaml, cmlPortTable, renameInConfig, interfaceMap, SVG_CSS };
})(typeof window !== 'undefined' ? (window.PL = window.PL || {}) : (globalThis.PL = globalThis.PL || {}));
