'use strict';

const SESSION_KEY = 'jeopardy_multiplayer_session_v1';
const NAME_KEY = 'jeopardy_multiplayer_name_v1';

const elements = {
  connectionLabel: document.querySelector('#connection-label'),
  createRoomButton: document.querySelector('#create-room-button'),
  joinRoomButton: document.querySelector('#join-room-button'),
  joinRoomForm: document.querySelector('#join-room-form'),
  joinCode: document.querySelector('#join-code'),
  landingGameFilter: document.querySelector('#landing-game-filter'),
  landingNetworkAddress: document.querySelector('#landing-network-address'),
  joinName: document.querySelector('#join-name'),
  landingScreen: document.querySelector('#landing-screen'),
  leaveRoomButton: document.querySelector('#leave-room-button'),
  roleChip: document.querySelector('#role-chip'),
  roomCodeButton: document.querySelector('#room-code-button'),
  roomConnectionPill: document.querySelector('#room-connection-pill'),
  roomContent: document.querySelector('#room-content'),
  roomHeader: document.querySelector('.room-header'),
  roomScreen: document.querySelector('#room-screen'),
  publicGameCount: document.querySelector('#public-game-count'),
  publicGameList: document.querySelector('#public-game-list'),
  toastRegion: document.querySelector('#toast-region'),
};

const socket = io({ autoConnect: false });
let roomState = null;
let connected = false;
let resuming = false;
let mutationPending = false;
let shouldResumeOnConnect = true;
let networkUrls = [window.location.origin];
let publicGameCatalog = [];
let gameFilter = '';
let landingGameFilter = '';
let preferredGameId = '';
let activeDialogKey = '';
let hostGameListScroll = 0;
let hostPlayerName = localStorage.getItem(NAME_KEY) || '';
const drafts = {
  dailyPlayerId: '',
  dailyWager: '',
  finalWager: '',
  finalResponse: '',
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]));
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function formatMoney(value) {
  const number = Number(value) || 0;
  return `${number < 0 ? '-' : ''}$${Math.abs(number).toLocaleString()}`;
}

function savedSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY));
  } catch {
    return null;
  }
}

function saveSession(session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

function showToast(message, tone = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${tone}`;
  if (tone === 'error') toast.setAttribute('role', 'alert');
  toast.textContent = message;
  elements.toastRegion.appendChild(toast);
  window.setTimeout(() => {
    toast.classList.add('toast-out');
    window.setTimeout(() => toast.remove(), 220);
  }, 3500);
}

function setConnectionState(isConnected) {
  connected = isConnected;
  elements.connectionLabel.textContent = isConnected
    ? 'Game server connected'
    : 'Connection lost — trying to reconnect…';
  elements.createRoomButton.disabled = !isConnected || resuming;
  elements.joinRoomButton.disabled = !isConnected || resuming;
  document.querySelectorAll('.public-game-row').forEach((row) => {
    row.disabled = !isConnected || resuming;
  });
  elements.roomConnectionPill.classList.toggle('offline', !isConnected);
  elements.roomConnectionPill.innerHTML = `<span></span> ${isConnected ? 'Live' : 'Reconnecting'}`;
  document.body.classList.toggle('is-offline', !isConnected);
}

function request(eventName, payload = {}, { allowWhileResuming = false } = {}) {
  if (!connected) return Promise.reject(new Error('The game server is reconnecting.'));
  if (resuming && !allowWhileResuming) return Promise.reject(new Error('Restoring your room session…'));
  return new Promise((resolve, reject) => {
    socket.timeout(8000).emit(eventName, payload, (timeoutError, response) => {
      if (timeoutError) {
        reject(new Error('The server took too long to respond. Try again.'));
        return;
      }
      if (!response?.ok) {
        const error = new Error(response?.error?.message || 'That action did not work.');
        error.code = response?.error?.code;
        reject(error);
        return;
      }
      resolve(response);
    });
  });
}

async function runAction(action, { quiet = false, lock = true } = {}) {
  if (lock && mutationPending) return null;
  if (lock) {
    mutationPending = true;
    document.body.classList.add('mutation-pending');
  }
  try {
    return await action();
  } catch (error) {
    if (!quiet) showToast(error.message, 'error');
    return null;
  } finally {
    if (lock) {
      mutationPending = false;
      document.body.classList.remove('mutation-pending');
    }
  }
}

function resetDrafts() {
  drafts.dailyPlayerId = '';
  drafts.dailyWager = '';
  drafts.finalWager = '';
  drafts.finalResponse = '';
}

async function resumeSavedSession() {
  const session = savedSession();
  if (!session?.code || !session?.token || resuming) return;
  resuming = true;
  setConnectionState(connected);
  try {
    const response = await request('room:resume', session, { allowWhileResuming: true });
    roomState = response.state;
    saveSession(response.session);
    render();
  } catch (error) {
    const definitiveFailure = error.code === 'ROOM_NOT_FOUND' || error.code === 'SESSION_EXPIRED';
    if (definitiveFailure) {
      clearSession();
      roomState = null;
      shouldResumeOnConnect = false;
      render();
    } else {
      showToast(`${error.message} Your saved session was kept.`, 'error');
    }
  } finally {
    resuming = false;
    setConnectionState(connected);
  }
}

function preferredNetworkUrl() {
  const currentHostIsLoopback = ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);
  if (!currentHostIsLoopback) return window.location.origin;
  return networkUrls.find((url) => !url.includes('localhost') && !url.includes('127.0.0.1')) || window.location.origin;
}

function inviteUrl() {
  if (!roomState) return preferredNetworkUrl();
  return `${preferredNetworkUrl()}/?room=${encodeURIComponent(roomState.code)}`;
}

async function copyInvite() {
  const value = inviteUrl();
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  }
  showToast('Player link copied.', 'success');
}

function playerById(playerId) {
  return roomState?.players.find((player) => player.id === playerId) || null;
}

function focusSelectorFor(element) {
  if (!element || !elements.roomContent.contains(element)) return '';
  if (element.id) return `#${CSS.escape(element.id)}`;
  const actionElement = element.closest('[data-action]');
  if (!actionElement) return '';
  const attributes = ['action', 'playerId', 'gameId', 'correct', 'delta', 'categoryIndex', 'clueIndex'];
  return attributes.reduce((selector, attribute) => {
    const value = actionElement.dataset[attribute];
    return value === undefined ? selector : `${selector}[data-${attribute.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}="${CSS.escape(value)}"]`;
  }, '');
}

function dialogKeyForState() {
  if (roomState?.phase !== 'board' || !roomState.currentClue) return '';
  const clue = roomState.currentClue;
  return `${clue.category}:${clue.boardValue}:${clue.phase}`;
}

function manageDialogFocus(previousDialogKey, focusSelector) {
  const overlay = elements.roomContent.querySelector('.clue-overlay');
  const gameShell = elements.roomContent.querySelector('.game-shell');
  const nextDialogKey = dialogKeyForState();
  const hasDialog = Boolean(overlay);
  if (gameShell) gameShell.inert = hasDialog;
  elements.roomHeader.inert = hasDialog;

  if (hasDialog) {
    const preservedTarget = previousDialogKey === nextDialogKey && focusSelector
      ? elements.roomContent.querySelector(focusSelector)
      : null;
    (preservedTarget || overlay.querySelector('.clue-stage'))?.focus();
  } else if (previousDialogKey) {
    elements.roomContent.querySelector('.game-titlebar h2')?.focus();
  } else if (focusSelector) {
    elements.roomContent.querySelector(focusSelector)?.focus();
  }
  activeDialogKey = nextDialogKey;
}

function renderPublicLobby() {
  if (!elements.publicGameList) return;
  const normalizedFilter = landingGameFilter.trim().toLowerCase();
  const filteredGames = publicGameCatalog.filter((game) => {
    const haystack = `${game.title} ${game.description} ${game.categories.join(' ')}`.toLowerCase();
    return haystack.includes(normalizedFilter);
  });

  if (publicGameCatalog.length === 0) {
    elements.publicGameList.innerHTML = '<div class="lobby-loading"><span></span>Loading the game library…</div>';
    elements.publicGameCount.textContent = 'Loading boards…';
  } else if (filteredGames.length === 0) {
    elements.publicGameList.innerHTML = '<div class="public-game-empty">No boards match that search.</div>';
    elements.publicGameCount.textContent = '0 boards match';
  } else {
    elements.publicGameList.innerHTML = filteredGames.map((game) => `
      <button class="public-game-row" type="button" data-public-game-id="${escapeAttr(game.id)}" ${!connected || resuming ? 'disabled' : ''} aria-label="Prepare ${escapeAttr(game.title)}, ${escapeAttr(game.difficulty)} difficulty. Topics: ${escapeAttr(game.categories.join(', '))}. ${escapeAttr(game.description)}">
        <span class="public-game-title"><i>${String(publicGameCatalog.indexOf(game) + 1).padStart(2, '0')}</i><span><strong>${escapeHtml(game.title)}</strong><small>${escapeHtml(game.description)}</small></span></span>
        <span class="public-game-topics">${game.categories.slice(0, 2).map((category) => `<i>${escapeHtml(category)}</i>`).join('')}<i>+4</i></span>
        <span class="public-game-level">${escapeHtml(game.difficulty)}<b aria-hidden="true">›</b></span>
      </button>
    `).join('');
    elements.publicGameCount.textContent = `${filteredGames.length} board${filteredGames.length === 1 ? '' : 's'} match`;
  }

  if (elements.landingNetworkAddress) {
    elements.landingNetworkAddress.textContent = preferredNetworkUrl().replace(/^https?:\/\//, '');
  }
}

function renderRoster({ hostControls = false } = {}) {
  if (!roomState.players.length) {
    return '<div class="empty-roster"><strong>No players yet.</strong><span>Share the room link to fill the scoreboard.</span></div>';
  }
  return `<ul class="roster-list">
    ${roomState.players.map((player) => `
      <li class="roster-item ${player.id === roomState.you?.id ? 'is-you' : ''} ${player.isHost ? 'is-host' : ''}">
        <span class="presence-dot ${player.connected ? '' : 'offline'}" aria-label="${player.connected ? 'Connected' : 'Disconnected'}"></span>
        <span class="roster-name"><span>${escapeHtml(player.name)}</span>${player.isHost ? '<em class="host-badge">Host</em>' : ''}${player.id === roomState.you?.id ? '<em>You</em>' : ''}</span>
        ${roomState.phase !== 'lobby' ? `<strong>${formatMoney(player.score)}</strong>` : ''}
        ${hostControls && !player.isHost ? `<button class="icon-button" type="button" data-action="remove-player" data-player-id="${escapeAttr(player.id)}" aria-label="Remove ${escapeAttr(player.name)}">×</button>` : ''}
      </li>
    `).join('')}
  </ul>`;
}

function renderHostPlayerControl() {
  const you = roomState.you;
  if (you) {
    return `
      <div class="host-player-control is-playing">
        <div class="host-player-copy">
          <span class="host-player-kicker"><i></i> You are in the game</span>
          <strong>${escapeHtml(you.name)}</strong>
          <small>Your buzzer and Final Jeopardy entry will appear alongside the host controls.</small>
        </div>
        <button class="button button-secondary" type="button" data-action="host-leave-player">Stop playing</button>
      </div>`;
  }
  const roomIsFull = roomState.players.length >= 8;
  return `
    <form class="host-player-control host-player-form" id="host-player-form">
      <div class="host-player-copy">
        <span class="host-player-kicker">Want a podium too?</span>
        <strong>Play while you host</strong>
        <small>${roomIsFull ? 'All eight contestant spots are filled.' : 'Join the roster and buzz from this screen.'}</small>
      </div>
      <label for="host-player-name">Your contestant name</label>
      <div class="host-player-fields">
        <input id="host-player-name" name="name" type="text" maxlength="24" value="${escapeAttr(hostPlayerName)}" placeholder="Host name" autocomplete="nickname" required ${roomIsFull ? 'disabled' : ''}>
        <button class="button button-gold" type="submit" ${roomIsFull ? 'disabled' : ''}>Play too</button>
      </div>
    </form>`;
}

function renderHostLobby() {
  const catalog = roomState.gameCatalog || [];
  const preferredGame = catalog.find((game) => game.id === preferredGameId) || null;
  const normalizedFilter = gameFilter.trim().toLowerCase();
  const filteredGames = catalog.filter((game) => {
    const haystack = `${game.title} ${game.description} ${game.categories.join(' ')}`.toLowerCase();
    return haystack.includes(normalizedFilter);
  }).sort((firstGame, secondGame) => {
    if (firstGame.id === preferredGameId) return -1;
    if (secondGame.id === preferredGameId) return 1;
    return catalog.indexOf(firstGame) - catalog.indexOf(secondGame);
  });
  const urls = networkUrls.filter((url, index, all) => all.indexOf(url) === index);

  return `
    <div class="lobby-layout">
      <aside class="lobby-sidebar">
        <section class="roster-card">
          <div class="panel-heading">
            <div><p class="panel-label">Contestants</p><h2>${roomState.players.length} / 8 joined</h2></div>
          </div>
          ${renderHostPlayerControl()}
          ${renderRoster({ hostControls: true })}
        </section>
        <section class="lobby-guide-card">
          <p class="panel-label">Host checklist</p>
          <ul>
            <li class="done"><span>1</span> Room created</li>
            <li class="${roomState.players.length ? 'done' : ''}"><span>2</span> Players connected</li>
            <li class="${preferredGame ? 'done' : ''}"><span>3</span> Choose a board</li>
          </ul>
        </section>
      </aside>

      <section class="game-library">
        <div class="lobby-section-bar">
          <strong>Game library</strong>
          <span>${catalog.length} boards · select one to start</span>
        </div>
        <div class="library-heading">
          <div>
            <p class="panel-label">Tonight's game</p>
            <h2>Choose a board</h2>
            <p>Every board has six categories, one Daily Double, and Final Jeopardy.</p>
          </div>
          <label class="search-field">
            <span class="sr-only">Filter games</span>
            <input id="game-filter" type="search" value="${escapeAttr(gameFilter)}" placeholder="Search titles or topics">
          </label>
        </div>
        <div class="host-game-table">
          <div class="host-game-head" aria-hidden="true"><span>Board</span><span>Featured topics</span><span>Level</span><span></span></div>
          <div class="host-game-list">
            ${filteredGames.map((game) => `
              <button class="host-game-row ${game.id === preferredGameId ? 'is-preferred' : ''}" type="button" data-action="select-game" data-game-id="${escapeAttr(game.id)}" aria-pressed="${game.id === preferredGameId}" aria-label="Select ${escapeAttr(game.title)}, ${escapeAttr(game.difficulty)} difficulty. Topics: ${escapeAttr(game.categories.join(', '))}. ${escapeAttr(game.description)}">
                <span class="host-game-index">${String(catalog.indexOf(game) + 1).padStart(2, '0')}</span>
                <span class="host-game-copy">
                  <strong>${escapeHtml(game.title)}</strong>
                  <small>${escapeHtml(game.description)}</small>
                </span>
                <span class="host-game-topics">${game.categories.slice(0, 2).map((category) => `<span>${escapeHtml(category)}</span>`).join('')}</span>
                <span class="difficulty-tag">${escapeHtml(game.difficulty)}</span>
                <span class="row-select-mark" aria-hidden="true">${game.id === preferredGameId ? '✓' : '›'}</span>
              </button>
            `).join('') || '<div class="no-results">No games match that search.</div>'}
          </div>
        </div>
      </section>

      <aside class="lobby-action-rail">
        <section class="broadcast-card">
          <p class="panel-label">Invite players</p>
          <div class="giant-code">${escapeHtml(roomState.code)}</div>
          <p class="invite-caption">Friends enter this code or open your invite link.</p>
          <button class="button button-gold" type="button" data-action="copy-invite">Copy player link</button>
          <div class="network-addresses">
            <span>Same-Wi-Fi address</span>
            ${urls.map((url) => `<code>${escapeHtml(url.replace(/^https?:\/\//, ''))}</code>`).join('')}
          </div>
        </section>
        <section class="selected-board-card ${preferredGame ? 'has-selection' : ''}">
          <p class="panel-label">Selected board</p>
          <strong>${escapeHtml(preferredGame?.title || 'Choose from the library')}</strong>
          <small>${preferredGame ? escapeHtml(preferredGame.categories.join(' · ')) : 'Pick a row in the center panel when you are ready.'}</small>
          <button class="button button-primary" type="button" data-action="start-game" data-game-id="${escapeAttr(preferredGame?.id || '')}" ${preferredGame ? '' : 'disabled'}>Start selected board</button>
        </section>
        <section class="lobby-status-card">
          <span class="presence-dot"></span>
          <div><strong>Room is live</strong><small>${preferredGame ? `${escapeHtml(preferredGame.title)} is ready when your players are.` : 'Waiting for you to select a board.'}</small></div>
        </section>
      </aside>
    </div>`;
}

function renderPlayerLobby() {
  return `
    <div class="waiting-stage">
      <div class="waiting-pulse" aria-hidden="true"><span></span><span></span><span></span></div>
      <p class="panel-label">You're in room ${escapeHtml(roomState.code)}</p>
      <h2>Waiting for the host</h2>
      <p>Keep this screen open. The board will appear as soon as the host chooses a game.</p>
      <div class="player-ticket">
        <span>Playing as</span>
        <strong>${escapeHtml(roomState.you?.name || 'Player')}</strong>
      </div>
      <section class="waiting-roster">
        <p class="panel-label">At the podiums</p>
        ${renderRoster()}
      </section>
    </div>`;
}

function renderScoreboard() {
  const ranked = [...roomState.players].sort((first, second) => second.score - first.score);
  return `
    <section class="score-rail" aria-label="Scoreboard">
      <div class="score-heading">
        <p class="panel-label">Scoreboard</p>
        <span>${roomState.players.length} player${roomState.players.length === 1 ? '' : 's'}</span>
      </div>
      <div class="score-list">
        ${ranked.map((player, index) => `
          <article class="score-card ${player.id === roomState.you?.id ? 'is-you' : ''}">
            <div class="place-number">${index + 1}</div>
            <div class="score-copy">
              <span class="score-name"><i class="presence-dot ${player.connected ? '' : 'offline'}"></i><b>${escapeHtml(player.name)}</b>${player.isHost ? '<em>Host</em>' : ''}</span>
              <strong class="${player.score < 0 ? 'negative' : ''}">${formatMoney(player.score)}</strong>
            </div>
            ${roomState.role === 'host' ? `
              <div class="score-adjusters">
                <button type="button" data-action="adjust-score" data-player-id="${escapeAttr(player.id)}" data-delta="-200" aria-label="Deduct $200 from ${escapeAttr(player.name)}">−</button>
                <button type="button" data-action="adjust-score" data-player-id="${escapeAttr(player.id)}" data-delta="200" aria-label="Add $200 to ${escapeAttr(player.name)}">+</button>
              </div>` : ''}
          </article>
        `).join('') || '<div class="score-empty">Waiting for players…</div>'}
      </div>
    </section>`;
}

function renderBoardGrid() {
  const game = roomState.game;
  return `
    <div class="board-wrap">
      <div class="board-grid" style="--board-columns: ${game.categories.length}">
        ${game.categories.map((category) => `<div class="category-tile">${escapeHtml(category.name)}</div>`).join('')}
        ${[0, 1, 2, 3, 4].flatMap((clueIndex) => game.categories.map((category, categoryIndex) => {
          const clue = category.clues[clueIndex];
          const unavailable = clue.answered || Boolean(roomState.currentClue) || roomState.role !== 'host';
          return `<button
            class="clue-tile ${clue.answered ? 'answered' : ''}"
            type="button"
            data-action="open-clue"
            data-category-index="${categoryIndex}"
            data-clue-index="${clueIndex}"
            ${unavailable ? 'disabled' : ''}
            aria-label="${escapeAttr(category.name)}, ${formatMoney(clue.value)}${clue.answered ? ', answered' : ''}"
          ><span>${clue.answered ? '' : formatMoney(clue.value)}</span></button>`;
        })).join('')}
      </div>
    </div>`;
}

function renderHostBoardControls() {
  const hasFinalist = roomState.players.some((player) => player.score > 0);
  return `
    <div class="host-toolbar">
      <button class="button button-secondary" type="button" data-action="return-lobby">Change game</button>
      <button class="button button-secondary" type="button" data-action="reset-game">Reset board</button>
      <button class="button button-gold" type="button" data-action="start-final" ${!hasFinalist || roomState.currentClue ? 'disabled' : ''} title="A player needs a positive score">Final Jeopardy</button>
    </div>`;
}

function renderBuzzQueue(clue) {
  if (clue.dailyDouble) {
    const player = playerById(clue.dailyPlayerId);
    return player ? `<div class="daily-player-callout"><span>Daily Double belongs to</span><strong>${escapeHtml(player.name)}</strong></div>` : '';
  }
  if (clue.buzzes.length === 0) {
    return `<div class="buzz-queue empty"><span class="queue-light"></span>${clue.buzzOpen ? 'Buzzers are open' : 'Buzzers are locked'}</div>`;
  }
  return `<ol class="buzz-queue">
    ${clue.buzzes.map((buzz) => `<li class="${buzz.position === 1 ? 'first-buzz' : ''}"><span>${buzz.position}</span>${escapeHtml(buzz.name)}</li>`).join('')}
  </ol>`;
}

function renderDailyWager(clue) {
  const availablePlayers = roomState.players;
  if (!availablePlayers.length) {
    return `
      <div class="clue-overlay" role="dialog" aria-modal="true" aria-label="Daily Double">
        <div class="clue-stage daily-stage" tabindex="-1">
          <p class="daily-banner">Daily Double</p>
          <h2>A player needs to join before this clue can be wagered.</h2>
          <button class="button button-secondary" type="button" data-action="skip-clue">Close clue</button>
        </div>
      </div>`;
  }
  if (!availablePlayers.some((player) => player.id === drafts.dailyPlayerId)) {
    drafts.dailyPlayerId = availablePlayers[0].id;
    drafts.dailyWager = String(clue.boardValue);
  }
  const selectedPlayer = playerById(drafts.dailyPlayerId);
  const maxWager = Math.max(selectedPlayer?.score || 0, 1000);
  return `
    <div class="clue-overlay" role="dialog" aria-modal="true" aria-labelledby="daily-title">
      <form class="clue-stage daily-stage" id="daily-wager-form" tabindex="-1">
        <p class="daily-banner">Daily Double</p>
        <h2 id="daily-title">Choose the player and wager</h2>
        <p class="clue-category">${escapeHtml(clue.category)} · ${formatMoney(clue.boardValue)} clue</p>
        <div class="daily-form-grid">
          <label><span>Player</span>
            <select id="daily-player" name="playerId">
              ${availablePlayers.map((player) => `<option value="${escapeAttr(player.id)}" ${player.id === drafts.dailyPlayerId ? 'selected' : ''}>${escapeHtml(player.name)} — ${formatMoney(player.score)}</option>`).join('')}
            </select>
          </label>
          <label><span>Wager (max ${formatMoney(maxWager)})</span>
            <input id="daily-wager" name="wager" type="number" min="0" max="${maxWager}" step="1" value="${escapeAttr(drafts.dailyWager)}" required>
          </label>
        </div>
        <div class="dialog-actions">
          <button class="button button-primary button-large" type="submit">Show clue</button>
          <button class="button button-secondary" type="button" data-action="skip-clue">Cancel clue</button>
        </div>
      </form>
    </div>`;
}

function hostBuzzerPresentation(clue) {
  const you = roomState.you;
  if (!you) return null;
  const yourBuzz = clue.buzzes.find((buzz) => buzz.playerId === you.id);
  const ineligible = clue.ineligiblePlayerIds.includes(you.id);
  const canBuzz = connected && !clue.dailyDouble && clue.buzzOpen && !clue.revealed && !yourBuzz && !ineligible;

  if (ineligible) {
    return {
      canBuzz,
      yourBuzz,
      tone: 'is-locked',
      label: 'LOCKED OUT',
      detail: clue.hostKeyOutcome === 'forfeited' ? 'You opened the key and sat out this clue.' : 'You already answered this clue.',
    };
  }
  if (yourBuzz) {
    if (yourBuzz.position === 1) {
      return {
        canBuzz,
        yourBuzz,
        tone: 'is-first',
        label: 'FIRST IN',
        detail: clue.revealed
          ? 'Response shown — judge yourself below.'
          : clue.hostKeyOutcome === 'committed'
            ? 'Your response is locked — judge yourself below.'
            : 'Answer aloud, then reveal or open the key to judge.',
      };
    }
    return { canBuzz, yourBuzz, tone: 'is-queued', label: `BUZZED #${yourBuzz.position}`, detail: `You are number ${yourBuzz.position} in the queue.` };
  }
  if (clue.revealed) {
    return { canBuzz, yourBuzz, tone: 'is-locked', label: 'REVEALED', detail: 'The correct response is now visible.' };
  }
  if (!clue.buzzOpen) {
    return { canBuzz, yourBuzz, tone: 'is-locked', label: 'WAIT', detail: 'Buzzing is currently locked.' };
  }
  return { canBuzz, yourBuzz, tone: 'is-open', label: 'BUZZ', detail: 'Buzzers are open — press when ready.' };
}

function renderHostPlayStation(clue) {
  const you = roomState.you;
  if (!you) return '';
  const dailyPlayer = playerById(clue.dailyPlayerId);

  if (clue.dailyDouble) {
    const isYours = dailyPlayer?.id === you.id;
    const responseCommitted = clue.revealed || clue.hostKeyOutcome === 'committed';
    return `
      <aside class="host-play-station daily-self-station ${isYours ? 'is-yours' : ''}" aria-label="Your contestant status">
        <div class="host-play-heading"><span>Your podium</span><strong>${escapeHtml(you.name)}</strong></div>
        <div class="host-daily-state">
          <span>${isYours ? 'Daily Double' : 'Buzzer locked'}</span>
          <strong>${isYours ? 'This clue is yours' : `${escapeHtml(dailyPlayer?.name || 'A player')} is answering`}</strong>
          <p aria-live="polite">${isYours ? (responseCommitted ? 'Your response is locked — score yourself below.' : 'Answer aloud, then reveal or open the key to judge.') : 'Daily Doubles do not use the buzzer.'}</p>
        </div>
      </aside>`;
  }

  const buzzer = hostBuzzerPresentation(clue);
  return `
    <aside class="host-play-station ${buzzer.tone}" aria-label="Your contestant buzzer">
      <div class="host-play-heading"><span>Your buzzer</span><strong>${escapeHtml(you.name)}</strong></div>
      <button class="buzzer host-buzzer ${buzzer.yourBuzz ? 'buzzed' : ''}" type="button" data-action="buzz" ${buzzer.canBuzz ? '' : 'disabled'} aria-label="${buzzer.canBuzz ? `Buzz in as ${escapeAttr(you.name)}` : escapeAttr(buzzer.label)}">
        <span class="buzzer-face">${escapeHtml(buzzer.label)}</span>
        <small>${buzzer.canBuzz ? 'Press or tap' : 'Contestant status'}</small>
      </button>
      <p class="host-buzzer-status" aria-live="polite">${escapeHtml(buzzer.detail)}</p>
    </aside>`;
}

function renderHostAnswerDisclosure(clue) {
  if (clue.revealed || (!clue.hostKeyAvailable && !clue.hostKeyOpened)) return '';
  const you = roomState.you;
  const isFirst = Boolean(you && (clue.dailyDouble ? clue.dailyPlayerId === you.id : clue.buzzes[0]?.playerId === you.id));
  const selfWasRuledOut = Boolean(you && clue.ineligiblePlayerIds.includes(you.id));

  if (clue.hostKeyOpened) {
    const status = clue.hostKeyOutcome === 'committed'
      ? (selfWasRuledOut ? 'Your response was scored' : 'Your response is locked')
      : clue.hostKeyOutcome === 'forfeited'
        ? 'You are sitting out this clue'
        : 'Quizmaster key opened';
    return `
      <div class="host-key-disclosure is-opened">
        <div>
          <span>${status}</span>
          <small>${clue.hostKeyOutcome === 'committed' ? (selfWasRuledOut ? 'Other contestants can continue buzzing.' : 'Judge your committed response below.') : clue.hostKeyOutcome === 'forfeited' ? 'Other contestants can continue buzzing.' : 'Judge contestants with the controls below.'}</small>
        </div>
        <div class="host-answer-key" role="status"><span>Host answer key</span><strong>${escapeHtml(clue.expectedAnswer)}</strong></div>
      </div>`;
  }

  const actionCopy = you
    ? (isFirst ? 'Lock my response & view key' : clue.dailyDouble ? 'View host key' : 'Sit out this clue & view key')
    : 'Open host key';
  const consequenceCopy = you
    ? (isFirst
      ? 'Private host screen only — opening commits your spoken response before you judge it.'
      : clue.dailyDouble
        ? `Private host screen only — this clue belongs to ${escapeHtml(playerById(clue.dailyPlayerId)?.name || 'another contestant')}.`
        : 'Private host screen only — opening removes you from this clue so the remote queue stays fair.')
    : 'Private host screen only — keep the key away from contestants.';
  return `
      <div class="host-key-disclosure">
        <div>
          <span>${you ? 'Playing-host fairness lock' : 'Quizmaster-only aid'}</span>
          <small id="host-key-consequence">${consequenceCopy}</small>
        </div>
        <button class="button ${you ? 'button-gold' : 'button-secondary'}" type="button" data-action="open-host-key" aria-describedby="host-key-consequence">${actionCopy}</button>
      </div>`;
}

function renderHostClue(clue) {
  if (clue.phase === 'daily-wager') return renderDailyWager(clue);
  const scoringPlayers = clue.dailyDouble
    ? roomState.players.filter((player) => player.id === clue.dailyPlayerId)
    : [...roomState.players].sort((first, second) => {
      const firstPosition = clue.buzzes.findIndex((buzz) => buzz.playerId === first.id);
      const secondPosition = clue.buzzes.findIndex((buzz) => buzz.playerId === second.id);
      return (firstPosition === -1 ? 99 : firstPosition) - (secondPosition === -1 ? 99 : secondPosition);
    });
  const playStation = renderHostPlayStation(clue);
  const committedHostAttempt = clue.hostKeyOutcome === 'committed'
    && clue.buzzes[0]?.playerId === roomState.you?.id;
  return `
    <div class="clue-overlay" role="dialog" aria-modal="true" aria-labelledby="clue-question">
      <div class="clue-stage host-clue-stage" tabindex="-1">
        <div class="clue-topline">
          <span>${clue.dailyDouble ? 'Daily Double · ' : ''}${escapeHtml(clue.category)}</span>
          <strong>${formatMoney(clue.value)}</strong>
        </div>
        <h2 class="clue-question" id="clue-question">${escapeHtml(clue.question)}</h2>
        ${renderHostAnswerDisclosure(clue)}
        ${clue.revealed ? `<div class="revealed-answer"><span>Correct response</span><strong>${escapeHtml(clue.answer)}</strong></div>` : ''}
        <div class="host-clue-workspace ${playStation ? 'has-self-play' : ''}">
          ${playStation}
          <div class="host-moderation-column">
            ${renderBuzzQueue(clue)}
            <div class="judge-grid">
              ${scoringPlayers.map((player) => {
                const ineligible = clue.ineligiblePlayerIds.includes(player.id);
                const isActiveResponder = clue.dailyDouble
                  ? player.id === clue.dailyPlayerId
                  : clue.buzzes[0]?.playerId === player.id;
                const isSelf = player.id === roomState.you?.id;
                const selfResponseCommitted = clue.revealed || clue.hostKeyOutcome === 'committed';
                const scoringDisabled = ineligible || !isActiveResponder || (isSelf && !selfResponseCommitted);
                return `<article class="judge-card ${ineligible ? 'ruled-out' : ''} ${isSelf ? 'is-self' : ''}">
                  <span>${escapeHtml(player.name)}${isSelf ? ' <em>You</em>' : ''}</span>
                  <strong>${formatMoney(player.score)}</strong>
                  <div>
                    <button class="judge-correct" type="button" data-action="score-clue" data-player-id="${escapeAttr(player.id)}" data-correct="true" ${scoringDisabled ? 'disabled' : ''}>Correct</button>
                    <button class="judge-wrong" type="button" data-action="score-clue" data-player-id="${escapeAttr(player.id)}" data-correct="false" ${scoringDisabled ? 'disabled' : ''}>Incorrect</button>
                  </div>
                </article>`;
              }).join('') || '<div class="no-players-clue">No players are in the room yet.</div>'}
            </div>
          </div>
        </div>
        <div class="dialog-actions host-clue-actions">
          ${!clue.revealed ? `<button class="button button-gold" type="button" data-action="reveal-answer">Reveal response</button>` : ''}
          ${!clue.dailyDouble && !clue.revealed ? `<button class="button button-secondary" type="button" data-action="reset-buzzers" ${committedHostAttempt ? 'disabled title="Score your committed response before resetting buzzers" aria-label="Reset buzzers unavailable: score your committed response first"' : ''}>Reset buzzers</button>` : ''}
          <button class="button button-secondary" type="button" data-action="skip-clue">${clue.revealed ? 'Close clue' : 'No answer / close'}</button>
        </div>
      </div>
    </div>`;
}

function renderPlayerClue(clue) {
  if (clue.phase === 'daily-wager') {
    return `
      <div class="clue-overlay player-overlay" role="dialog" aria-modal="true" aria-labelledby="player-daily-title">
        <div class="clue-stage player-clue-stage daily-stage" tabindex="-1">
          <p class="daily-banner">Daily Double</p>
          <h2 id="player-daily-title">The host is setting the wager.</h2>
          <p class="waiting-copy">Hold tight — the clue is coming next.</p>
        </div>
      </div>`;
  }
  const you = roomState.you;
  const yourBuzz = clue.buzzes.find((buzz) => buzz.playerId === you?.id);
  const ineligible = clue.ineligiblePlayerIds.includes(you?.id);
  const dailyPlayer = playerById(clue.dailyPlayerId);
  const canBuzz = connected && roomState.hostConnected && !clue.dailyDouble && clue.buzzOpen && !clue.revealed && !yourBuzz && !ineligible;
  let buzzerCopy = 'BUZZ';
  if (yourBuzz) buzzerCopy = yourBuzz.position === 1 ? 'FIRST IN' : `BUZZED #${yourBuzz.position}`;
  if (ineligible) buzzerCopy = 'LOCKED OUT';
  if (!clue.buzzOpen && !yourBuzz) buzzerCopy = 'WAIT';
  if (!roomState.hostConnected) buzzerCopy = 'HOST OFFLINE';

  return `
    <div class="clue-overlay player-overlay" role="dialog" aria-modal="true" aria-labelledby="player-clue-question">
      <div class="clue-stage player-clue-stage" tabindex="-1">
        <div class="clue-topline">
          <span>${clue.dailyDouble ? 'Daily Double · ' : ''}${escapeHtml(clue.category)}</span>
          <strong>${formatMoney(clue.value)}</strong>
        </div>
        <h2 class="clue-question" id="player-clue-question">${escapeHtml(clue.question)}</h2>
        ${clue.revealed ? `<div class="revealed-answer"><span>Correct response</span><strong>${escapeHtml(clue.answer)}</strong></div>` : ''}
        ${clue.dailyDouble ? `
          <div class="daily-player-callout ${dailyPlayer?.id === you?.id ? 'is-you' : ''}">
            <span>${dailyPlayer?.id === you?.id ? 'This one is yours' : 'Answering this clue'}</span>
            <strong>${escapeHtml(dailyPlayer?.name || 'Player')}</strong>
          </div>` : `
          <button class="buzzer ${yourBuzz ? 'buzzed' : ''}" type="button" data-action="buzz" ${canBuzz ? '' : 'disabled'}>
            <span class="buzzer-face">${buzzerCopy}</span>
            <small>${canBuzz ? 'Tap now' : yourBuzz ? 'The host has your buzz' : 'Watch the host screen'}</small>
          </button>`}
        ${clue.dailyDouble ? '' : renderBuzzQueue(clue)}
      </div>
    </div>`;
}

function renderBoard() {
  return `
    <div class="game-shell">
      <div class="game-main">
        <header class="game-titlebar">
          <div><p class="panel-label">Now playing</p><h2 tabindex="-1">${escapeHtml(roomState.game.title)}</h2></div>
          ${roomState.role === 'host' ? renderHostBoardControls() : `<div class="player-score-chip"><span>Your score</span><strong>${formatMoney(roomState.you?.score)}</strong></div>`}
        </header>
        ${renderBoardGrid()}
      </div>
      ${renderScoreboard()}
    </div>
    ${roomState.currentClue ? (roomState.role === 'host' ? renderHostClue(roomState.currentClue) : renderPlayerClue(roomState.currentClue)) : ''}`;
}

function submissionStatus(submission, type) {
  const complete = type === 'wager' ? submission.wagerSubmitted : submission.responseSubmitted;
  const isYou = submission.playerId === roomState.you?.id;
  return `<li class="${isYou ? 'is-you' : ''}"><span class="presence-dot ${complete ? '' : 'waiting'}"></span><strong>${escapeHtml(submission.name)}${isYou ? ' <i>You</i>' : ''}</strong><em>${complete ? 'Ready' : 'Waiting'}</em></li>`;
}

function renderHostFinalEntry(final) {
  const you = roomState.you;
  if (!you || final.phase === 'complete') return '';

  const heading = `
    <div class="host-final-entry-heading">
      <span>Your contestant entry</span>
      <strong>${escapeHtml(you.name)}</strong>
    </div>`;

  if (!final.eligible) {
    return `
      <section class="host-final-entry is-ineligible" aria-label="Your Final Jeopardy status">
        ${heading}
        <div class="host-final-entry-state"><strong>Watching this Final</strong><p>A positive score is required to wager.</p></div>
      </section>`;
  }

  if (final.phase === 'wager') {
    const maxWager = final.yourMaxWager ?? you.score ?? 0;
    return `
      <section class="host-final-entry" aria-label="Your Final Jeopardy wager">
        ${heading}
        ${final.yourWagerSubmitted
          ? `<div class="host-final-entry-state is-locked"><span>Wager locked</span><strong>${formatMoney(final.yourWager)}</strong></div>`
          : `<form id="final-wager-form" class="final-entry-form host-final-form">
              <label><span>Your wager · max ${formatMoney(maxWager)}</span><input id="final-wager" type="number" name="wager" min="0" max="${maxWager}" step="1" value="${escapeAttr(drafts.finalWager)}" required></label>
              <button class="button button-gold" type="submit">Lock my wager</button>
            </form>`}
      </section>`;
  }

  if (final.phase === 'clue') {
    return `
      <section class="host-final-entry" aria-label="Your Final Jeopardy response">
        ${heading}
        ${final.yourResponseSubmitted
          ? '<div class="host-final-entry-state is-locked"><strong>Response locked</strong><p>Your entry stays hidden until the answer reveal.</p></div>'
          : `<form id="final-response-form" class="final-entry-form host-final-form">
              <label><span>Your response</span><input id="final-response" type="text" name="response" maxlength="200" value="${escapeAttr(drafts.finalResponse)}" placeholder="What is…?" required autocomplete="off"></label>
              <button class="button button-gold" type="submit">Lock my response</button>
            </form>`}
      </section>`;
  }

  const submission = final.submissions.find((item) => item.playerId === you.id);
  return `
    <section class="host-final-entry" aria-label="Your Final Jeopardy result">
      ${heading}
      <div class="host-final-entry-state ${submission?.scored ? 'is-locked' : ''}">
        <strong>${submission?.scored ? (final.yourResult ? 'Marked correct' : 'Marked incorrect') : 'Judge your response below'}</strong>
        <p>${submission?.scored ? 'Your score has been updated.' : 'Your response appears with the other contestants.'}</p>
      </div>
    </section>`;
}

function renderFinalHost(final) {
  if (final.phase === 'wager') {
    return `
      <div class="final-panel">
        <p class="final-wordmark">FINAL JEOPARDY</p>
        <span class="final-category">${escapeHtml(final.category)}</span>
        <h2>Players are placing their wagers.</h2>
        ${renderHostFinalEntry(final)}
        <ul class="submission-list">${final.submissions.map((submission) => submissionStatus(submission, 'wager')).join('')}</ul>
        <button class="button button-gold button-large" type="button" data-action="advance-final">Lock wagers & reveal clue</button>
      </div>`;
  }
  if (final.phase === 'clue') {
    return `
      <div class="final-panel final-clue-panel">
        <p class="final-wordmark">FINAL JEOPARDY</p>
        <span class="final-category">${escapeHtml(final.category)}</span>
        <h2>${escapeHtml(final.clue)}</h2>
        ${renderHostFinalEntry(final)}
        <ul class="submission-list">${final.submissions.map((submission) => submissionStatus(submission, 'response')).join('')}</ul>
        <button class="button button-gold button-large" type="button" data-action="advance-final">Close responses & reveal answer</button>
      </div>`;
  }
  if (final.phase === 'answer') {
    return `
      <div class="final-panel final-judge-panel">
        <p class="final-wordmark">FINAL JEOPARDY</p>
        <span class="final-category">${escapeHtml(final.category)}</span>
        <h2>${escapeHtml(final.clue)}</h2>
        <div class="final-answer"><span>Correct response</span><strong>${escapeHtml(final.answer)}</strong></div>
        ${renderHostFinalEntry(final)}
        <div class="final-response-grid">
          ${final.submissions.map((submission) => `
            <article class="final-response-card ${submission.scored ? 'scored' : ''}">
              <div><span>${escapeHtml(submission.name)}</span><strong>${formatMoney(submission.wager)}</strong></div>
              <blockquote>${escapeHtml(submission.response)}</blockquote>
              ${submission.scored
                ? `<p class="result-stamp ${submission.correct ? 'correct' : 'incorrect'}">${submission.correct ? 'Correct' : 'Incorrect'}</p>`
                : `<div class="response-actions">
                    <button class="judge-correct" type="button" data-action="score-final" data-player-id="${escapeAttr(submission.playerId)}" data-correct="true">Correct</button>
                    <button class="judge-wrong" type="button" data-action="score-final" data-player-id="${escapeAttr(submission.playerId)}" data-correct="false">Incorrect</button>
                  </div>`}
            </article>
          `).join('')}
        </div>
        <button class="button button-gold button-large" type="button" data-action="finish-final" ${final.submissions.every((submission) => submission.scored) ? '' : 'disabled'}>Show final standings</button>
      </div>`;
  }
  return renderFinalStandings();
}

function renderFinalStandings() {
  const ranked = [...roomState.players].sort((first, second) => second.score - first.score);
  return `
    <div class="final-panel standings-panel">
      <p class="final-wordmark">FINAL SCORES</p>
      <div class="podium-list">
        ${ranked.map((player, index) => `
          <article class="podium-row place-${index + 1}">
            <span>${index + 1}</span><strong>${escapeHtml(player.name)}</strong><em>${formatMoney(player.score)}</em>
          </article>
        `).join('')}
      </div>
      ${roomState.role === 'host' ? '<button class="button button-gold button-large" type="button" data-action="return-lobby">Choose another game</button>' : '<p class="waiting-copy">The host can start another game from here.</p>'}
    </div>`;
}

function renderFinalPlayer(final) {
  const you = roomState.you;
  const maxWager = final.yourMaxWager ?? you?.score ?? 0;
  if (!final.eligible && final.phase !== 'complete') {
    return `
      <div class="final-panel player-final-panel">
        <p class="final-wordmark">FINAL JEOPARDY</p>
        <span class="final-category">${escapeHtml(final.category)}</span>
        <div class="submission-confirmed">
          <span>Watching this round</span>
          <strong>Score required</strong>
          <p>Players need a positive score to wager in Final Jeopardy. You will still see the clue and final standings.</p>
        </div>
        ${final.clue ? `<h2>${escapeHtml(final.clue)}</h2>` : ''}
        ${final.answer ? `<div class="final-answer"><span>Correct response</span><strong>${escapeHtml(final.answer)}</strong></div>` : ''}
      </div>`;
  }
  if (final.phase === 'wager') {
    return `
      <div class="final-panel player-final-panel">
        <p class="final-wordmark">FINAL JEOPARDY</p>
        <span class="final-category">${escapeHtml(final.category)}</span>
        ${final.yourWagerSubmitted
          ? `<div class="submission-confirmed"><span>Wager locked</span><strong>${formatMoney(final.yourWager)}</strong><p>Waiting for the host to reveal the clue.</p></div>`
          : `<form id="final-wager-form" class="final-entry-form">
              <label><span>Your wager · max ${formatMoney(maxWager)}</span><input id="final-wager" type="number" name="wager" min="0" max="${maxWager}" step="1" value="${escapeAttr(drafts.finalWager)}" required autofocus></label>
              <button class="button button-gold button-large" type="submit">Lock wager</button>
            </form>`}
      </div>`;
  }
  if (final.phase === 'clue') {
    return `
      <div class="final-panel player-final-panel final-clue-panel">
        <p class="final-wordmark">FINAL JEOPARDY</p>
        <span class="final-category">${escapeHtml(final.category)}</span>
        <h2>${escapeHtml(final.clue)}</h2>
        ${final.yourResponseSubmitted
          ? '<div class="submission-confirmed"><span>Response locked</span><p>Waiting for the reveal.</p></div>'
          : `<form id="final-response-form" class="final-entry-form">
              <label><span>Your response</span><input id="final-response" type="text" name="response" maxlength="200" value="${escapeAttr(drafts.finalResponse)}" placeholder="What is…?" required autocomplete="off" autofocus></label>
              <button class="button button-gold button-large" type="submit">Lock response</button>
            </form>`}
      </div>`;
  }
  if (final.phase === 'answer') {
    const submission = final.submissions.find((item) => item.playerId === you?.id);
    return `
      <div class="final-panel player-final-panel">
        <p class="final-wordmark">FINAL JEOPARDY</p>
        <span class="final-category">${escapeHtml(final.category)}</span>
        <h2>${escapeHtml(final.clue)}</h2>
        <div class="final-answer"><span>Correct response</span><strong>${escapeHtml(final.answer)}</strong></div>
        <div class="submission-confirmed">
          <span>${submission?.scored ? 'Result' : 'The host is judging responses'}</span>
          <strong>${submission?.scored ? (final.yourResult ? 'Correct' : 'Incorrect') : 'Stand by'}</strong>
        </div>
      </div>`;
  }
  return renderFinalStandings();
}

function renderFinal() {
  return `
    <div class="final-stage">
      ${roomState.role === 'host' ? renderFinalHost(roomState.final) : renderFinalPlayer(roomState.final)}
      <aside class="final-score-strip">${renderScoreboard()}</aside>
    </div>`;
}

function renderRoom() {
  const previousDialogKey = activeDialogKey;
  const focusSelector = focusSelectorFor(document.activeElement);
  const hostNameSelection = document.activeElement?.id === 'host-player-name'
    ? { start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd }
    : null;
  elements.roomCodeButton.textContent = roomState.code;
  elements.roleChip.textContent = roomState.role === 'host' ? (roomState.you ? 'HOST + PLAYER' : 'HOST') : 'PLAYER';
  elements.roleChip.classList.toggle('player-role', roomState.role === 'player');
  elements.roleChip.classList.toggle('dual-role', roomState.role === 'host' && Boolean(roomState.you));
  elements.roomHeader.classList.toggle('dual-role-header', roomState.role === 'host' && Boolean(roomState.you));
  elements.leaveRoomButton.textContent = roomState.role === 'host' ? 'End room' : 'Leave';

  const hostOfflineNotice = roomState.role === 'player' && !roomState.hostConnected
    ? '<div class="host-offline-banner" role="status"><strong>Host disconnected.</strong> Buzzing is paused while their screen reconnects.</div>'
    : '';

  if (roomState.phase === 'lobby') {
    elements.roomContent.innerHTML = hostOfflineNotice + (roomState.role === 'host' ? renderHostLobby() : renderPlayerLobby());
  } else if (roomState.phase === 'board') {
    elements.roomContent.innerHTML = hostOfflineNotice + renderBoard();
  } else if (roomState.phase === 'final') {
    elements.roomContent.innerHTML = hostOfflineNotice + renderFinal();
  }
  const hostGameList = elements.roomContent.querySelector('.host-game-list');
  if (hostGameList) hostGameList.scrollTop = hostGameListScroll;
  manageDialogFocus(previousDialogKey, focusSelector);
  if (hostNameSelection) {
    const hostNameInput = elements.roomContent.querySelector('#host-player-name');
    const valueLength = hostNameInput?.value.length || 0;
    hostNameInput?.setSelectionRange(
      Math.min(hostNameSelection.start ?? valueLength, valueLength),
      Math.min(hostNameSelection.end ?? valueLength, valueLength),
    );
  }
}

function render() {
  const inRoom = Boolean(roomState);
  elements.landingScreen.classList.toggle('hidden', inRoom);
  elements.roomScreen.classList.toggle('hidden', !inRoom);
  if (inRoom) renderRoom();
  else {
    elements.roomHeader.inert = false;
    activeDialogKey = '';
    renderPublicLobby();
  }
  setConnectionState(connected);
}

async function createRoom(gameId = null) {
  const response = await runAction(() => request('room:create'));
  if (!response) return;
  roomState = response.state;
  saveSession(response.session);
  shouldResumeOnConnect = true;
  resetDrafts();
  preferredGameId = gameId || '';
  if (gameId) {
    gameFilter = '';
    hostGameListScroll = 0;
  }
  render();
  if (!gameId) {
    showToast('Room created. Share the code when you are ready.', 'success');
  }
}

async function joinRoom(form) {
  const code = form.code.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  const name = form.name.value.trim();
  const response = await runAction(() => request('room:join', { code, name }));
  if (!response) return;
  roomState = response.state;
  saveSession(response.session);
  shouldResumeOnConnect = true;
  localStorage.setItem(NAME_KEY, name);
  resetDrafts();
  render();
  showToast(`Joined room ${response.session.code}.`, 'success');
}

async function leaveRoom() {
  const isHost = roomState?.role === 'host';
  if (isHost && !window.confirm('End this room for everyone?')) return;
  try {
    await request(isHost ? 'room:close' : 'room:leave');
  } catch (error) {
    showToast(error.message, 'error');
    return;
  }
  clearSession();
  shouldResumeOnConnect = false;
  roomState = null;
  resetDrafts();
  render();
}

elements.createRoomButton.addEventListener('click', () => void createRoom());
elements.publicGameList.addEventListener('click', (event) => {
  const row = event.target.closest('[data-public-game-id]');
  if (!row || row.disabled) return;
  void createRoom(row.dataset.publicGameId);
});
elements.landingGameFilter.addEventListener('input', () => {
  landingGameFilter = elements.landingGameFilter.value;
  renderPublicLobby();
  elements.landingGameFilter.focus();
  elements.landingGameFilter.setSelectionRange(landingGameFilter.length, landingGameFilter.length);
});
elements.joinRoomForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void joinRoom(event.currentTarget.elements);
});
elements.joinCode.addEventListener('input', () => {
  elements.joinCode.value = elements.joinCode.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
});
elements.roomCodeButton.addEventListener('click', () => void copyInvite());
elements.leaveRoomButton.addEventListener('click', () => void leaveRoom());

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Tab') return;
  const overlay = elements.roomContent.querySelector('.clue-overlay');
  if (!overlay) return;
  const focusable = [...overlay.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])')]
    .filter((element) => !element.hidden && element.getClientRects().length > 0);
  if (focusable.length === 0) {
    event.preventDefault();
    overlay.querySelector('.clue-stage')?.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const activeIndex = focusable.indexOf(document.activeElement);
  if (event.shiftKey && activeIndex <= 0) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (activeIndex === -1 || activeIndex === focusable.length - 1)) {
    event.preventDefault();
    first.focus();
  }
});

elements.roomContent.addEventListener('input', (event) => {
  if (event.target.id === 'game-filter') {
    gameFilter = event.target.value;
    hostGameListScroll = 0;
    renderRoom();
    const input = document.querySelector('#game-filter');
    input?.focus();
    input?.setSelectionRange(gameFilter.length, gameFilter.length);
  } else if (event.target.id === 'daily-wager') {
    drafts.dailyWager = event.target.value;
  } else if (event.target.id === 'host-player-name') {
    hostPlayerName = event.target.value;
  } else if (event.target.id === 'final-wager') {
    drafts.finalWager = event.target.value;
  } else if (event.target.id === 'final-response') {
    drafts.finalResponse = event.target.value;
  }
});

elements.roomContent.addEventListener('scroll', (event) => {
  if (event.target.classList?.contains('host-game-list')) hostGameListScroll = event.target.scrollTop;
}, true);

elements.roomContent.addEventListener('change', (event) => {
  if (event.target.id === 'daily-player') {
    drafts.dailyPlayerId = event.target.value;
    const selected = playerById(drafts.dailyPlayerId);
    const max = Math.max(selected?.score || 0, 1000);
    const wager = Number(drafts.dailyWager);
    if (!Number.isFinite(wager) || wager > max) drafts.dailyWager = String(max);
    renderRoom();
  }
});

elements.roomContent.addEventListener('submit', (event) => {
  event.preventDefault();
  if (event.target.id === 'daily-wager-form') {
    void runAction(() => request('host:set-daily-double', {
      playerId: event.target.elements.playerId.value,
      wager: Number(event.target.elements.wager.value),
    }));
  } else if (event.target.id === 'host-player-form') {
    const name = event.target.elements.name.value.trim();
    void runAction(async () => {
      await request('host:join-as-player', { name });
      hostPlayerName = name;
      localStorage.setItem(NAME_KEY, name);
    });
  } else if (event.target.id === 'final-wager-form') {
    void runAction(async () => {
      await request('player:final-wager', { wager: Number(event.target.elements.wager.value) });
      drafts.finalWager = '';
      renderRoom();
    });
  } else if (event.target.id === 'final-response-form') {
    void runAction(async () => {
      await request('player:final-response', { response: event.target.elements.response.value });
      drafts.finalResponse = '';
      renderRoom();
    });
  }
});

elements.roomContent.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target || target.disabled) return;
  const action = target.dataset.action;
  const playerId = target.dataset.playerId;

  if (action === 'select-game') {
    preferredGameId = target.dataset.gameId;
    hostGameListScroll = 0;
    renderRoom();
    return;
  }

  const actions = {
    'copy-invite': () => copyInvite(),
    'start-game': () => request('host:start-game', { gameId: target.dataset.gameId }),
    'host-leave-player': () => request('host:leave-as-player'),
    'open-host-key': () => request('host:open-answer-key'),
    'remove-player': async () => {
      const player = playerById(playerId);
      if (player && window.confirm(`Remove ${player.name} from the room?`)) {
        await request('host:remove-player', { playerId });
      }
    },
    'open-clue': () => request('host:open-clue', {
      categoryIndex: Number(target.dataset.categoryIndex),
      clueIndex: Number(target.dataset.clueIndex),
    }),
    'reveal-answer': () => request('host:reveal-answer'),
    'reset-buzzers': () => request('host:reset-buzzers'),
    'skip-clue': () => request('host:skip-clue'),
    'score-clue': () => request('host:score-clue', { playerId, correct: target.dataset.correct === 'true' }),
    'adjust-score': () => request('host:adjust-score', { playerId, delta: Number(target.dataset.delta) }),
    'buzz': () => request('player:buzz'),
    'reset-game': async () => {
      if (window.confirm('Reset the board and every score?')) await request('host:reset-game');
    },
    'return-lobby': async () => {
      let returned = false;
      if (roomState.phase === 'final' && roomState.final?.phase === 'complete') {
        await request('host:return-lobby');
        returned = true;
      } else if (window.confirm('Return to the game library? Current scores and board progress will be cleared.')) {
        await request('host:return-lobby');
        returned = true;
      }
      if (returned) {
        preferredGameId = '';
        gameFilter = '';
        hostGameListScroll = 0;
        renderRoom();
      }
    },
    'start-final': () => request('host:start-final'),
    'advance-final': () => request('host:advance-final', { phase: roomState.final?.phase }),
    'score-final': () => request('host:score-final', { playerId, correct: target.dataset.correct === 'true' }),
    'finish-final': () => request('host:finish-final'),
  };

  if (actions[action]) void runAction(actions[action]);
});

socket.on('connect', () => {
  setConnectionState(true);
  if (shouldResumeOnConnect && savedSession()) void resumeSavedSession();
  else render();
});

socket.on('disconnect', () => {
  setConnectionState(false);
});

socket.on('room:state', (state) => {
  const activeInputId = document.activeElement?.id;
  const finalSubmissionAccepted = (activeInputId === 'final-wager' && state.final?.yourWagerSubmitted)
    || (activeInputId === 'final-response' && state.final?.yourResponseSubmitted);
  const preserveActiveDraft = ['daily-wager', 'final-wager', 'final-response'].includes(activeInputId)
    && !finalSubmissionAccepted
    && roomState?.phase === state.phase
    && roomState?.final?.phase === state.final?.phase
    && roomState?.currentClue?.phase === state.currentClue?.phase;
  const priorClue = roomState?.currentClue;
  const priorPhase = roomState?.phase;
  const priorGameId = roomState?.game?.id;
  roomState = state;
  if (!state.currentClue || state.currentClue.category !== priorClue?.category || state.currentClue.boardValue !== priorClue?.boardValue) {
    drafts.dailyPlayerId = '';
    drafts.dailyWager = '';
  }
  if (priorGameId !== state.game?.id || (priorPhase !== 'final' && state.phase === 'final') || (priorPhase === 'final' && state.phase !== 'final')) {
    drafts.finalWager = '';
    drafts.finalResponse = '';
  }
  if (!preserveActiveDraft) render();
});

socket.on('room:error', ({ message }) => showToast(message, 'error'));
socket.on('room:closed', ({ message }) => {
  clearSession();
  shouldResumeOnConnect = false;
  roomState = null;
  resetDrafts();
  render();
  showToast(message, 'info');
});
socket.on('room:removed', ({ message }) => {
  clearSession();
  shouldResumeOnConnect = false;
  roomState = null;
  resetDrafts();
  render();
  showToast(message, 'error');
});

socket.on('room:replaced', ({ message }) => {
  roomState = null;
  resetDrafts();
  render();
  showToast(`${message} Reload this page if you want to take control here again.`, 'info');
});

async function boot() {
  const roomCode = new URLSearchParams(window.location.search).get('room');
  const inviteCode = roomCode?.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5) || '';
  if (inviteCode) elements.joinCode.value = inviteCode;
  elements.joinName.value = localStorage.getItem(NAME_KEY) || '';
  const session = savedSession();
  if (inviteCode && session?.code && inviteCode !== session.code) {
    shouldResumeOnConnect = false;
    showToast(`Invite ${inviteCode} opened. Your saved ${session.code} session was left untouched.`, 'info');
  }
  const [networkResult, gamesResult] = await Promise.allSettled([
    fetch('/api/network').then((response) => response.json()),
    fetch('/api/games').then((response) => response.json()),
  ]);
  if (networkResult.status === 'fulfilled' && Array.isArray(networkResult.value.urls) && networkResult.value.urls.length) {
    networkUrls = networkResult.value.urls;
  }
  if (gamesResult.status === 'fulfilled' && Array.isArray(gamesResult.value)) {
    publicGameCatalog = gamesResult.value;
  }
  render();
  socket.connect();
}

void boot();
