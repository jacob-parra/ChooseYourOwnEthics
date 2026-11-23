(() => {
  const app = document.getElementById('app');
  const stepEl = document.getElementById('step');
  let story, state;

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

  function freshState() {
    return {
      runId: null,
      node: story.start,
      good: 0,
      bad: 0,
      counters: { ...story.counters },
      flags: { ...story.flags },
      trail: [],        // [{node, choice, score, recap}]
      polls: {},        // pollId -> optionId
    };
  }

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

  function renderTitle() {
    stepEl.textContent = '';
    const start = async () => {
      state = freshState();
      const r = await api('/api/runs', {});
      state.runId = r?.id || null;
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
    stepEl.textContent = state.trail.length ? `Decisions made: ${state.trail.length}` : '';

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
    stepEl.textContent = '';
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

    // Real-world polls
    for (const [pollId, mine] of Object.entries(state.polls)) {
      const p = polls[pollId];
      if (!p) continue;
      const share = id => (p.total ? Math.round((p.options[id].count / p.total) * 100) : 0);
      const box = el('div', { class: 'poll-result' },
        el('p', { class: 'headline' }, el('strong', {}, `${share(mine)}%`), ` of people chose “${p.options[mine].label}”`),
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

    card.append(el('div', { class: 'end-actions' }, el('button', { class: 'btn', onclick: renderTitle }, 'Play again')));
    mount(card);
  }

  (async () => {
    story = await api('/api/story');
    if (!story) { app.textContent = 'Could not load the story. Is the server running?'; return; }
    document.title = story.title;
    renderTitle();
  })();
})();
