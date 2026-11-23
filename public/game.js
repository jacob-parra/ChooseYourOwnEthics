(() => {
  const app = document.getElementById('app');
  const hud = document.getElementById('hud');
  const progress = document.getElementById('progress');
  const toasts = document.getElementById('toasts');
  const SAVE_KEY = 'cyoe-run-v1';
  const IDLE_SECONDS = 60; // end screen returns to the title after this much inactivity
  let story, state, config = { practice: false };

  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k != null) n.append(k.nodeType ? k : document.createTextNode(k));
    return n;
  };

  const api = async (url, body) => {
    try {
      const res = await fetch(url, body === undefined ? {} : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      return await res.json();
    } catch (e) {
      console.warn('API call failed', url, e);
      return null;
    }
  };

  // ---------- persistence (resume after an accidental refresh) ----------
  const save = () => { try { localStorage.setItem(SAVE_KEY, JSON.stringify(state)); } catch {} };
  const clearSave = () => { try { localStorage.removeItem(SAVE_KEY); } catch {} };
  const loadSave = () => {
    try {
      const s = JSON.parse(localStorage.getItem(SAVE_KEY));
      if (s && story.nodes[s.node] && !story.nodes[s.node].ending) return s;
    } catch {}
    return null;
  };

  function freshState() {
    return {
      runId: null,
      practice: config.practice,
      node: story.start,
      good: 0,
      bad: 0,
      counters: { ...story.counters },
      flags: { ...story.flags },
      grades: {},       // item -> {score?, bonus?, weight, ai}
      chapter: 0,
      trail: [],        // [{node, choice, score, recap}]
      polls: {},        // pollId -> optionId
    };
  }

  // ---------- grades ----------
  function letterFor(pct) {
    for (const [letter, min] of story.gradeScale || []) if (pct >= min) return letter;
    return 'F';
  }

  function classGrade() {
    let total = 0, weight = 0, bonus = 0;
    for (const g of Object.values(state.grades)) {
      if (typeof g.score === 'number') { total += g.score * g.weight; weight += g.weight; }
      if (typeof g.bonus === 'number') bonus += g.bonus;
    }
    if (!weight) return null;
    const pct = Math.min(100, Math.round(total / weight + bonus));
    return { pct, letter: letterFor(pct) };
  }

  function applyNodeEffects(node) {
    if (node.grade) {
      const g = node.grade;
      state.grades[g.item] = { score: g.score, bonus: g.bonus, weight: g.weight || 1, ai: !!g.ai };
      if (!node.ending) {
        const cg = classGrade();
        toast(g.bonus != null ? `${g.item}: +${g.bonus} bonus points` : `${g.item}: ${g.score}%`,
              cg ? `Class grade: ${cg.letter} (${cg.pct}%)` : '');
      }
    }
    if (node.regradeAI != null) {
      let changed = 0;
      for (const g of Object.values(state.grades)) {
        if (g.ai && typeof g.score === 'number') { g.score = node.regradeAI; g.redone = true; changed++; }
      }
      if (changed) {
        const cg = classGrade();
        toast(`${changed} assignment${changed === 1 ? '' : 's'} redone for ${node.regradeAI}% credit`, cg ? `Class grade: ${cg.letter} (${cg.pct}%)` : '');
      }
    }
    const ch = (story.chapters || []).findIndex(c => c.start === state.node);
    if (ch > state.chapter) state.chapter = ch;
  }

  // ---------- story engine ----------
  function test(cond) {
    if ('flag' in cond) return !!state.flags[cond.flag];
    const v = state.counters[cond.counter] ?? 0;
    switch (cond.op) {
      case '>': return v > cond.value;
      case '>=': return v >= cond.value;
      case '<': return v < cond.value;
      case '<=': return v <= cond.value;
      case '==': return v === cond.value;
      default: return false;
    }
  }

  // Follow invisible "branch" nodes (the blue if-checks) until we land on something to show.
  function resolve(id) {
    for (let guard = 0; guard < 50; guard++) {
      const n = story.nodes[id];
      if (!n.branch) return id;
      const hit = n.branch.find(b => test(b.if));
      id = hit ? hit.next : n.else;
    }
    throw new Error('branch loop');
  }

  function go(id) {
    state.node = resolve(id);
    applyNodeEffects(story.nodes[state.node]);
    save();
    render();
  }

  function choose(node, choice) {
    if (choice.score === 'good') state.good++;
    if (choice.score === 'bad') state.bad++;
    (choice.inc || []).forEach(c => { state.counters[c] = (state.counters[c] || 0) + 1; });
    Object.assign(state.flags, choice.set || {});
    if (node.poll && choice.pollOption) {
      state.polls[node.poll] = choice.pollOption;
      if (state.runId) api(`/api/runs/${state.runId}/poll`, { pollId: node.poll, option: choice.pollOption });
    }
    if (choice.score) state.trail.push({ node: state.node, choice: choice.label, score: choice.score, recap: choice.recap || choice.label });
    go(choice.next);
  }

  // ---------- chrome: HUD, progress, toasts ----------
  function toast(title, sub) {
    const t = el('div', { class: 'toast', role: 'status' }, el('strong', {}, title), sub ? el('span', {}, sub) : null);
    toasts.append(t);
    setTimeout(() => t.classList.add('out'), 3200);
    setTimeout(() => t.remove(), 3700);
  }

  function gradebookList(finalLetter) {
    const rows = Object.entries(state.grades);
    if (!rows.length) return el('p', { class: 'gb-empty' }, 'No grades yet.');
    const cg = classGrade();
    return el('div', {},
      el('ul', { class: 'gradebook' }, rows.map(([item, g]) =>
        el('li', {},
          el('span', {}, item, g.redone ? el('em', {}, ' (redone)') : null),
          el('span', { class: 'gb-score' }, g.bonus != null ? `+${g.bonus}` : `${g.score}%`)))),
      el('div', { class: 'gb-total' },
        el('span', {}, finalLetter ? 'Final grade' : 'Class grade'),
        el('span', {}, finalLetter || (cg ? `${cg.letter} · ${cg.pct}%` : '—'))));
  }

  function renderHud({ inGame, finalLetter } = {}) {
    hud.replaceChildren();
    if (config.practice || state?.practice) hud.append(el('span', { class: 'badge practice' }, 'Practice mode'));
    if (!inGame) return;
    const cg = classGrade();
    const label = finalLetter || (cg ? cg.letter : '—');
    const pop = el('div', { class: 'gb-pop', hidden: '' }, el('h3', {}, 'Gradebook'), gradebookList(finalLetter));
    const pill = el('button', { class: 'grade-pill', 'aria-expanded': 'false', title: 'Show gradebook',
      onclick: e => { e.stopPropagation(); const open = pop.hidden; pop.hidden = !open; pill.setAttribute('aria-expanded', String(open)); } },
      el('span', { class: 'gp-lbl' }, 'Grade'), el('span', { class: 'gp-val' }, label),
      cg && !finalLetter ? el('span', { class: 'gp-pct' }, `${cg.pct}%`) : null);
    hud.append(el('div', { class: 'gb-wrap' }, pill, pop));
    if (!finalLetter) hud.append(el('button', { class: 'linkish', onclick: startOver }, 'Start over'));
  }
  document.addEventListener('click', () => { const p = hud.querySelector('.gb-pop'); if (p && !p.hidden) { p.hidden = true; hud.querySelector('.grade-pill')?.setAttribute('aria-expanded', 'false'); } });

  function renderProgress(show, complete) {
    const chapters = story.chapters || [];
    if (!show || !chapters.length) { progress.hidden = true; return; }
    progress.hidden = false;
    const idx = complete ? chapters.length - 1 : state.chapter;
    const pct = complete ? 100 : Math.round(((idx + 0.5) / chapters.length) * 100);
    progress.replaceChildren(
      el('div', { class: 'pg-labels' },
        el('span', { class: 'pg-now' }, complete ? 'Semester complete' : chapters[idx].name),
        el('span', {}, complete ? '' : `Part ${idx + 1} of ${chapters.length}`)),
      el('div', { class: 'pg-track', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct) },
        el('span', { style: `width:${pct}%` })));
  }

  // ---------- screens ----------
  let keyHandler = null;
  function setKeys(fn) {
    if (keyHandler) document.removeEventListener('keydown', keyHandler);
    keyHandler = fn;
    if (fn) document.addEventListener('keydown', fn);
  }

  function mount(card) {
    app.replaceChildren(card);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    const first = card.querySelector('button');
    if (first) first.focus({ preventScroll: true });
  }

  function startOver() {
    if (!confirm('Start over from the beginning? This run will be lost.')) return;
    clearSave();
    renderTitle();
  }

  async function renderTitle() {
    stopIdle();
    clearSave();
    config = (await api('/api/config')) || config;
    state = null;
    renderHud();
    renderProgress(false);
    const start = async () => {
      state = freshState();
      const r = await api('/api/runs', {});
      state.runId = r?.id || null;
      state.practice = !!r?.practice;
      go(story.start);
    };
    mount(el('section', { class: 'card title-card fade-in' },
      el('h1', {}, story.title),
      el('p', {}, story.subtitle || ''),
      el('button', { class: 'btn', onclick: start }, 'Start the semester →'),
    ));
    setKeys(e => { if (e.key === 'Enter') { e.preventDefault(); start(); } });
  }

  function render() {
    const node = story.nodes[state.node];
    if (node.ending) return renderEnding(node);
    renderHud({ inGame: true });
    renderProgress(true);

    const card = el('section', { class: 'card fade-in' }, el('p', { class: 'story-text' }, node.text));
    if (node.note) card.append(el('div', { class: 'note' }, node.note));

    if (node.choices) {
      const list = el('div', { class: 'choices' });
      node.choices.forEach((c, i) => list.append(
        el('button', { class: 'choice' + (node.poll ? ' poll' : ''), onclick: () => choose(node, c) },
          node.choices.length > 1 ? el('span', { class: 'key' }, String(i + 1)) : null,
          el('span', {}, c.label)),
      ));
      card.append(list);
      setKeys(e => {
        const i = Number(e.key) - 1;
        if (node.choices[i]) choose(node, node.choices[i]);
        else if (e.key === 'Enter' && node.choices.length === 1) { e.preventDefault(); choose(node, node.choices[0]); }
      });
    } else {
      card.append(el('div', { class: 'continue-row' }, el('button', { class: 'btn', onclick: () => go(node.next) }, 'Continue →')));
      setKeys(e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(node.next); } });
    }
    mount(card);
  }

  async function renderEnding(node) {
    setKeys(null);
    clearSave();
    renderHud({ inGame: true, finalLetter: node.finalGrade || null });
    renderProgress(true, true);
    const result = state.runId
      ? await api(`/api/runs/${state.runId}/finish`, { good: state.good, bad: state.bad, ending: node.ending, path: state.trail })
      : null;
    const polls = result?.polls || await api('/api/polls') || {};

    const total = state.good + state.bad;
    const pct = total ? Math.round((state.good / total) * 100) : 0;

    const card = el('section', { class: 'card fade-in' },
      el('p', { class: 'story-text' }, node.text),
      el('p', { class: 'ending-label' }, 'The end'),
      el('h1', { class: 'ending-title' }, node.ending),
    );
    if (state.practice) card.append(el('div', { class: 'note' }, 'Practice mode: this playthrough was not recorded in the stats.'));

    // Score
    const meter = el('span', { style: 'width:0%' });
    card.append(el('div', { class: 'section' },
      el('h2', {}, 'Your score'),
      el('div', { class: 'score' },
        el('div', { class: 'tile good' }, el('div', { class: 'num' }, String(state.good)), el('div', { class: 'lbl' }, state.good === 1 ? 'good decision' : 'good decisions')),
        el('div', { class: 'tile bad' }, el('div', { class: 'num' }, String(state.bad)), el('div', { class: 'lbl' }, state.bad === 1 ? 'bad decision' : 'bad decisions')),
      ),
      el('div', { class: 'meter', role: 'img', 'aria-label': `${pct}% good decisions` }, meter),
      el('div', { class: 'meter-caption' }, `${pct}% of your decisions were good ones.`),
    ));
    requestAnimationFrame(() => requestAnimationFrame(() => { meter.style.width = pct + '%'; }));

    // Report card
    if (Object.keys(state.grades).length) {
      card.append(el('div', { class: 'section' }, el('h2', {}, 'Report card'), el('div', { class: 'report' }, gradebookList(node.finalGrade || null))));
    }

    // Real-world polls
    for (const [pollId, mine] of Object.entries(state.polls)) {
      const p = polls[pollId];
      if (!p) continue;
      const share = id => (p.total ? Math.round((p.options[id].count / p.total) * 100) : 0);
      const box = el('div', { class: 'poll-result' },
        el('p', { class: 'headline' }, p.total
          ? [el('strong', {}, `${share(mine)}%`), ` of people chose “${p.options[mine].label}”`]
          : `No one has answered yet. You chose “${p.options[mine].label}”`),
        el('div', { style: 'color:var(--ink-dim);font-size:.92rem' }, p.question),
      );
      const bars = [];
      for (const [id, o] of Object.entries(p.options)) {
        const fill = el('span', { style: 'width:0%' });
        bars.push([fill, share(id)]);
        box.append(el('div', { class: 'bar-row' + (id === mine ? ' mine' : '') },
          el('span', {}, o.label + (id === mine ? '  (you)' : '')),
          el('span', { class: 'pct' }, `${share(id)}%`),
          el('div', { class: 'bar' }, fill)));
      }
      box.append(el('div', { class: 'poll-total' }, `${p.total} ${p.total === 1 ? 'response' : 'responses'} so far`));
      card.append(el('div', { class: 'section' }, el('h2', {}, 'Real-world poll'), box));
      requestAnimationFrame(() => requestAnimationFrame(() => bars.forEach(([f, w]) => { f.style.width = w + '%'; })));
    }

    // Recap
    if (state.trail.length) {
      card.append(el('div', { class: 'section' },
        el('h2', {}, 'Your decisions'),
        el('ol', { class: 'recap' }, state.trail.map(t =>
          el('li', { class: t.score }, el('span', { class: 'dot' }), el('span', {}, t.recap), el('span', { class: 'tag' }, t.score))))));
    }

    const countdown = el('p', { class: 'idle-note' });
    card.append(el('div', { class: 'end-actions' }, el('button', { class: 'btn', onclick: renderTitle }, 'Play again')), countdown);
    mount(card);
    startIdle(countdown);
  }

  // ---------- kiosk idle reset (end screen only) ----------
  let idleTimer = null, idleLeft = 0, idleEl = null;
  const IDLE_EVENTS = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'];
  const bumpIdle = () => { idleLeft = IDLE_SECONDS; paintIdle(); };
  const paintIdle = () => { if (idleEl) idleEl.textContent = `Returning to the title screen in ${idleLeft}s`; };
  function startIdle(target) {
    stopIdle();
    idleEl = target;
    idleLeft = IDLE_SECONDS;
    paintIdle();
    IDLE_EVENTS.forEach(ev => window.addEventListener(ev, bumpIdle, { passive: true }));
    idleTimer = setInterval(() => {
      idleLeft--;
      paintIdle();
      if (idleLeft <= 0) renderTitle();
    }, 1000);
  }
  function stopIdle() {
    clearInterval(idleTimer);
    idleTimer = null;
    idleEl = null;
    IDLE_EVENTS.forEach(ev => window.removeEventListener(ev, bumpIdle));
  }

  (async () => {
    story = await api('/api/story');
    if (!story) { app.textContent = 'Could not load the story. Is the server running?'; return; }
    document.title = story.title;
    config = (await api('/api/config')) || config;
    const saved = loadSave();
    if (saved) {
      state = saved;
      render();
      toast('Welcome back!', 'Picked up right where you left off.');
    } else {
      renderTitle();
    }
  })();
})();
