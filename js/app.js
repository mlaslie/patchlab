// Application state, undo history, persistence and the top-level controls.
(function (PL) {
  'use strict';

  const { MODELS, PALETTE } = PL.catalog;
  const M = PL.model;
  const STORE = 'patchlab.project.v1';
  const THEME = 'patchlab.theme';

  const App = {
    project: null,
    sim: null,
    issues: [],
    sel: null,
    tab: 'inspect',
    view: 'design',
    tool: 'select',
    trace: null,
    ui: {
      devTab: 'if', open: {}, apply: {}, skipCommit: false, pingResult: null,
      cfg: { device: null, notes: true, paste: true, feature: 'all' },
      ping: { from: '', to: '', proto: 'icmp', port: 80 },
      routes: { view: 'table', proto: 'all' },
      stp: { vlan: null, view: 'table' },
      ts: { q: '', a: null, view: 'summary' },
      cli: { dev: null, sessions: {}, logs: {}, hist: {}, histAt: null, ts: { q: '', a: null, view: 'summary' } },
      toolTab: 'subnet',
      tools: {
        ip: '192.168.10.77', mask: '/26', base: '192.168.1.0/24', guideDev: '',
        v6: { prefix: '2001:db8:acad::/48', newLen: 64, from: '0' },
        rows: [{ name: 'STAFF', hosts: 50 }, { name: 'STUDENTS', hosts: 100 }, { name: 'SERVERS', hosts: 12 }, { name: 'R1-R2', hosts: 2 }],
      },
    },
    undo: [],
    redo: [],
    last: '',
  };

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage is a convenience here */ } },
  };

  App.isSel = (type, id) => !!App.sel && App.sel.type === type && App.sel.id === id;

  App.select = (type, id) => {
    App.sel = type ? { type, id } : null;
    if (type === 'device') App.ui.cfg.device = id;
  };

  function analyse() {
    App.sim = PL.simulate.simulate(App.project);
    App.issues = PL.validate.validate(App.project, App.sim);
  }

  App.renderPanel = () => App.inspector.render();

  // The designer (palette, canvas, side panel), the CLI lab, or the Tools page.
  App.setView = (v) => {
    App.view = v;
    document.getElementById('app').classList.toggle('view-tools', v === 'tools');
    document.getElementById('app').classList.toggle('view-cli', v === 'cli');
    document.getElementById('tools-page').hidden = v !== 'tools';
    document.getElementById('cli-page').hidden = v !== 'cli';
    document.querySelectorAll('.views [data-view]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === v)));
    App.renderAll();
    if (v === 'cli') App.cli.focus();
  };

  App.renderAll = () => {
    App.canvas.render();
    App.inspector.render();
    if (App.view === 'cli') App.cli.render();
    document.getElementById('btn-undo').disabled = !App.undo.length;
    document.getElementById('btn-redo').disabled = !App.redo.length;
    const name = document.getElementById('lab-name');
    if (document.activeElement !== name) name.value = App.project.name;
  };

  // Records one undo step. Every edit in the app ends here.
  App.commit = (opts) => {
    const json = JSON.stringify(App.project);
    if (json !== App.last) {
      App.undo.push(App.last);
      if (App.undo.length > 100) App.undo.shift();
      App.redo = [];
      App.last = json;
      store.set(STORE, json);
      App.trace = null;
      App.ui.pingResult = null;
    }
    analyse();
    App.renderAll();
    return opts;
  };

  function restore(json) {
    App.project = M.normalize(JSON.parse(json));
    App.last = json;
    store.set(STORE, json);
    if (App.sel) {
      const gone = App.sel.type === 'device' ? !M.dev(App.project, App.sel.id) : !App.project.links.some((l) => l.id === App.sel.id);
      if (gone) App.sel = null;
    }
    App.trace = null;
    App.ui.pingResult = null;
    analyse();
    App.renderAll();
  }

  function undo() {
    if (!App.undo.length) return;
    App.redo.push(App.last);
    restore(App.undo.pop());
  }

  function redo() {
    if (!App.redo.length) return;
    App.undo.push(App.last);
    restore(App.redo.pop());
  }

  App.loadProject = (project, message) => {
    App.project = M.normalize(project);
    App.select(null);
    App.ui.cfg.device = null;
    App.tab = 'inspect';
    App.commit();
    App.canvas.fit();
    if (message) App.toast(message);
  };

  App.deleteSelection = () => {
    if (!App.sel) return;
    if (App.sel.type === 'device') M.removeDevice(App.project, App.sel.id);
    else M.removeLink(App.project, App.sel.id);
    App.select(null);
    App.commit();
  };

  let toastTimer;
  App.toast = (text) => {
    const el = document.getElementById('toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
  };

  App.copy = (text) => {
    const fallback = () => {
      const pre = document.querySelector('.cli');
      if (pre) {
        const range = document.createRange();
        range.selectNodeContents(pre);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
      App.toast('Clipboard is blocked here. The text is selected, so press Cmd/Ctrl+C.');
    };
    if (!navigator.clipboard) return fallback();
    navigator.clipboard.writeText(text).then(() => App.toast('Copied to clipboard.'), fallback);
  };

  // The hosted viewer blocks plain downloads and offers a save prompt instead.
  App.download = async (name, text, type) => {
    if (window.claude && window.claude.use) {
      const downloads = await window.claude.use('downloads');
      const binary = text instanceof Blob;
      if (!downloads) return binary ? App.toast('Downloads are not available here.') : App.copy(text);
      return downloads.save({ filename: name, data: text }).then(
        () => App.toast(`Saved ${name}.`),
        (err) => { if (err.code !== 'declined' && !binary) App.copy(text); },
      );
    }
    const url = URL.createObjectURL(text instanceof Blob ? text : new Blob([text], { type: type || 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  // ---------- Exports ----------

  const baseName = () => (App.project.name || 'lab').trim().replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '-') || 'lab';

  function topologySvg(title) {
    const symbols = [...document.querySelectorAll('svg defs symbol')].map((x) => x.outerHTML).join('');
    return PL.exporter.standaloneSvg(App.project, App.canvas.exportMarkup(), symbols, title);
  }

  App.topologySvg = topologySvg;

  App.exportSvg = () => App.download(`${baseName()}.svg`, topologySvg(App.project.name), 'image/svg+xml');

  App.exportPng = () => {
    const svg = topologySvg(App.project.name);
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    img.onload = () => {
      const scale = 2;
      const c = document.createElement('canvas');
      c.width = img.width * scale;
      c.height = img.height * scale;
      const g = c.getContext('2d');
      g.scale(scale, scale);
      g.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      c.toBlob((blob) => (blob ? App.download(`${baseName()}.png`, blob, 'image/png') : App.toast('This browser could not draw the PNG. Try SVG.')), 'image/png');
    };
    img.onerror = () => App.toast('This browser could not draw the PNG. Try SVG.');
    img.src = url;
  };

  // "print" opens the sheet in a frame and prints it; "download" saves the HTML.
  App.answerSheet = (how) => {
    const html = PL.guide.answerSheet(App.project, App.sim, topologySvg(''), App.issues);
    if (how === 'download') return App.download(`${baseName()}-answer-sheet.html`, html, 'text/html');
    let frame = document.getElementById('print-frame');
    if (!frame) {
      frame = document.createElement('iframe');
      frame.id = 'print-frame';
      frame.title = 'Answer sheet';
      frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
      document.body.appendChild(frame);
    }
    frame.onload = () => {
      try {
        frame.contentWindow.focus();
        frame.contentWindow.print();
      } catch (e) {
        App.download(`${baseName()}-answer-sheet.html`, html, 'text/html');
      }
    };
    frame.srcdoc = html;
  };

  // ---------- Config import ----------

  App.importConfig = (d) => {
    const dlg = document.getElementById('dlg-import');
    const text = document.getElementById('dlg-import-text');
    document.getElementById('dlg-import-title').textContent = `Import a configuration into ${d.name}`;
    text.value = '';
    document.getElementById('dlg-import-cancel').onclick = () => dlg.close('cancel');
    dlg.onclose = () => {
      if (dlg.returnValue !== 'import' || !text.value.trim()) return;
      const parsed = PL.importer.parse(text.value);
      const res = PL.importer.apply(App.project, d, parsed);
      App.select('device', d.id);
      App.commit();
      const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      const body = document.getElementById('dlg-report-body');
      body.innerHTML = `<p>Read ${res.used} command${res.used === 1 ? '' : 's'} into ${esc(d.name)}. Undo puts the previous settings back.</p>
        ${res.notes.length ? `<p><b>Check these</b></p><ul>${res.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
        ${res.skipped.length ? `<p><b>Not imported (${res.skipped.length})</b>: PatchLab does not model these lines.</p><ul>${res.skipped.map((x) => `<li>line ${x.n}: <code>${esc(x.line)}</code></li>`).join('')}</ul>` : '<p>Every configuration line was understood.</p>'}`;
      document.getElementById('dlg-report').showModal();
    };
    dlg.returnValue = '';
    dlg.showModal();
    text.focus();
  };

  // ---------- Palette ----------

  function buildPalette() {
    const el = document.getElementById('palette');
    el.innerHTML = PALETTE.map((g) => `<div class="pal-group"><div class="eyebrow">${g.title}</div>${g.items.map((id) => {
      const m = MODELS[id];
      const kind = m.kind === 'host' ? id : m.kind;
      return `<button type="button" class="pal-item" data-model="${id}" title="Drag onto the canvas, or click to add"><svg aria-hidden="true"><use href="#ic-${kind}"/></svg><span>${m.label.replace('Catalyst ', '')}</span></button>`;
    }).join('')}</div>`).join('');

    const ghost = document.getElementById('ghost');
    let drag = null;

    el.addEventListener('pointerdown', (e) => {
      const item = e.target.closest('.pal-item');
      if (!item || e.button !== 0) return;
      drag = { model: item.dataset.model, x: e.clientX, y: e.clientY, moved: false, pointer: e.pointerId, item };
      item.setPointerCapture(e.pointerId);
    });

    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 5) {
        drag.moved = true;
        const m = MODELS[drag.model];
        ghost.innerHTML = `<svg aria-hidden="true"><use href="#ic-${m.kind === 'host' ? drag.model : m.kind}"/></svg>`;
        ghost.hidden = false;
      }
      if (drag.moved) {
        ghost.style.left = `${e.clientX}px`;
        ghost.style.top = `${e.clientY}px`;
      }
    });

    const place = (model, x, y) => {
      const d = M.addDevice(App.project, model, Math.round(x / 20) * 20, Math.round(y / 20) * 20);
      App.select('device', d.id);
      App.tab = 'inspect';
      App.commit();
    };

    function end(e) {
      if (!drag) return;
      const cur = drag;
      drag = null;
      ghost.hidden = true;
      if (e.type === 'pointercancel') return;
      if (!cur.moved) {
        // Stagger click-added devices so they do not stack.
        const c = App.canvas.centre();
        const n = App.project.devices.length % 6;
        return place(cur.model, c.x - 100 + n * 40, c.y - 60 + n * 30);
      }
      const r = App.canvas.svg.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
      const w = App.canvas.toWorld(e.clientX, e.clientY);
      place(cur.model, w.x, w.y);
    }
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  // ---------- Saving to a file ----------

  const UNTITLED = M.newProject().name;
  const fileNameFor = (name) => `${name.trim().replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '-') || 'lab'}.json`;

  function writeLabFile() {
    App.download(fileNameFor(App.project.name), JSON.stringify(App.project, null, 2), 'application/json');
  }

  // A lab still called "Untitled lab" gets a name before it is saved, so files are not all
  // Untitled-lab.json. Named labs save straight away.
  function saveLab() {
    const current = (App.project.name || '').trim();
    if (current && current !== UNTITLED) return writeLabFile();
    const dlg = document.getElementById('dlg-save');
    const input = document.getElementById('dlg-save-name');
    const file = document.getElementById('dlg-save-file');
    input.value = '';
    file.textContent = fileNameFor('');
    input.oninput = () => { file.textContent = fileNameFor(input.value); };
    document.getElementById('dlg-save-cancel').onclick = () => dlg.close('cancel');
    dlg.onclose = () => {
      const name = input.value.trim();
      if (dlg.returnValue !== 'save' || !name) return;
      App.project.name = name;
      App.commit();
      writeLabFile();
    };
    dlg.returnValue = '';
    dlg.showModal();
    input.focus();
  }

  // ---------- Labs menu ----------

  function buildMenu() {
    const btn = document.getElementById('btn-labs');
    const menu = document.getElementById('menu-labs');
    const close = () => {
      menu.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    };
    menu.innerHTML = `${PL.samples.map((s) => `<button type="button" data-sample="${s.id}"><span>${s.title}</span><small>${s.blurb}</small></button>`).join('')}
      <hr>
      <button type="button" data-do="new"><span>New blank lab</span></button>
      <button type="button" data-do="import"><span>Open a saved lab</span><small>Load a .json file you exported</small></button>
      <button type="button" data-do="export"><span>Save lab as a file</span></button>
      <button type="button" data-do="copyjson"><span>Copy lab data</span><small>Paste into a .json file where downloads are blocked</small></button>`;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
      btn.setAttribute('aria-expanded', String(!menu.hidden));
    });
    document.addEventListener('pointerdown', (e) => {
      if (!menu.hidden && !menu.contains(e.target) && e.target !== btn) close();
    });
    menu.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      close();
      if (b.dataset.sample) {
        const s = PL.samples.find((x) => x.id === b.dataset.sample);
        return App.loadProject(s.build(), `Loaded ${s.title}. Undo brings your previous lab back.`);
      }
      const what = b.dataset.do;
      if (what === 'new') App.loadProject(M.newProject(), 'Started a blank lab. Undo brings the previous one back.');
      if (what === 'import') document.getElementById('file-import').click();
      if (what === 'export') saveLab();
      if (what === 'copyjson') App.copy(JSON.stringify(App.project));
    });
    document.getElementById('file-import').addEventListener('change', (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          App.loadProject(JSON.parse(reader.result), `Opened ${file.name}.`);
        } catch (err) {
          App.toast(`${file.name} is not a PatchLab file.`);
        }
      };
      reader.readAsText(file);
    });
  }

  function setupTheme() {
    const root = document.documentElement;
    const saved = store.get(THEME);
    if (saved) root.dataset.theme = saved;
    document.getElementById('btn-theme').addEventListener('click', () => {
      const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
      root.dataset.theme = dark ? 'light' : 'dark';
      store.set(THEME, root.dataset.theme);
    });
  }

  function setupResize() {
    const handle = document.getElementById('resize');
    let on = false;
    handle.addEventListener('pointerdown', (e) => {
      on = true;
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
      if (!on) return;
      const w = Math.min(760, Math.max(320, window.innerWidth - e.clientX));
      document.documentElement.style.setProperty('--panel-w', `${w}px`);
    });
    handle.addEventListener('pointerup', () => { on = false; });
  }

  function setupKeys() {
    document.addEventListener('keydown', (e) => {
      const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z' && !typing) {
        e.preventDefault();
        return e.shiftKey ? redo() : undo();
      }
      if (typing || App.view !== 'design') return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        App.deleteSelection();
      } else if (e.key === 'Escape') {
        App.canvas.cancel();
        App.canvas.setTool('select');
      } else if (!mod && e.key.toLowerCase() === 'v') App.canvas.setTool('select');
      else if (!mod && e.key.toLowerCase() === 'e') App.canvas.setTool('ethernet');
      else if (!mod && e.key.toLowerCase() === 'f') App.canvas.fit();
    });
  }

  function boot() {
    let project = null;
    const saved = store.get(STORE);
    if (saved) {
      try {
        project = M.normalize(JSON.parse(saved));
      } catch (e) {
        project = null;
      }
    }
    App.project = project || PL.samples[0].build();
    App.last = JSON.stringify(App.project);
    analyse();
    App.canvas = PL.canvas.create(App);
    App.inspector = PL.inspector.create(App);
    App.cli = PL.cliview.create(App);
    buildPalette();
    buildMenu();
    setupTheme();
    setupResize();
    setupKeys();

    const name = document.getElementById('lab-name');
    name.addEventListener('change', () => {
      App.project.name = name.value.trim() || 'Untitled lab';
      App.commit();
    });
    document.querySelectorAll('.views [data-view]').forEach((b) => b.addEventListener('click', () => App.setView(b.dataset.view)));
    document.getElementById('btn-undo').addEventListener('click', undo);
    document.getElementById('btn-redo').addEventListener('click', redo);

    App.canvas.setTool('select');
    App.renderAll();
    App.canvas.fit();
    window.addEventListener('resize', () => App.canvas.render());
    window.PatchLab = App;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window.PL = window.PL || {});
