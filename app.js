/* ============================================================
   JEOPARDY! — application logic
   ============================================================ */
'use strict';

// ---------- Constants ----------
const VALUES = [200, 400, 600, 800, 1000];
const STORAGE_GAMES = 'jeopardy_custom_games_v1';
const STORAGE_STATE = 'jeopardy_active_state_v1';

// ---------- App state ----------
const state = {
  customGames: [],
  currentGameId: null,
  // Active gameplay state per game id (preserves answered tiles, scores, teams)
  active: null,        // { gameId, gameSnapshot, teams, answered: Set, dailyDoubles: Set, finalDone }
  currentClue: null,   // { categoryIdx, clueIdx, value, isDD, wager, ddTeamId }
  selectedDDTeamId: null,
  finalStep: null,     // 'wager' | 'reveal-clue' | 'reveal-answer' | 'award'
  finalWagers: {},     // { teamId: wager }
  pendingBuilder: null,// { isEdit, gameId }
};

// ---------- Utilities ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const fmt$ = (n) => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString();
const uid = () => 'g_' + Math.random().toString(36).slice(2, 10);

function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

// ---------- Storage ----------
function loadCustomGames() {
  try {
    const raw = localStorage.getItem(STORAGE_GAMES);
    state.customGames = raw ? JSON.parse(raw) : [];
  } catch { state.customGames = []; }
}
function saveCustomGames() {
  localStorage.setItem(STORAGE_GAMES, JSON.stringify(state.customGames));
}
function loadActiveState() {
  try {
    const raw = localStorage.getItem(STORAGE_STATE);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed.answered) parsed.answered = new Set(parsed.answered);
    if (parsed.dailyDoubles) parsed.dailyDoubles = new Set(parsed.dailyDoubles);
    return parsed;
  } catch { return null; }
}
function saveActiveState() {
  if (!state.active) { localStorage.removeItem(STORAGE_STATE); return; }
  const snapshot = {
    ...state.active,
    answered: Array.from(state.active.answered),
    dailyDoubles: Array.from(state.active.dailyDoubles),
  };
  localStorage.setItem(STORAGE_STATE, JSON.stringify(snapshot));
}

// ---------- Game lookup ----------
function getAllGames() {
  return [...SAMPLE_GAMES.map(g => ({ ...g, _sample: true })), ...state.customGames];
}
function findGame(id) {
  return getAllGames().find(g => g.id === id);
}

// ---------- Screen routing ----------
function showScreen(name) {
  $$('.screen').forEach(s => s.classList.remove('active'));
  const target = document.getElementById(name + '-screen');
  if (target) target.classList.add('active');
}

// ---------- HOME ----------
function renderHome() {
  const sampleEl = $('#sample-games');
  const customEl = $('#custom-games');
  sampleEl.innerHTML = '';
  customEl.innerHTML = '';

  SAMPLE_GAMES.forEach(g => sampleEl.appendChild(makeGameCard(g, true)));

  if (state.customGames.length === 0) {
    customEl.innerHTML = '<div class="empty-state">No custom games yet. Click "+ New Custom Game" to create one, or paste categories in chat with Claude to generate one.</div>';
  } else {
    state.customGames.forEach(g => customEl.appendChild(makeGameCard(g, false)));
  }
}

function makeGameCard(game, isSample) {
  const card = document.createElement('div');
  card.className = 'game-card';
  const cats = game.categories?.length || 0;
  const fjLabel = game.finalJeopardy ? ' • Final Jeopardy' : '';
  card.innerHTML = `
    <div class="game-card-title">${escapeHtml(game.title)}</div>
    <div class="game-card-desc">${escapeHtml(game.description || '')}</div>
    <div class="game-card-meta">
      <span>${cats} categories${fjLabel}</span>
      <span class="game-card-difficulty">${escapeHtml(game.difficulty || 'Custom')}</span>
    </div>
    <div class="game-card-actions">
      <button class="btn btn-primary btn-small" data-action="play">Play</button>
      ${isSample ? '' : '<button class="btn btn-secondary btn-small" data-action="edit">Edit</button>'}
      <button class="btn btn-secondary btn-small" data-action="export">Export</button>
      ${isSample ? '' : '<button class="btn btn-danger btn-small" data-action="delete">Delete</button>'}
    </div>
  `;
  card.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    const action = btn?.dataset.action;
    if (action === 'play' || !action) { startGame(game.id); return; }
    e.stopPropagation();
    if (action === 'edit') openBuilder(game.id);
    else if (action === 'export') exportGame(game);
    else if (action === 'delete') deleteCustomGame(game.id);
  });
  return card;
}

function deleteCustomGame(id) {
  if (!confirm('Delete this custom game? Cannot be undone.')) return;
  state.customGames = state.customGames.filter(g => g.id !== id);
  saveCustomGames();
  renderHome();
}

function exportGame(game) {
  const clean = deepClone(game);
  delete clean._sample;
  const blob = new Blob([JSON.stringify(clean, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (game.title || 'game').replace(/[^a-z0-9]+/gi, '_').toLowerCase() + '.json';
  a.click();
  URL.revokeObjectURL(url);
}

function exportAll() {
  const all = { sampleGames: SAMPLE_GAMES, customGames: state.customGames };
  const blob = new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'jeopardy_games_export.json';
  a.click();
  URL.revokeObjectURL(url);
}

// ---------- GAME PLAY ----------
function startGame(gameId) {
  const game = findGame(gameId);
  if (!game) { alert('Game not found'); return; }
  const prev = loadActiveState();
  // Restore prior state only if game structure (categories) hasn't changed in source
  const sameStructure = prev && prev.gameId === gameId && prev.gameSnapshot
    && prev.gameSnapshot.categories.length === game.categories.length
    && prev.gameSnapshot.categories.every((c, i) =>
        c.name === game.categories[i].name &&
        c.clues.length === game.categories[i].clues.length);
  if (sameStructure) {
    state.active = prev;
    if (!state.active.teams || state.active.teams.length === 0) {
      state.active.teams = defaultTeams();
    }
  } else {
    initActiveGame(game);
  }
  state.currentGameId = gameId;
  showScreen('game');
  renderGame();
}

function initActiveGame(game) {
  const dailyDoubles = new Set();

  state.active = {
    gameId: game.id,
    gameSnapshot: deepClone(game),
    teams: defaultTeams(),
    answered: new Set(),
    dailyDoubles,
    finalDone: false,
  };
  saveActiveState();
}

function defaultTeams() {
  return [
    { id: 't1', name: 'Team 1', score: 0 },
    { id: 't2', name: 'Team 2', score: 0 },
  ];
}

function renderGame() {
  const game = state.active.gameSnapshot;
  $('#game-title-display').textContent = game.title;
  renderBoard();
  renderScoreboard();
}

function renderBoard() {
  const board = $('#board');
  const game = state.active.gameSnapshot;
  board.innerHTML = '';

  const numRows = Math.max(...game.categories.map(c => c.clues.length));
  const numCols = game.categories.length;
  board.style.gridTemplateRows = `0.7fr repeat(${numRows}, 1fr)`;
  board.style.gridTemplateColumns = `repeat(${numCols}, 1fr)`;

  // Top row: categories
  game.categories.forEach((cat) => {
    const tile = document.createElement('div');
    tile.className = 'tile tile-category';
    tile.textContent = cat.name;
    board.appendChild(tile);
  });

  for (let row = 0; row < numRows; row++) {
    game.categories.forEach((cat, ci) => {
      const tile = document.createElement('div');
      tile.className = 'tile';
      const clue = cat.clues[row];
      if (!clue) { tile.classList.add('answered'); board.appendChild(tile); return; }
      const key = `${ci}:${row}`;
      const isAnswered = state.active.answered.has(key);
      if (isAnswered) tile.classList.add('answered');
      const value = clue.value || VALUES[row] || (200 * (row + 1));
      const valEl = document.createElement('div');
      valEl.className = 'tile-value';
      valEl.textContent = '$' + value;
      tile.appendChild(valEl);
      tile.addEventListener('click', () => {
        if (!isAnswered) openClue(ci, row);
      });
      board.appendChild(tile);
    });
  }
}

function renderScoreboard() {
  const sb = $('#scoreboard');
  sb.innerHTML = '';
  state.active.teams.forEach((team, idx) => {
    const panel = document.createElement('div');
    panel.className = 'team-panel';
    panel.innerHTML = `
      ${state.active.teams.length > 1 ? `<button class="team-remove" title="Remove team">×</button>` : ''}
      <input class="team-name" type="text" value="${escapeAttr(team.name)}">
      <input class="team-score ${team.score < 0 ? 'negative' : ''}" type="number" value="${team.score}">
      <div class="team-quick-controls">
        <button data-delta="-1000">-1k</button>
        <button data-delta="-500">-500</button>
        <button data-delta="500">+500</button>
        <button data-delta="1000">+1k</button>
      </div>
    `;
    const nameInput = panel.querySelector('.team-name');
    const scoreInput = panel.querySelector('.team-score');
    nameInput.addEventListener('change', () => {
      team.name = nameInput.value || `Team ${idx + 1}`;
      saveActiveState();
    });
    scoreInput.addEventListener('change', () => {
      team.score = parseInt(scoreInput.value, 10) || 0;
      scoreInput.classList.toggle('negative', team.score < 0);
      saveActiveState();
    });
    panel.querySelectorAll('[data-delta]').forEach(btn => {
      btn.addEventListener('click', () => {
        team.score += parseInt(btn.dataset.delta, 10);
        renderScoreboard();
        saveActiveState();
      });
    });
    const removeBtn = panel.querySelector('.team-remove');
    if (removeBtn) {
      removeBtn.addEventListener('click', () => {
        if (state.active.teams.length <= 1) return;
        state.active.teams.splice(idx, 1);
        renderScoreboard();
        saveActiveState();
      });
    }
    sb.appendChild(panel);
  });
}

function addTeam() {
  if (state.active.teams.length >= 8) { alert('Max 8 teams'); return; }
  const n = state.active.teams.length + 1;
  state.active.teams.push({ id: 't' + n + Date.now().toString(36).slice(-3), name: `Team ${n}`, score: 0 });
  renderScoreboard();
  saveActiveState();
}

// ---------- Clue handling ----------
function openClue(ci, qi) {
  const game = state.active.gameSnapshot;
  const clue = game.categories[ci].clues[qi];
  const value = clue.value || VALUES[qi];
  const key = `${ci}:${qi}`;
  const isDD = state.active.dailyDoubles.has(key);

  state.currentClue = { ci, qi, value, isDD, wager: null, ddTeamId: null, key };

  if (isDD) {
    showDailyDoubleModal();
  } else {
    showClueModal();
  }
}

function showClueModal() {
  const cl = state.currentClue;
  const game = state.active.gameSnapshot;
  const clue = game.categories[cl.ci].clues[cl.qi];

  const valueShown = cl.isDD ? cl.wager : cl.value;
  $('#clue-meta').innerHTML =
    (cl.isDD ? '<span style="color:#ff8;animation:pulse 1.4s ease-in-out infinite">★ DAILY DOUBLE ★</span> &nbsp; ' : '') +
    escapeHtml(game.categories[cl.ci].name) + ' &middot; ' + fmt$(valueShown);
  $('#clue-text').textContent = clue.clue;
  $('#clue-answer').textContent = clue.answer;
  $('#clue-answer').classList.remove('visible');
  $('#clue-hint').style.display = 'block';
  $('#clue-team-buttons').innerHTML = '';
  $('#clue-modal').classList.add('active');
}

function revealAnswer() {
  if (!state.currentClue) return;
  $('#clue-answer').classList.add('visible');
  $('#clue-hint').style.display = 'none';
  renderTeamButtons();
}

function renderTeamButtons() {
  const cont = $('#clue-team-buttons');
  cont.innerHTML = '';
  const cl = state.currentClue;
  const value = cl.isDD ? cl.wager : cl.value;

  // For daily double, only the wagering team can be awarded
  const teams = cl.isDD
    ? state.active.teams.filter(t => t.id === cl.ddTeamId)
    : state.active.teams;

  teams.forEach((team, idx) => {
    const grp = document.createElement('div');
    grp.className = 'team-button-group';
    grp.innerHTML = `
      <div class="team-button-name">${escapeHtml(team.name)}</div>
      <div class="team-button-row">
        <button class="btn-correct" title="Correct (+${fmt$(value)})">+${fmt$(value)}</button>
        <button class="btn-incorrect" title="Incorrect (-${fmt$(value)})">-${fmt$(value)}</button>
      </div>
    `;
    const [okBtn, badBtn] = grp.querySelectorAll('button');
    okBtn.addEventListener('click', () => awardPoints(team.id, value, true));
    badBtn.addEventListener('click', () => awardPoints(team.id, -value, true));
    cont.appendChild(grp);
  });
}

function awardPoints(teamId, delta, closeAfter) {
  const team = state.active.teams.find(t => t.id === teamId);
  if (!team) return;
  team.score += delta;
  state.active.answered.add(state.currentClue.key);
  saveActiveState();
  renderScoreboard();
  if (closeAfter) closeClue();
  else renderBoard();
}

function closeClue() {
  if (state.currentClue) {
    state.active.answered.add(state.currentClue.key);
  }
  state.currentClue = null;
  $('#clue-modal').classList.remove('active');
  $('#dd-modal').classList.remove('active');
  saveActiveState();
  renderBoard();
}

// ---------- Daily Double ----------
function showDailyDoubleModal() {
  state.selectedDDTeamId = state.active.teams[0]?.id || null;
  const sel = $('#dd-team-select');
  sel.innerHTML = '';
  state.active.teams.forEach(team => {
    const btn = document.createElement('button');
    btn.textContent = team.name;
    if (team.id === state.selectedDDTeamId) btn.classList.add('selected');
    btn.addEventListener('click', () => {
      state.selectedDDTeamId = team.id;
      sel.querySelectorAll('button').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
    });
    sel.appendChild(btn);
  });

  const team = state.active.teams.find(t => t.id === state.selectedDDTeamId);
  const maxWager = Math.max(team?.score || 0, state.currentClue.value, 1000);
  $('#dd-wager').max = maxWager;
  $('#dd-wager').value = state.currentClue.value;
  $('#dd-modal').classList.add('active');
}

function confirmDailyDouble() {
  const wager = parseInt($('#dd-wager').value, 10);
  if (isNaN(wager) || wager < 0) { alert('Enter a valid wager'); return; }
  state.currentClue.wager = wager;
  state.currentClue.ddTeamId = state.selectedDDTeamId;
  $('#dd-modal').classList.remove('active');
  showClueModal();
}

// ---------- Final Jeopardy ----------
function startFinal() {
  const fj = state.active.gameSnapshot.finalJeopardy;
  if (!fj) { alert('This game has no Final Jeopardy.'); return; }
  state.finalStep = 'wager';
  state.finalWagers = {};
  renderFinal();
  $('#final-modal').classList.add('active');
}

function renderFinal() {
  const fj = state.active.gameSnapshot.finalJeopardy;
  const cont = $('#final-content');
  if (state.finalStep === 'wager') {
    cont.innerHTML = `
      <h2 class="final-title">FINAL JEOPARDY</h2>
      <div class="final-category">CATEGORY: ${escapeHtml(fj.category)}</div>
      <p class="hint">Each team wagers any amount up to their score (or up to $1000 if score is non-positive).</p>
      <div class="final-wagers" id="final-wagers"></div>
      <div class="final-step-buttons">
        <button class="btn btn-primary" id="btn-final-reveal">Reveal Clue →</button>
        <button class="btn btn-secondary" id="btn-final-cancel">Cancel</button>
      </div>
    `;
    const wagersEl = $('#final-wagers');
    state.active.teams.forEach(team => {
      const max = Math.max(team.score, 1000);
      const card = document.createElement('div');
      card.className = 'final-wager-card';
      card.innerHTML = `
        <label>${escapeHtml(team.name)}</label>
        <div class="current-score">Score: ${fmt$(team.score)} (max wager: ${fmt$(max)})</div>
        <input type="number" min="0" max="${max}" value="0" data-team="${team.id}">
      `;
      wagersEl.appendChild(card);
    });
    $('#btn-final-reveal').addEventListener('click', () => {
      wagersEl.querySelectorAll('input').forEach(inp => {
        state.finalWagers[inp.dataset.team] = parseInt(inp.value, 10) || 0;
      });
      state.finalStep = 'clue';
      renderFinal();
    });
    $('#btn-final-cancel').addEventListener('click', closeFinal);
  } else if (state.finalStep === 'clue') {
    cont.innerHTML = `
      <h2 class="final-title">FINAL JEOPARDY</h2>
      <div class="final-category">${escapeHtml(fj.category)}</div>
      <div class="clue-text" id="final-clue">${escapeHtml(fj.clue)}</div>
      <div class="final-step-buttons">
        <button class="btn btn-primary" id="btn-final-answer">Reveal Answer →</button>
      </div>
    `;
    $('#btn-final-answer').addEventListener('click', () => {
      state.finalStep = 'answer';
      renderFinal();
    });
  } else if (state.finalStep === 'answer') {
    cont.innerHTML = `
      <h2 class="final-title">FINAL JEOPARDY</h2>
      <div class="final-category">${escapeHtml(fj.category)}</div>
      <div class="clue-text">${escapeHtml(fj.clue)}</div>
      <div class="clue-answer visible">${escapeHtml(fj.answer)}</div>
      <p class="hint">Mark each team correct or incorrect — wager is added or deducted.</p>
      <div class="final-wagers" id="final-award"></div>
      <div class="final-step-buttons">
        <button class="btn btn-primary" id="btn-final-done">Done</button>
      </div>
    `;
    const awardEl = $('#final-award');
    state.active.teams.forEach(team => {
      const wager = state.finalWagers[team.id] || 0;
      const card = document.createElement('div');
      card.className = 'final-wager-card';
      card.innerHTML = `
        <label>${escapeHtml(team.name)}</label>
        <div class="current-score">Wager: ${fmt$(wager)} • Score: ${fmt$(team.score)}</div>
        <div class="team-button-row">
          <button class="btn-correct" data-team="${team.id}" data-delta="${wager}">+${fmt$(wager)}</button>
          <button class="btn-incorrect" data-team="${team.id}" data-delta="${-wager}">-${fmt$(wager)}</button>
        </div>
      `;
      awardEl.appendChild(card);
    });
    awardEl.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        const team = state.active.teams.find(t => t.id === btn.dataset.team);
        const delta = parseInt(btn.dataset.delta, 10);
        team.score += delta;
        btn.disabled = true;
        btn.parentElement.querySelectorAll('button').forEach(b => b.disabled = true);
        renderScoreboard();
        saveActiveState();
      });
    });
    $('#btn-final-done').addEventListener('click', () => {
      state.active.finalDone = true;
      saveActiveState();
      closeFinal();
    });
  }
}

function closeFinal() {
  state.finalStep = null;
  state.finalWagers = {};
  $('#final-modal').classList.remove('active');
}

function resetGame() {
  if (!confirm('Reset all answered tiles and team scores?')) return;
  initActiveGame(findGame(state.currentGameId));
  renderGame();
}

// ---------- BUILDER ----------
function openBuilder(gameId) {
  state.pendingBuilder = { isEdit: !!gameId, gameId };
  let g;
  if (gameId) {
    g = state.customGames.find(x => x.id === gameId);
    if (!g) { alert('Game not found'); return; }
  } else {
    g = blankGame();
  }
  $('#builder-title').value = g.title || '';
  $('#builder-description').value = g.description || '';
  $('#builder-fj-category').value = g.finalJeopardy?.category || '';
  $('#builder-fj-clue').value = g.finalJeopardy?.clue || '';
  $('#builder-fj-answer').value = g.finalJeopardy?.answer || '';

  const cont = $('#builder-categories');
  cont.innerHTML = '';
  g.categories.forEach((cat, ci) => {
    const sec = document.createElement('div');
    sec.className = 'builder-category';
    sec.innerHTML = `
      <input class="builder-category-name" type="text" value="${escapeAttr(cat.name)}" placeholder="Category ${ci + 1}">
      <div class="builder-clues" data-ci="${ci}"></div>
    `;
    const cluesEl = sec.querySelector('.builder-clues');
    for (let qi = 0; qi < 5; qi++) {
      const c = cat.clues[qi] || { value: VALUES[qi], clue: '', answer: '' };
      const row = document.createElement('div');
      row.className = 'builder-clue-row';
      row.innerHTML = `
        <div class="builder-value">$${VALUES[qi]}</div>
        <input type="text" placeholder="Clue (statement)" class="b-clue" value="${escapeAttr(c.clue || '')}">
        <input type="text" placeholder="Answer (response)" class="b-answer" value="${escapeAttr(c.answer || '')}">
        <button type="button" class="builder-dd-toggle" title="Mark as Daily Double">DD</button>
      `;
      cluesEl.appendChild(row);
    }
    cont.appendChild(sec);
  });
  showScreen('builder');
}

function blankGame() {
  return {
    title: '',
    description: '',
    difficulty: 'Custom',
    categories: Array.from({ length: 6 }, (_, i) => ({
      name: '',
      clues: VALUES.map(v => ({ value: v, clue: '', answer: '' })),
    })),
    finalJeopardy: { category: '', clue: '', answer: '' },
  };
}

function saveBuilder() {
  const title = $('#builder-title').value.trim();
  if (!title) { alert('Title required'); return; }
  const description = $('#builder-description').value.trim();

  const categories = [];
  $$('#builder-categories .builder-category').forEach((sec, ci) => {
    const name = sec.querySelector('.builder-category-name').value.trim() || `Category ${ci + 1}`;
    const clues = [];
    sec.querySelectorAll('.builder-clue-row').forEach((row, qi) => {
      const clue = row.querySelector('.b-clue').value.trim();
      const answer = row.querySelector('.b-answer').value.trim();
      clues.push({ value: VALUES[qi], clue, answer });
    });
    categories.push({ name, clues });
  });

  const fjCat = $('#builder-fj-category').value.trim();
  const fjClue = $('#builder-fj-clue').value.trim();
  const fjAns = $('#builder-fj-answer').value.trim();
  const finalJeopardy = (fjCat || fjClue || fjAns) ? { category: fjCat, clue: fjClue, answer: fjAns } : null;

  const game = {
    id: state.pendingBuilder.isEdit ? state.pendingBuilder.gameId : uid(),
    title, description,
    difficulty: 'Custom',
    categories,
    finalJeopardy,
  };

  if (state.pendingBuilder.isEdit) {
    state.customGames = state.customGames.map(g => g.id === game.id ? game : g);
  } else {
    state.customGames.push(game);
  }
  saveCustomGames();
  state.pendingBuilder = null;
  showScreen('home');
  renderHome();
}

// ---------- Import / Export ----------
function openImportModal() {
  $('#import-json').value = '';
  $('#format-example').textContent = JSON.stringify(formatExample(), null, 2);
  $('#format-example').style.display = 'none';
  $('#import-modal').classList.add('active');
}

function formatExample() {
  return {
    title: "Example Game",
    description: "Optional description",
    difficulty: "Hard",
    categories: [
      {
        name: "CATEGORY ONE",
        clues: [
          { value: 200, clue: "Clue text shown to players", answer: "The correct response" },
          { value: 400, clue: "...", answer: "..." },
          { value: 600, clue: "...", answer: "..." },
          { value: 800, clue: "...", answer: "..." },
          { value: 1000, clue: "...", answer: "..." }
        ]
      }
      // ... 5 more categories (6 total)
    ],
    finalJeopardy: { category: "FINAL CATEGORY", clue: "...", answer: "..." }
  };
}

function importGame() {
  const raw = $('#import-json').value.trim();
  if (!raw) { alert('Paste JSON first'); return; }
  let data;
  try { data = JSON.parse(raw); }
  catch (e) { alert('Invalid JSON: ' + e.message); return; }

  // Validate
  if (!data.title || !Array.isArray(data.categories) || data.categories.length === 0) {
    alert('Game must have title and categories array');
    return;
  }
  // Pad to 6 categories
  while (data.categories.length < 6) {
    data.categories.push({ name: '', clues: VALUES.map(v => ({ value: v, clue: '', answer: '' })) });
  }
  data.categories = data.categories.slice(0, 6);
  data.categories.forEach((c, ci) => {
    if (!Array.isArray(c.clues)) c.clues = [];
    while (c.clues.length < 5) {
      c.clues.push({ value: VALUES[c.clues.length], clue: '', answer: '' });
    }
    c.clues = c.clues.slice(0, 5).map((q, qi) => ({
      value: q.value || VALUES[qi],
      clue: q.clue || '',
      answer: q.answer || ''
    }));
  });
  data.id = data.id || uid();
  if (!data.difficulty) data.difficulty = 'Custom';
  state.customGames.push(data);
  saveCustomGames();
  $('#import-modal').classList.remove('active');
  renderHome();
}

// ---------- Helpers ----------
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}
function escapeAttr(s) { return escapeHtml(s); }
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------- Event wiring ----------
function bindEvents() {
  $('#btn-new-game').addEventListener('click', () => openBuilder(null));
  $('#btn-import').addEventListener('click', openImportModal);
  $('#btn-export-all').addEventListener('click', exportAll);

  $('#btn-home').addEventListener('click', () => { showScreen('home'); renderHome(); });
  $('#btn-final').addEventListener('click', startFinal);
  $('#btn-reset').addEventListener('click', resetGame);
  $('#btn-add-team').addEventListener('click', addTeam);

  // Clue modal — any click in modal reveals (unless on a button or team-name)
  $('#clue-modal').addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    if (e.target.closest('.team-button-group')) return;
    if (!$('#clue-answer').classList.contains('visible')) revealAnswer();
  });
  $('#btn-close-clue').addEventListener('click', (e) => { e.stopPropagation(); closeClue(); });

  // Daily Double
  $('#btn-dd-confirm').addEventListener('click', confirmDailyDouble);
  $('#btn-dd-cancel').addEventListener('click', () => {
    state.currentClue = null;
    $('#dd-modal').classList.remove('active');
  });

  // Builder
  $('#btn-builder-back').addEventListener('click', () => {
    if (confirm('Discard changes?')) { showScreen('home'); renderHome(); }
  });
  $('#btn-builder-save').addEventListener('click', saveBuilder);

  // Daily Double toggle in builder
  document.addEventListener('click', (e) => {
    if (e.target.classList.contains('builder-dd-toggle')) {
      e.target.classList.toggle('active');
    }
  });

  // Import modal
  $('#btn-import-confirm').addEventListener('click', importGame);
  $('#btn-import-cancel').addEventListener('click', () => $('#import-modal').classList.remove('active'));
  $('#show-format').addEventListener('click', (e) => {
    e.preventDefault();
    const ex = $('#format-example');
    ex.style.display = ex.style.display === 'none' ? 'block' : 'none';
  });

  // Help modal
  $('#btn-help-close').addEventListener('click', () => $('#help-modal').classList.remove('active'));

  // Keyboard
  document.addEventListener('keydown', handleKey);
}

function handleKey(e) {
  // Don't intercept while typing in inputs
  const tag = e.target.tagName;
  const isTyping = tag === 'INPUT' || tag === 'TEXTAREA';

  if (e.key === '?' && !isTyping) {
    $('#help-modal').classList.toggle('active');
    return;
  }
  if (e.key === 'Escape') {
    if ($('#clue-modal').classList.contains('active')) closeClue();
    else if ($('#dd-modal').classList.contains('active')) {
      state.currentClue = null;
      $('#dd-modal').classList.remove('active');
    }
    else if ($('#final-modal').classList.contains('active')) closeFinal();
    else if ($('#import-modal').classList.contains('active')) $('#import-modal').classList.remove('active');
    else if ($('#help-modal').classList.contains('active')) $('#help-modal').classList.remove('active');
    return;
  }
  if (isTyping) return;

  if ($('#clue-modal').classList.contains('active') && state.currentClue) {
    if (e.key === ' ') {
      e.preventDefault();
      if (!$('#clue-answer').classList.contains('visible')) revealAnswer();
      return;
    }
    // Award shortcuts
    const num = parseInt(e.key, 10);
    if (!isNaN(num) && num >= 1 && num <= 9) {
      const team = state.active.teams[num - 1];
      if (team && $('#clue-answer').classList.contains('visible')) {
        const value = state.currentClue.isDD ? state.currentClue.wager : state.currentClue.value;
        // Daily Double restriction: only the wagering team can be awarded
        if (state.currentClue.isDD && team.id !== state.currentClue.ddTeamId) return;
        const delta = e.shiftKey ? -value : value;
        awardPoints(team.id, delta, true);
      }
    }
  }
}

// ---------- Boot ----------
function boot() {
  loadCustomGames();
  bindEvents();
  renderHome();
}

document.addEventListener('DOMContentLoaded', boot);
