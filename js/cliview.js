// The CLI lab page: a console per device, the lab brief, the score against the designed lab,
// and the assistant answering questions about the student's own configuration.
(function (PL) {
  'use strict';

  const { MODELS, shortName, naturalCompare } = PL.catalog;
  const M = PL.model;
  const P = PL.practice;
  const S = PL.simulate;
  const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function create(App) {
    const root = document.getElementById('cli-page');
    const ui = App.ui.cli;
    let built = false;
    let el = {};
    let student = null;
    let studentSim = null;
    let armed = '';

    const practice = () => {
      App.project.practice = App.project.practice || { devices: {}, hosts: {} };
      return App.project.practice;
    };
    const session = (id) => {
      ui.sessions[id] = ui.sessions[id] || { mode: 'user', cur: null };
      return ui.sessions[id];
    };
    const ctxFor = (id) => ({ target: App.project, practice: practice(), session: session(id) });
    const order = () => {
      const rank = { l2switch: 0, l3switch: 1, router: 2, host: 3 };
      return App.project.devices.slice().sort((a, b) => rank[M.kindOf(a)] - rank[M.kindOf(b)] || naturalCompare(a.name, b.name));
    };
    const current = () => M.dev(App.project, ui.dev) || order()[0];

    function build() {
      root.innerHTML = `<div class="cli-layout">
        <aside class="cli-left">
          <div class="cli-card"><div class="sect-head"><h3>Devices</h3><button type="button" class="btn small" data-c="topo">Topology</button></div><div id="cli-devs" class="cli-devs"></div></div>
          <div class="cli-card" id="cli-brief"></div>
        </aside>
        <section class="cli-term">
          <div class="cli-term-head"><div><b id="cli-title"></b><span class="sub" id="cli-sub"></span></div>
            <div class="btn-row"><button type="button" class="btn small" data-c="clear">Clear screen</button><button type="button" class="btn small" data-c="reset">Reset device</button><button type="button" class="btn small" data-c="solution">Show solution</button></div></div>
          <div class="term-box" id="cli-box"><pre id="cli-out" class="term" tabindex="-1"></pre>
          <form id="cli-form" class="term-in"><label for="cli-in" id="cli-prompt" class="prompt"></label><input id="cli-in" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Command"></form></div>
          <p class="note">Type IOS commands as on the real console. Abbreviations work (conf t, int g0/1, no shut, wr), Tab completes commands and interface names (int gig → GigabitEthernet0/), ? lists what can come next (sh ?, sw?), ↑/↓ recall history, Ctrl+Z ends configuration, Ctrl+A/E/W/U/K edit the line as on IOS. A second Tab lists what fits. PCs take ipconfig and ping.</p>
        </section>
        <aside class="cli-right"><div class="cli-card" id="cli-score"></div><div class="cli-card" id="cli-ask"></div></aside>
      </div>
      <dialog id="dlg-topo" class="dlg wide"><form method="dialog"><h2>Topology</h2><div id="dlg-topo-body"></div><div class="btn-row"><button class="btn small primary" value="ok">Close</button></div></form></dialog>`;
      el = {
        devs: root.querySelector('#cli-devs'), brief: root.querySelector('#cli-brief'), title: root.querySelector('#cli-title'), sub: root.querySelector('#cli-sub'),
        box: root.querySelector('#cli-box'), out: root.querySelector('#cli-out'), form: root.querySelector('#cli-form'), prompt: root.querySelector('#cli-prompt'), input: root.querySelector('#cli-in'),
        score: root.querySelector('#cli-score'), ask: root.querySelector('#cli-ask'),
      };
      el.form.addEventListener('submit', (e) => {
        e.preventDefault();
        submit(el.input.value);
      });
      el.input.addEventListener('keydown', onKey);
      el.box.addEventListener('click', () => { if (!getSelection().toString()) el.input.focus(); });
      root.addEventListener('click', onClick);
      root.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.matches('.ask input')) {
          e.preventDefault();
          ask(e.target.value);
        }
      });
      built = true;
    }

    function log(id) {
      ui.logs[id] = ui.logs[id] || [];
      return ui.logs[id];
    }

    function banner(d) {
      if (M.isHost(d)) return [`${d.name}: Command Prompt. Type help for the commands.`, ''];
      return [`${d.name} console (${MODELS[d.model].label}), factory defaults until you configure it.`, '', 'Press RETURN to get started.', ''];
    }

    function submit(line) {
      const d = current();
      const ctx = ctxFor(d.id);
      const lines = log(d.id);
      if (!lines.length) lines.push(...banner(d));
      const prompt = P.promptFor(ctx, d.id);
      lines.push(`${prompt}${line}`);
      const res = P.exec(ctx, d.id, line);
      // IOS puts the error caret under the bad word, which sits after the prompt.
      if (res.out) lines.push(...res.out.replace(/^( *)\^/, (m, sp) => `${' '.repeat(prompt.length + line.length - line.trimStart().length)}${sp}^`).split('\n'));
      if (lines.length > 1500) lines.splice(0, lines.length - 1500);
      if (line.trim()) {
        ui.hist[d.id] = [...(ui.hist[d.id] || []).filter((x) => x !== line), line].slice(-100);
      }
      ui.histAt = null;
      el.input.value = '';
      if (res.changed) App.commit();
      else render();
      el.input.focus();
    }

    function onKey(e) {
      const d = current();
      const hist = ui.hist[d.id] || [];
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        if (!hist.length) return;
        e.preventDefault();
        let i = ui.histAt === null ? hist.length : ui.histAt;
        i = Math.max(0, Math.min(hist.length, i + (e.key === 'ArrowUp' ? -1 : 1)));
        ui.histAt = i;
        el.input.value = hist[i] || '';
      } else if (e.key === 'Tab') {
        e.preventDefault();
        const mode = session(d.id).mode;
        const now = el.input.value;
        const next = P.complete(mode, now, d);
        // A Tab that cannot complete any further lists what would fit, as ? does.
        if (next === now) showOptions(d, P.options(mode, now, d));
        else el.input.value = next;
      } else if (e.ctrlKey && !e.metaKey && !e.altKey && EDIT[e.key.toLowerCase()]) {
        e.preventDefault();
        EDIT[e.key.toLowerCase()](d);
      } else if (e.altKey && !e.ctrlKey && (e.code === 'KeyB' || e.code === 'KeyF')) {
        e.preventDefault();
        moveWord(e.code === 'KeyB' ? -1 : 1);
      }
    }

    // IOS (Emacs-style) line editing keys.
    const caret = (i) => { const n = Math.max(0, Math.min(el.input.value.length, i)); el.input.setSelectionRange(n, n); };
    const at = () => el.input.selectionStart;
    const cut = (from, to) => {
      const v = el.input.value;
      el.input.value = v.slice(0, from) + v.slice(to);
      caret(from);
    };
    const wordStart = (i) => { const v = el.input.value; while (i > 0 && v[i - 1] === ' ') i--; while (i > 0 && v[i - 1] !== ' ') i--; return i; };
    const wordEnd = (i) => { const v = el.input.value; while (i < v.length && v[i] === ' ') i++; while (i < v.length && v[i] !== ' ') i++; return i; };
    const moveWord = (dir) => caret(dir < 0 ? wordStart(at()) : wordEnd(at()));
    const recall = (d, dir) => onKey({ key: dir < 0 ? 'ArrowUp' : 'ArrowDown', preventDefault() {} });
    const EDIT = {
      a: () => caret(0), // start of line
      e: () => caret(el.input.value.length), // end of line
      b: () => caret(at() - 1), // back a character
      f: () => caret(at() + 1), // forward a character
      d: () => cut(at(), at() + 1), // delete the character at the cursor
      k: () => cut(at(), el.input.value.length), // delete to the end of the line
      u: () => cut(0, at()), // delete to the start of the line
      x: () => cut(0, at()),
      w: () => cut(wordStart(at()), at()), // delete the word before the cursor
      p: (d) => recall(d, -1), // previous command
      n: (d) => recall(d, 1), // next command
      z: () => submit('end'), // leave configuration mode
      c: (d) => { // abandon the line; in configuration mode, return to privileged EXEC
        const mode = session(d.id).mode;
        el.input.value = '';
        if (mode !== 'user' && mode !== 'priv') submit('end');
      },
      l: () => render(), // redraw
    };

    // Lists the options for a Tab that could not complete, then shows the line again.
    function showOptions(d, list) {
      if (!list.length) return;
      const lines = log(d.id);
      if (!lines.length) lines.push(...banner(d));
      const prompt = P.promptFor(ctxFor(d.id), d.id);
      const width = Math.max(...list.map((x) => x.length)) + 2;
      const per = Math.max(1, Math.floor(72 / width));
      lines.push(`${prompt}${el.input.value}`);
      for (let i = 0; i < list.length; i += per) lines.push(list.slice(i, i + per).map((x) => x.padEnd(width)).join('').trimEnd());
      render();
      el.input.focus();
    }

    function onClick(e) {
      const b = e.target.closest('[data-c]');
      if (!b) return;
      const c = b.dataset.c;
      const d = current();
      if (c === 'dev') {
        ui.dev = b.dataset.id;
        armed = '';
        render();
        el.input.focus();
      } else if (c === 'clear') {
        ui.logs[d.id] = [];
        render();
      } else if (c === 'reset' || c === 'solution' || c === 'resetall') {
        if (armed !== c) {
          armed = c;
          b.textContent = c === 'solution' ? 'Click again to reveal' : 'Click again to confirm';
          return;
        }
        armed = '';
        if (c === 'reset') {
          delete practice().devices[d.id];
          delete practice().hosts[d.id];
          ui.sessions[d.id] = { mode: 'user', cur: null };
          log(d.id).push('', '% Device reset to factory defaults.', '');
          App.commit();
        } else if (c === 'resetall') {
          App.project.practice = { devices: {}, hosts: {} };
          ui.sessions = {};
          ui.logs = {};
          App.commit();
        } else {
          const lines = log(d.id);
          const text = M.isHost(d) ? P.fixCommands(App.project, student, d.id, practice()).join('\n') || '(already matches)' : PL.configgen.generate(App.project, d, { paste: false, notes: false }).split('\n').filter((l) => !/^! /.test(l)).join('\n');
          lines.push('', `! ---- Designed configuration for ${d.name} ----`, ...text.split('\n'), '! ----', '');
          render();
        }
      } else if (c === 'topo') {
        root.querySelector('#dlg-topo-body').innerHTML = App.topologySvg('');
        root.querySelector('#dlg-topo').showModal();
      } else if (c === 'cell') {
        const a = M.dev(App.project, b.dataset.from);
        const t = M.dev(App.project, b.dataset.to);
        ask(`why can't ${a.name} ping ${t.name}`);
      } else if (c === 'opt') {
        follow(+b.dataset.n);
      } else if (c === 'ask') {
        ask(root.querySelector('.ask input').value);
      }
    }

    // ---------- Assistant ----------

    function askContext() {
      return {
        p: student, sim: studentSim, issues: PL.validate.validate(student, studentSim), cli: true,
        fixFor: (ids) => {
          const want = ids ? new Set(ids) : null;
          return order().filter((d) => !want || want.has(d.id))
            .map((d) => ({ device: d.name, lines: P.fixCommands(App.project, student, d.id, practice()), host: M.isHost(d) }))
            .filter((f) => f.lines.length);
        },
      };
    }

    function ask(text) {
      const t = String(text || '').trim();
      if (!t) return;
      const st = ui.ts;
      if (st.a && /^[123]$/.test(t)) return follow(+t);
      st.q = t;
      st.a = PL.troubleshoot.ask(askContext(), t);
      st.view = 'summary';
      renderAsk();
    }

    function follow(n) {
      const st = ui.ts;
      if (n === 1) { st.a = null; st.q = ''; }
      if (n === 2) st.view = st.view === 'more' ? 'summary' : 'more';
      if (n === 3) st.view = st.view === 'fix' ? 'summary' : 'fix';
      renderAsk();
      if (n === 1) root.querySelector('.ask input').focus();
    }

    function renderAsk() {
      const st = ui.ts;
      const a = st.a;
      const opt = (n, label, on) => `<button type="button" class="ts-opt${on ? ' on' : ''}" data-c="opt" data-n="${n}"><span>${n}</span>${esc(label)}</button>`;
      el.ask.innerHTML = `<div class="sect ask"><div class="sect-head"><h3>Ask PatchLab</h3></div>
        <div class="ask-row"><input value="${esc(a ? '' : st.q)}" placeholder="${a ? 'Type 1, 2 or 3, or ask another question' : "Why can't PC1 ping PC2?"}" aria-label="Ask a question" spellcheck="false" autocomplete="off"><button type="button" class="btn small primary" data-c="ask">Ask</button></div>
        ${a ? `${PL.troubleshoot.render(a, st.view)}<div class="ts-opts">${opt(1, 'Ask another question')}${opt(2, 'More troubleshooting info about this problem', st.view === 'more')}${opt(3, 'Show me the suggested changes', st.view === 'fix')}</div>`
          : '<p class="note">Answers come from your configuration, not the designed one. Suggested changes are the commands that bring each device in line with the designed lab.</p>'}</div>`;
    }

    // ---------- Panels ----------

    function renderDevices() {
      const pr = practice();
      el.devs.innerHTML = order().map((d) => {
        const typed = M.isHost(d) ? (pr.hosts[d.id] ? (pr.hosts[d.id].mode === 'dhcp' ? 'DHCP' : pr.hosts[d.id].ip || 'set') : '') : `${((pr.devices[d.id] || {}).blocks || []).reduce((n, b) => n + 1 + b.kids.length, 0) || ''}`;
        const icon = MODELS[d.model].kind === 'host' ? d.model : MODELS[d.model].kind;
        return `<button type="button" class="cli-dev${d.id === current().id ? ' on' : ''}" data-c="dev" data-id="${d.id}"><svg aria-hidden="true"><use href="#ic-${icon}"/></svg>
          <span>${esc(d.name)}<small>${esc(MODELS[d.model].label.replace('Catalyst ', ''))}</small></span>${typed ? `<i>${esc(typed)}${M.isHost(d) ? '' : ' lines'}</i>` : ''}</button>`;
      }).join('') + '<div class="btn-row" style="margin-top:6px"><button type="button" class="btn small" data-c="resetall">Reset all devices</button></div>';
    }

    // What this device must end up with: its cables and the addresses from the designed lab.
    function renderBrief() {
      const d = current();
      const p = App.project;
      const cables = M.linksOf(p, d.id).map((l) => {
        const peer = M.dev(p, M.peerOf(l, d.id));
        const mine = l.members.map((m) => shortName(m[M.side(l, d.id)])).join(', ');
        return `<tr><td class="mono">${esc(mine)}</td><td>${esc(peer.name)} <span class="mono">${esc(l.members.map((m) => shortName(m[M.side(l, peer.id)])).join(', '))}</span></td></tr>`;
      }).join('');
      const rows = PL.guide.addressRows(p, App.sim).filter((r) => r.device === d.name);
      const vlans = p.vlans.filter((v) => v.id !== 1);
      el.brief.innerHTML = `<div class="sect-head"><h3>Lab brief: ${esc(d.name)}</h3></div>
        ${cables ? `<table class="nbrs"><thead><tr><th>Port</th><th>Connects to</th></tr></thead><tbody>${cables}</tbody></table>` : '<p class="note">Not cabled.</p>'}
        ${rows.length ? `<table class="nbrs"><thead><tr><th>Interface</th><th>Address</th></tr></thead><tbody>${rows.map((r) => `<tr><td class="mono">${esc(r.ifName)}</td><td class="mono">${esc(r.ip)}/${r.len}${r.gateway ? `<div class="sub">gw ${esc(r.gateway)}</div>` : ''}${r.vlan ? `<div class="sub">VLAN ${esc(r.vlan)}</div>` : ''}</td></tr>`).join('')}</tbody></table>` : ''}
        ${vlans.length && M.isSwitch(d) ? `<p class="note">VLANs: ${vlans.map((v) => `${v.id} ${esc(v.name)}`).join(', ')}</p>` : ''}
        <p class="note">The goal is the reachability of the designed lab. How you get there is up to you.</p>`;
    }

    function renderScore() {
      const sc = P.score(App.project, student);
      const grid = sc.hosts.map((h, i) => `<tr><th scope="row">${esc(h.name)}</th>${sc.hosts.map((t, j) => {
        if (i === j) return '<td><span class="cell self"></span></td>';
        const c = sc.cells.find((x) => x.from === h.id && x.to === t.id);
        if (!c) return '<td></td>';
        const cls = c.match ? (c.want ? 'ok' : 'blocked') : c.want ? 'no' : 'extra';
        const mark = c.match ? (c.want ? '✓' : '–') : c.want ? '✕' : '!';
        const title = c.match ? (c.want ? `${h.name} reaches ${t.name}, as designed` : `Blocked, as designed`) : c.want ? `Should reach ${t.name}. ${c.reason}` : `Should be blocked, but ${h.name} reaches ${t.name}`;
        return `<td><button type="button" class="cell ${cls}" title="${esc(title)}" aria-label="${esc(title)}" data-c="cell" data-from="${h.id}" data-to="${t.id}">${mark}</button></td>`;
      }).join('')}</tr>`).join('');
      const pct = sc.total ? Math.round((sc.matched / sc.total) * 100) : 0;
      const notes = student.practiceNotes || [];
      el.score.innerHTML = `<div class="sect-head"><h3>Score</h3><span class="chip ${sc.done ? 'good' : 'warn'}">${sc.matched} of ${sc.total} pairs</span></div>
        ${sc.done ? '<div class="verdict ok">Lab complete<small>Every host pair behaves as designed.</small></div>' : ''}
        <div class="meter"><i style="width:${pct}%"></i></div>
        ${sc.hosts.length > 1 ? `<div class="matrix-wrap"><table class="matrix"><thead><tr><th></th>${sc.hosts.map((h) => `<th scope="col">${esc(h.name)}</th>`).join('')}</tr></thead><tbody>${grid}</tbody></table></div>
          <p class="note">✓ works as designed, – blocked as designed, ✕ should work, ! should be blocked. Select a cell to ask why.</p>` : '<p class="note">The designed lab needs at least two hosts to score.</p>'}
        ${notes.length ? `<ul class="cli-notes">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}`;
    }

    function renderTerminal() {
      const d = current();
      const lines = log(d.id);
      if (!lines.length) lines.push(...banner(d));
      el.title.textContent = d.name;
      el.sub.textContent = ` ${MODELS[d.model].label}`;
      el.out.textContent = lines.join('\n');
      el.prompt.textContent = P.promptFor(ctxFor(d.id), d.id);
      el.box.scrollTop = el.box.scrollHeight;
      root.querySelectorAll('[data-c="reset"],[data-c="solution"],[data-c="resetall"]').forEach((b) => {
        if (b.dataset.c !== armed) b.textContent = { reset: 'Reset device', solution: 'Show solution', resetall: 'Reset all devices' }[b.dataset.c];
      });
    }

    function render() {
      if (!App.project.devices.length) {
        root.innerHTML = '<div class="tools-inner"><p class="note">Build a lab in the Designer first. The CLI lab resets its devices to factory defaults and scores what you type against it.</p></div>';
        built = false;
        return;
      }
      if (!built) build();
      if (!M.dev(App.project, ui.dev)) ui.dev = order()[0].id;
      student = P.buildStudent(App.project, practice());
      studentSim = S.simulate(student);
      renderDevices();
      renderBrief();
      renderTerminal();
      renderScore();
      renderAsk();
    }

    return { render, focus: () => el.input && el.input.focus() };
  }

  PL.cliview = { create };
})(window.PL = window.PL || {});
