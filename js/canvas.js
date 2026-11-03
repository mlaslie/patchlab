// The drawing surface: renders devices and cables, and handles drag, pan, zoom and cabling.
(function (PL) {
  'use strict';

  const { MODELS, shortName } = PL.catalog;
  const M = PL.model;
  const N = PL.net;
  const SNAP = 20;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const icon = (d) => {
    const kind = MODELS[d.model].kind;
    return kind === 'host' ? `ic-${d.model}` : `ic-${kind}`;
  };

  function create(App) {
    const svg = document.getElementById('canvas');
    const world = document.getElementById('world');
    const grid = document.getElementById('grid');
    const linksEl = document.getElementById('layer-links');
    const nodesEl = document.getElementById('layer-nodes');
    const rubber = document.getElementById('rubber');
    const view = { x: 0, y: 0, k: 1 };
    let op = null;
    let pendingFrom = null;
    let hoverTarget = null;
    let exporting = false;
    let anim = null;
    const isSel = (type, id) => !exporting && App.isSel(type, id);

    function applyView() {
      const t = `translate(${view.x} ${view.y}) scale(${view.k})`;
      world.setAttribute('transform', t);
      grid.setAttribute('transform', t);
    }

    const toWorld = (cx, cy) => {
      const r = svg.getBoundingClientRect();
      return { x: (cx - r.left - view.x) / view.k, y: (cy - r.top - view.y) / view.k };
    };

    function zoomAt(cx, cy, factor) {
      const r = svg.getBoundingClientRect();
      const k = Math.min(2.5, Math.max(0.25, view.k * factor));
      const px = cx - r.left;
      const py = cy - r.top;
      view.x = px - ((px - view.x) / view.k) * k;
      view.y = py - ((py - view.y) / view.k) * k;
      view.k = k;
      applyView();
    }

    function fit() {
      const r = svg.getBoundingClientRect();
      const ds = App.project.devices;
      if (!ds.length || !r.width) {
        Object.assign(view, { x: 0, y: 0, k: 1 });
        return applyView();
      }
      const xs = ds.map((d) => d.x);
      const ys = ds.map((d) => d.y);
      const minX = Math.min(...xs) - 80;
      const maxX = Math.max(...xs) + 80;
      const minY = Math.min(...ys) - 70;
      const maxY = Math.max(...ys) + 90;
      const pad = 44;
      const k = Math.min(1.25, Math.max(0.25, Math.min((r.width - pad) / (maxX - minX), (r.height - pad * 2) / (maxY - minY))));
      view.k = k;
      view.x = (r.width - (maxX - minX) * k) / 2 - minX * k;
      view.y = (r.height - (maxY - minY) * k) / 2 - minY * k;
      applyView();
    }

    function centre() {
      const r = svg.getBoundingClientRect();
      return toWorld(r.left + r.width / 2, r.top + r.height / 2);
    }

    function linkPill(l) {
      const po = l.ec ? `Po${l.ec.groupA} ` : '';
      if (l.mode === 'access') return `${po}VLAN ${l.vlan}`;
      if (l.mode === 'trunk') {
        const list = l.allowed === 'all' || !l.allowed ? 'all' : N.compressList(N.expandList(l.allowed));
        return `${po}Trunk ${list}${l.nativeVlan !== 1 ? ` n${l.nativeVlan}` : ''}`;
      }
      const c = (M.dev(App.project, l.a).ports || {})[M.endIf(l, l.a)];
      if (c && c.ip && N.ip2n(c.ip) !== null && N.maskToLen(c.mask) !== null) return `${po}${N.network(c.ip, c.mask)}/${N.maskToLen(c.mask)}`;
      return `${po}Routed`;
    }

    // Spreads parallel cables between the same two devices so each stays clickable.
    function offsets() {
      const groups = {};
      App.project.links.forEach((l) => {
        const key = [l.a, l.b].sort().join('|');
        (groups[key] = groups[key] || []).push(l);
      });
      const out = {};
      Object.values(groups).forEach((list) => list.forEach((l, i) => {
        const sign = l.a < l.b ? 1 : -1;
        out[l.id] = ((i - (list.length - 1) / 2) * 26) * sign;
      }));
      return out;
    }

    function linkPath(a, b, off) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const nx = -uy;
      const ny = ux;
      const p = { x: a.x + nx * off, y: a.y + ny * off };
      const q = { x: b.x + nx * off, y: b.y + ny * off };
      const d = `M${p.x} ${p.y}L${q.x} ${q.y}`;
      return { d, p, q, ux, uy, nx, ny, len };
    }

    function renderLink(l, off, errored) {
      const a = M.dev(App.project, l.a);
      const b = M.dev(App.project, l.b);
      const g = linkPath(a, b, off);
      const members = l.ec ? l.members.length : 1;
      let lines = '';
      for (let i = 0; i < members; i++) {
        const o = off + (i - (members - 1) / 2) * 5;
        lines += `<path class="lnk" d="${linkPath(a, b, o).d}"/>`;
      }
      let rings = '';
      if (l.ec) {
        const r = 6 + members * 2.5;
        const angle = (Math.atan2(g.uy, g.ux) * 180) / Math.PI;
        [46, g.len - 46].forEach((t) => {
          const cx = g.p.x + g.ux * t;
          const cy = g.p.y + g.uy * t;
          rings += `<ellipse class="ec-ring" cx="${cx}" cy="${cy}" rx="5" ry="${r}" transform="rotate(${angle} ${cx} ${cy})"/>`;
        });
      }
      // Labels below a device must clear its name and model text; labels above have less to clear.
      const clear = (uy) => Math.min(uy > 0.5 ? 84 : 60, g.len * 0.34);
      const atA = clear(g.uy);
      const atB = clear(-g.uy);
      const lift = Math.abs(g.ux) > 0.5 ? -11 : 0;
      const shift = Math.abs(g.ux) > 0.5 ? 0 : 26;
      const pa = l.ec ? `Po${l.ec.groupA}` : shortName(l.members[0].a);
      const pb = l.ec ? `Po${l.ec.groupB}` : shortName(l.members[0].b);
      const label = linkPill(l);
      const mx = (g.p.x + g.q.x) / 2;
      const my = (g.p.y + g.q.y) / 2;
      const w = label.length * 6.8 + 12;
      const cls = `link mode-${l.mode}${l.ec ? ' bundled' : ''}${isSel('link', l.id) ? ' sel' : ''}${errored ? ' err' : ''}`;
      // A red bar near the switch end that spanning tree blocks, listing the VLANs.
      const stp = App.sim && App.sim.stp;
      let block = '';
      if (stp) {
        const ends = {};
        Object.values(stp.byVlan).forEach((r) => r.blocked.filter((b) => b.linkId === l.id).forEach((b) => { (ends[b.devId] = ends[b.devId] || []).push(r.vlan); }));
        block = Object.entries(ends).map(([id, vlans]) => {
          const t = id === l.a ? Math.min(58, g.len * 0.3) : g.len - Math.min(58, g.len * 0.3);
          const cx = g.p.x + g.ux * t;
          const cy = g.p.y + g.uy * t;
          return `<g class="stp-block-g"><title>Spanning tree blocks this port for VLAN ${N.compressList(vlans)}</title><circle class="stp-block" cx="${cx}" cy="${cy}" r="7"/><path class="stp-block-x" d="M${cx - 3.5} ${cy}h7"/></g>`;
        }).join('');
      }
      return `<g class="${cls}" data-link="${l.id}">
        <path class="halo" d="${g.d}"/>${lines}${rings}
        <path class="lnk-hit" d="${g.d}"/>${block}
        <text class="plabel" x="${g.p.x + g.ux * atA + shift}" y="${g.p.y + g.uy * atA + lift}">${esc(pa)}</text>
        <text class="plabel" x="${g.q.x - g.ux * atB + shift}" y="${g.q.y - g.uy * atB + lift}">${esc(pb)}</text>
        <g class="pill"><rect x="${mx - w / 2}" y="${my - 9}" width="${w}" height="18" rx="3"/><text x="${mx}" y="${my + 4}">${esc(label)}</text></g>
      </g>`;
    }

    function subLabel(d) {
      const lease = App.sim && App.sim.leases[d.id];
      if (lease) return lease.ok ? `${lease.ip} (DHCP)` : 'DHCP, no lease';
      const first = Object.values(d.ports).find((c) => c.ip) || d.svis.find((s) => s.ip) || d.loopbacks.find((s) => s.ip);
      return M.isHost(d) && first ? first.ip : MODELS[d.model].label.replace('Catalyst ', '');
    }

    function renderNode(d, errs) {
      const tr = exporting ? null : App.trace;
      const onPath = tr && tr.devices.includes(d.id);
      const failedHere = tr && tr.failDev === d.id;
      const cls = `node${isSel('device', d.id) ? ' sel' : ''}${!exporting && pendingFrom === d.id ? ' pending' : ''}${!exporting && hoverTarget === d.id ? ' target' : ''}${failedHere ? ' tracefail' : onPath ? ' traced' : ''}`;
      const badge = errs && !exporting ? `<g class="badge" transform="translate(-36,-28)"><circle r="9"/><text y="4">${errs}</text></g>` : '';
      return `<g class="${cls}" data-node="${d.id}" transform="translate(${d.x},${d.y})">
        <rect class="hit" x="-46" y="-38" width="92" height="94" rx="6"/>
        <use href="#${icon(d)}" x="-32" y="-30" width="64" height="46"/>
        <text class="nname" y="33">${esc(d.name)}</text>
        <text class="nsub" y="48">${esc(subLabel(d))}</text>
        ${badge}
        ${exporting ? '' : `<g class="handle" data-handle="${d.id}" transform="translate(38,-26)"><circle r="9"/><path d="M-4 0h8M0 -4v8"/></g>`}
      </g>`;
    }

    function renderTrace() {
      const tr = App.trace;
      if (!tr) return '';
      const off = offsets();
      return tr.links.map((id) => {
        const l = App.project.links.find((x) => x.id === id);
        if (!l) return '';
        const g = linkPath(M.dev(App.project, l.a), M.dev(App.project, l.b), off[l.id] || 0);
        return `<path class="trace-flow${tr.ok ? '' : ' fail'}" d="${g.d}"/>`;
      }).join('');
    }

    function render() {
      const errDev = {};
      const errLink = {};
      App.issues.filter((i) => i.sev === 'error').forEach((i) => {
        if (i.devId) errDev[i.devId] = (errDev[i.devId] || 0) + 1;
        if (i.linkId) errLink[i.linkId] = true;
      });
      const off = offsets();
      linksEl.innerHTML = App.project.links.map((l) => renderLink(l, off[l.id] || 0, errLink[l.id])).join('') + renderTrace();
      nodesEl.innerHTML = App.project.devices.map((d) => renderNode(d, errDev[d.id])).join('');
      document.getElementById('empty').hidden = App.project.devices.length > 0;
      svg.setAttribute('class', `tool-${App.tool}`);
    }

    // Links and nodes without selection, trace or handles, for exporting the drawing.
    function exportMarkup() {
      exporting = true;
      try {
        const off = offsets();
        const links = App.project.links.map((l) => renderLink(l, off[l.id] || 0, false)).join('');
        const nodes = App.project.devices.map((d) => renderNode(d, 0)).join('');
        return `<g>${links}</g><g>${nodes}</g>`;
      } finally {
        exporting = false;
      }
    }

    // ---------- Packet animation ----------

    // Turns each leg of a trace into a list of devices visited in order: the cables in a leg
    // are contiguous, so each one leads from the current device to its peer.
    function legPath(leg) {
      const p = App.project;
      const first = leg.hops[0];
      if (!first) return [];
      const off = offsets();
      let cur = first.devId;
      const segs = [];
      leg.links.forEach((id) => {
        const l = p.links.find((x) => x.id === id);
        if (!l || (l.a !== cur && l.b !== cur)) return;
        const next = M.peerOf(l, cur);
        const g = linkPath(M.dev(p, l.a), M.dev(p, l.b), off[l.id] || 0);
        const from = l.a === cur ? g.p : g.q;
        const to = l.a === cur ? g.q : g.p;
        segs.push({ from, to, devId: next });
        cur = next;
      });
      return segs;
    }

    function animate(trace) {
      const layer = document.getElementById('layer-anim');
      if (anim) {
        cancelAnimationFrame(anim.raf);
        clearTimeout(anim.timer);
      }
      anim = null;
      layer.innerHTML = '';
      if (!trace || !trace.legs || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const steps = [];
      trace.legs.forEach((leg, li) => {
        const byDev = {};
        leg.hops.forEach((h) => { byDev[h.devId] = h; });
        const segs = legPath(leg);
        if (!segs.length && leg.hops[0]) {
          const d = M.dev(App.project, leg.hops[0].devId);
          steps.push({ from: d, to: d, hop: leg.hops[0], back: li > 0, fail: !leg.ok });
        }
        segs.forEach((sg, i) => {
          const hop = byDev[sg.devId];
          const last = i === segs.length - 1;
          steps.push({ ...sg, hop: hop && (M.canRoute(M.dev(App.project, sg.devId)) || last) ? hop : null, back: li > 0, fail: last && !leg.ok });
        });
      });
      if (!steps.length) return;
      layer.innerHTML = '<circle class="pkt" r="7"/><g class="pkt-tip" hidden><rect rx="4"/><text></text></g>';
      const dot = layer.querySelector('.pkt');
      const tip = layer.querySelector('.pkt-tip');
      const say = (text, x, y, bad) => {
        if (!text) return tip.setAttribute('hidden', '');
        tip.removeAttribute('hidden');
        const t = tip.querySelector('text');
        t.textContent = text.length > 96 ? `${text.slice(0, 94)}…` : text;
        let w = t.textContent.length * 6.6 + 14;
        try { w = t.getComputedTextLength() + 14; } catch (e) { /* not laid out yet */ }
        tip.querySelector('rect').setAttribute('width', w);
        tip.querySelector('rect').setAttribute('height', 22);
        tip.setAttribute('transform', `translate(${x - w / 2},${y - 74})`);
        tip.setAttribute('class', `pkt-tip${bad ? ' bad' : ''}`);
        t.setAttribute('x', 7);
        t.setAttribute('y', 15);
      };
      const caption = (h) => {
        if (!h) return '';
        if (h.fail) return `${h.dev}: ${h.fail}`;
        const parts = [];
        if (h.route) parts.push(`${h.route.net}/${h.route.len} (${h.route.proto})`);
        if (h.out) parts.push(`out ${shortName(h.out)}`);
        if (h.nat) parts.push(h.nat.replace(/^NAT: /, 'NAT '));
        return parts.length ? `${h.dev}: ${parts.join(', ')}` : `${h.dev}: delivered`;
      };
      let i = 0;
      let t0 = null;
      let pause = 0;
      const speed = 0.42;
      const tick = (now) => {
        const st = steps[i];
        if (t0 === null) t0 = now;
        const len = Math.hypot(st.to.x - st.from.x, st.to.y - st.from.y);
        const dur = len / speed;
        const k = Math.min(1, (now - t0) / (dur || 1));
        dot.setAttribute('cx', st.from.x + (st.to.x - st.from.x) * k);
        dot.setAttribute('cy', st.from.y + (st.to.y - st.from.y) * k);
        dot.setAttribute('class', `pkt${st.back ? ' back' : ''}${st.fail && k >= 1 ? ' fail' : ''}`);
        if (k >= 1) {
          if (!pause) {
            pause = now;
            const d = M.dev(App.project, st.devId || (st.hop && st.hop.devId));
            if (st.hop && d) say(caption(st.hop), d.x, d.y, st.fail);
          }
          const hold = st.hop ? (st.fail ? 2600 : 900) : 0;
          if (now - pause >= hold) {
            pause = 0;
            t0 = null;
            i++;
            if (st.fail || i >= steps.length) {
              anim.timer = setTimeout(() => { layer.innerHTML = ''; }, st.fail ? 2500 : 1500);
              return;
            }
          }
        }
        anim.raf = requestAnimationFrame(tick);
      };
      anim = { raf: requestAnimationFrame(tick) };
    }

    function setHint(text) {
      const el = document.getElementById('hint');
      el.textContent = text || '';
      el.hidden = !text;
    }

    // Finds the device under the pointer by position rather than by hit-testing the DOM, so a
    // cable drop works however the page is embedded and even while nodes are being redrawn.
    function nodeAt(cx, cy) {
      const w = toWorld(cx, cy);
      let best = null;
      let bestDist = Infinity;
      App.project.devices.forEach((d) => {
        const dx = Math.abs(w.x - d.x);
        const dy = w.y - (d.y + 9);
        if (dx > 50 || dy < -50 || dy > 50) return;
        const dist = Math.hypot(dx, dy);
        if (dist < bestDist) {
          best = d.id;
          bestDist = dist;
        }
      });
      return best;
    }

    function finishCable(fromId, toId) {
      const res = M.addLink(App.project, fromId, toId);
      if (res.error) {
        render();
        return App.toast(res.error);
      }
      App.select('link', res.link.id);
      App.tab = 'inspect';
      App.commit();
      App.toast(`Connected ${M.dev(App.project, fromId).name} to ${M.dev(App.project, toId).name}. Set the interfaces in the panel.`);
    }

    // The rubber band is an SVG element, which has no .hidden property, so toggle the attribute.
    const showRubber = (on) => rubber.toggleAttribute('hidden', !on);

    function anchorRubber(id) {
      const d = M.dev(App.project, id);
      rubber.setAttribute('x1', d.x);
      rubber.setAttribute('y1', d.y - 7);
      rubber.setAttribute('x2', d.x);
      rubber.setAttribute('y2', d.y - 7);
      showRubber(true);
    }

    // Stretches the band to the pointer and highlights the device it would connect to.
    function trackRubber(e, fromId) {
      const w = toWorld(e.clientX, e.clientY);
      rubber.setAttribute('x2', w.x);
      rubber.setAttribute('y2', w.y);
      const over = nodeAt(e.clientX, e.clientY);
      const next = over && over !== fromId ? over : null;
      if (next !== hoverTarget) {
        hoverTarget = next;
        render();
      }
    }

    function startCable(id, e) {
      op = { type: 'cable', from: id, startX: e.clientX, startY: e.clientY, moved: false };
      anchorRubber(pendingFrom && pendingFrom !== id ? pendingFrom : id);
    }

    svg.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.button !== 1) return;
      try {
        svg.setPointerCapture(e.pointerId);
      } catch (err) {
        // Capture is a nicety; the gesture still works without it.
      }
      const handle = e.target.closest('[data-handle]');
      const nodeEl = e.target.closest('[data-node]');
      const linkEl = e.target.closest('[data-link]');
      if (handle) return startCable(handle.getAttribute('data-handle'), e);
      if (nodeEl && e.button === 0) {
        const id = nodeEl.getAttribute('data-node');
        if (App.tool !== 'select') return startCable(id, e);
        const d = M.dev(App.project, id);
        const w = toWorld(e.clientX, e.clientY);
        op = { type: 'move', id, dx: w.x - d.x, dy: w.y - d.y, moved: false };
        App.select('device', id);
        App.renderAll();
        return;
      }
      if (linkEl && e.button === 0) {
        App.select('link', linkEl.getAttribute('data-link'));
        App.tab = 'inspect';
        App.renderAll();
        return;
      }
      op = { type: 'pan', x: e.clientX - view.x, y: e.clientY - view.y, sx: e.clientX, sy: e.clientY, moved: false };
    });

    svg.addEventListener('pointermove', (e) => {
      if (!op) {
        // Between the two clicks of a click-click connection the band follows the pointer.
        if (pendingFrom) trackRubber(e, pendingFrom);
        return;
      }
      // A release outside the frame never reaches us; the next buttonless move finishes the gesture.
      if (e.pointerType === 'mouse' && e.buttons === 0) return endOp(e);
      if (op.type === 'pan') {
        view.x = e.clientX - op.x;
        view.y = e.clientY - op.y;
        if (Math.hypot(e.clientX - op.sx, e.clientY - op.sy) > 3) op.moved = true;
        applyView();
      } else if (op.type === 'move') {
        const w = toWorld(e.clientX, e.clientY);
        const d = M.dev(App.project, op.id);
        const x = Math.round((w.x - op.dx) / SNAP) * SNAP;
        const y = Math.round((w.y - op.dy) / SNAP) * SNAP;
        if (x !== d.x || y !== d.y) {
          d.x = x;
          d.y = y;
          op.moved = true;
          render();
        }
      } else if (op.type === 'cable') {
        if (Math.hypot(e.clientX - op.startX, e.clientY - op.startY) > 5) op.moved = true;
        trackRubber(e, op.from);
      }
    });

    function endOp(e) {
      if (!op) return;
      const cur = op;
      op = null;
      if (cur.type === 'move' && cur.moved) App.commit({ quiet: true });
      if (cur.type === 'pan' && !cur.moved) {
        pendingFrom = null;
        showRubber(false);
        setHint(toolHint());
        App.select(null);
        App.renderAll();
      }
      if (cur.type === 'cable') {
        showRubber(false);
        const target = hoverTarget;
        hoverTarget = null;
        if (cur.moved) {
          pendingFrom = null;
          setHint(toolHint());
          if (target) finishCable(cur.from, target);
          else {
            App.toast('Release the cable over the destination device to connect it.');
            render();
          }
        } else if (pendingFrom && pendingFrom !== cur.from) {
          const from = pendingFrom;
          pendingFrom = null;
          setHint(toolHint());
          finishCable(from, cur.from);
        } else {
          // A plain click starts a two-click connection.
          pendingFrom = cur.from;
          anchorRubber(cur.from);
          setHint(`Click the device to connect ${M.dev(App.project, cur.from).name} to. Esc cancels.`);
          render();
        }
      }
    }
    svg.addEventListener('pointerup', endOp);
    svg.addEventListener('pointercancel', endOp);

    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016)));
    }, { passive: false });

    const toolHint = () => (App.tool === 'ethernet'
      ? 'Drag from the source device to the destination. Esc to stop.'
      : '');

    function setTool(t) {
      App.tool = t;
      pendingFrom = null;
      setHint(toolHint());
      document.querySelectorAll('.tools .tool').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
      render();
    }

    function cancel() {
      pendingFrom = null;
      hoverTarget = null;
      op = null;
      showRubber(false);
      setHint(toolHint());
    }

    document.querySelectorAll('.tools .tool').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
    document.getElementById('zoom-in').addEventListener('click', () => {
      const r = svg.getBoundingClientRect();
      zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.2);
    });
    document.getElementById('zoom-out').addEventListener('click', () => {
      const r = svg.getBoundingClientRect();
      zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1 / 1.2);
    });
    document.getElementById('zoom-fit').addEventListener('click', fit);

    applyView();
    return { render, fit, toWorld, centre, setTool, cancel, svg, exportMarkup, animate };
  }

  PL.canvas = { create, icon };
})(window.PL = window.PL || {});
