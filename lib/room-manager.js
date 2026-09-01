'use strict';

const crypto = require('node:crypto');

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_PLAYERS = 8;

class RoomError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RoomError';
    this.code = code;
  }
}

function cleanRoomCode(value) {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
}

function cleanName(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, 24);
}

function cleanResponse(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, 200);
}

function randomToken() {
  return crypto.randomBytes(18).toString('base64url');
}

function tokensMatch(first, second) {
  const firstBuffer = Buffer.from(String(first ?? ''));
  const secondBuffer = Buffer.from(String(second ?? ''));
  return firstBuffer.length === secondBuffer.length && crypto.timingSafeEqual(firstBuffer, secondBuffer);
}

function clueKey(categoryIndex, clueIndex) {
  return `${categoryIndex}:${clueIndex}`;
}

class RoomManager {
  constructor({ games, now = () => Date.now() } = {}) {
    if (!Array.isArray(games) || games.length === 0) throw new Error('RoomManager requires at least one game');
    this.games = games;
    this.gamesById = new Map(games.map((game) => [game.id, game]));
    this.rooms = new Map();
    this.sessions = new Map();
    this.now = now;
  }

  createRoom(socketId) {
    this.#assertFreshSocket(socketId);
    const code = this.#newRoomCode();
    const hostToken = randomToken();
    const timestamp = this.now();
    const room = {
      code,
      createdAt: timestamp,
      updatedAt: timestamp,
      host: { socketId, token: hostToken, connected: true },
      players: [],
      phase: 'lobby',
      gameId: null,
      answered: new Set(),
      currentClue: null,
      final: null,
    };
    this.rooms.set(code, room);
    this.sessions.set(socketId, { code, role: 'host' });
    return { code, token: hostToken, role: 'host' };
  }

  joinRoom(socketId, { code, name }) {
    this.#assertFreshSocket(socketId);
    const room = this.#requireRoom(code);
    if (room.phase === 'final') {
      throw new RoomError('GAME_IN_FINAL', 'This room is in Final Jeopardy and is not accepting new players.');
    }
    const playerName = cleanName(name);
    if (!playerName) throw new RoomError('INVALID_NAME', 'Enter a name to join the room.');
    if (room.players.length >= MAX_PLAYERS) throw new RoomError('ROOM_FULL', 'This room already has eight players.');
    if (room.players.some((player) => player.name.toLowerCase() === playerName.toLowerCase())) {
      throw new RoomError('NAME_TAKEN', 'That name is already in this room.');
    }

    const player = {
      id: `p_${crypto.randomBytes(6).toString('hex')}`,
      token: randomToken(),
      socketId,
      name: playerName,
      score: 0,
      connected: true,
      joinedAt: this.now(),
    };
    room.players.push(player);
    this.sessions.set(socketId, { code: room.code, role: 'player', playerId: player.id });
    this.#touch(room);
    return { code: room.code, token: player.token, role: 'player', playerId: player.id };
  }

  resumeRoom(socketId, { code, token }) {
    this.#assertFreshSocket(socketId);
    const room = this.#requireRoom(code);
    const suppliedToken = String(token ?? '');

    if (suppliedToken && tokensMatch(suppliedToken, room.host.token)) {
      const replacedSocketId = room.host.socketId;
      if (replacedSocketId) this.sessions.delete(replacedSocketId);
      room.host.socketId = socketId;
      room.host.connected = true;
      this.sessions.set(socketId, { code: room.code, role: 'host' });
      this.#touch(room);
      return { code: room.code, token: room.host.token, role: 'host', replacedSocketId };
    }

    const player = room.players.find((candidate) => suppliedToken && tokensMatch(candidate.token, suppliedToken));
    if (!player) throw new RoomError('SESSION_EXPIRED', 'That saved room session is no longer available.');
    const replacedSocketId = player.socketId;
    if (replacedSocketId) this.sessions.delete(replacedSocketId);
    player.socketId = socketId;
    player.connected = true;
    this.sessions.set(socketId, { code: room.code, role: 'player', playerId: player.id });
    this.#touch(room);
    return { code: room.code, token: player.token, role: 'player', playerId: player.id, replacedSocketId };
  }

  disconnect(socketId) {
    const session = this.sessions.get(socketId);
    if (!session) return null;
    const room = this.rooms.get(session.code);
    this.sessions.delete(socketId);
    if (!room) return session.code;

    if (session.role === 'host' && room.host.socketId === socketId) {
      room.host.socketId = null;
      room.host.connected = false;
    } else if (session.role === 'player') {
      const player = room.players.find((candidate) => candidate.id === session.playerId);
      if (player && player.socketId === socketId) {
        player.socketId = null;
        player.connected = false;
      }
    }
    this.#touch(room);
    return room.code;
  }

  leaveRoom(socketId) {
    const { room, session } = this.#roomForSocket(socketId);
    if (session.role === 'host') {
      return this.closeRoom(socketId);
    }
    this.#removePlayerFromRoom(room, session.playerId);
    this.sessions.delete(socketId);
    this.#touch(room);
    return { code: room.code, closed: false };
  }

  closeRoom(socketId) {
    const { room } = this.#requireHost(socketId);
    for (const [candidateSocketId, session] of this.sessions) {
      if (session.code === room.code) this.sessions.delete(candidateSocketId);
    }
    this.rooms.delete(room.code);
    return { code: room.code, closed: true };
  }

  startGame(socketId, gameId) {
    const { room } = this.#requireHost(socketId);
    const game = this.gamesById.get(gameId);
    if (!game) throw new RoomError('GAME_NOT_FOUND', 'Choose a game from the library.');
    room.gameId = game.id;
    room.phase = 'board';
    room.answered = new Set();
    room.currentClue = null;
    room.final = null;
    room.players.forEach((player) => { player.score = 0; });
    this.#touch(room);
    return room.code;
  }

  openClue(socketId, { categoryIndex, clueIndex }) {
    const { room, game } = this.#requireBoardHost(socketId);
    const category = game.categories[Number(categoryIndex)];
    const clue = category?.clues?.[Number(clueIndex)];
    if (!clue) throw new RoomError('CLUE_NOT_FOUND', 'That clue does not exist.');
    const key = clueKey(Number(categoryIndex), Number(clueIndex));
    if (room.answered.has(key)) throw new RoomError('CLUE_ALREADY_USED', 'That clue has already been played.');
    if (room.currentClue) throw new RoomError('CLUE_ACTIVE', 'Finish the current clue first.');

    room.currentClue = {
      key,
      categoryIndex: Number(categoryIndex),
      clueIndex: Number(clueIndex),
      value: clue.value,
      dailyDouble: clue.dailyDouble === true,
      phase: clue.dailyDouble === true ? 'daily-wager' : 'question',
      revealed: false,
      buzzOpen: clue.dailyDouble !== true,
      buzzes: [],
      ineligiblePlayerIds: new Set(),
      dailyPlayerId: null,
      wager: null,
    };
    this.#touch(room);
    return room.code;
  }

  setDailyDouble(socketId, { playerId, wager }) {
    const { room } = this.#requireBoardHost(socketId);
    const current = room.currentClue;
    if (!current?.dailyDouble || current.phase !== 'daily-wager') {
      throw new RoomError('NOT_DAILY_DOUBLE', 'There is no Daily Double waiting for a wager.');
    }
    const player = room.players.find((candidate) => candidate.id === playerId);
    if (!player) throw new RoomError('PLAYER_NOT_FOUND', 'Choose a player for the Daily Double.');
    const parsedWager = Number(wager);
    const maxWager = Math.max(player.score, 1000);
    if (!Number.isInteger(parsedWager) || parsedWager < 0 || parsedWager > maxWager) {
      throw new RoomError('INVALID_WAGER', `Enter a whole-dollar wager from $0 to $${maxWager}.`);
    }
    current.dailyPlayerId = player.id;
    current.wager = parsedWager;
    current.phase = 'question';
    current.buzzOpen = false;
    this.#touch(room);
    return room.code;
  }

  buzz(socketId) {
    const { room, player } = this.#requirePlayer(socketId);
    if (!room.host.connected) {
      throw new RoomError('HOST_OFFLINE', 'Buzzing is paused while the host reconnects.');
    }
    const current = room.currentClue;
    if (room.phase !== 'board' || !current || current.phase !== 'question' || current.revealed) {
      throw new RoomError('BUZZ_CLOSED', 'Buzzing is not open right now.');
    }
    if (!current.buzzOpen || current.dailyDouble) throw new RoomError('BUZZ_CLOSED', 'Buzzing is not open for this clue.');
    if (current.ineligiblePlayerIds.has(player.id)) throw new RoomError('ALREADY_RULED', 'You have already answered this clue.');
    if (current.buzzes.some((buzz) => buzz.playerId === player.id)) {
      throw new RoomError('ALREADY_BUZZED', 'Your buzz is already in.');
    }
    current.buzzes.push({ playerId: player.id, at: this.now() });
    this.#touch(room);
    return room.code;
  }

  resetBuzzers(socketId) {
    const { room } = this.#requireBoardHost(socketId);
    if (!room.currentClue || room.currentClue.revealed) throw new RoomError('NO_ACTIVE_CLUE', 'There is no active buzzer to reset.');
    room.currentClue.buzzes = [];
    this.#touch(room);
    return room.code;
  }

  revealAnswer(socketId) {
    const { room } = this.#requireBoardHost(socketId);
    if (!room.currentClue || room.currentClue.phase !== 'question') {
      throw new RoomError('NO_ACTIVE_CLUE', 'There is no active clue to reveal.');
    }
    room.currentClue.revealed = true;
    room.currentClue.buzzOpen = false;
    this.#touch(room);
    return room.code;
  }

  scoreClue(socketId, { playerId, correct }) {
    const { room } = this.#requireBoardHost(socketId);
    const current = room.currentClue;
    if (!current || current.phase !== 'question') throw new RoomError('NO_ACTIVE_CLUE', 'There is no active clue to score.');
    const player = room.players.find((candidate) => candidate.id === playerId);
    if (!player) throw new RoomError('PLAYER_NOT_FOUND', 'That player is no longer in the room.');
    if (current.dailyDouble && current.dailyPlayerId !== player.id) {
      throw new RoomError('WRONG_DAILY_PLAYER', 'Only the selected Daily Double player can be scored.');
    }
    if (!current.dailyDouble && current.ineligiblePlayerIds.has(player.id)) {
      throw new RoomError('ALREADY_RULED', `${player.name} has already answered this clue.`);
    }
    if (!current.dailyDouble && current.buzzes[0]?.playerId !== player.id) {
      throw new RoomError('NOT_FIRST_BUZZ', 'Score the first player in the buzz queue.');
    }
    const isCorrect = correct === true;
    const points = current.dailyDouble ? current.wager : current.value;
    if (!Number.isInteger(points)) throw new RoomError('INVALID_WAGER', 'Set the Daily Double wager before scoring.');

    const answerWasRevealed = current.revealed;
    player.score += isCorrect ? points : -points;

    if (isCorrect || current.dailyDouble || answerWasRevealed) {
      room.answered.add(current.key);
      room.currentClue = null;
    } else {
      current.ineligiblePlayerIds.add(player.id);
      current.buzzes = current.buzzes.filter((buzz) => buzz.playerId !== player.id);
      current.buzzOpen = true;
    }
    this.#touch(room);
    return room.code;
  }

  skipClue(socketId) {
    const { room } = this.#requireBoardHost(socketId);
    if (!room.currentClue) throw new RoomError('NO_ACTIVE_CLUE', 'There is no active clue to close.');
    room.answered.add(room.currentClue.key);
    room.currentClue = null;
    this.#touch(room);
    return room.code;
  }

  adjustScore(socketId, { playerId, delta }) {
    const { room } = this.#requireHost(socketId);
    const player = room.players.find((candidate) => candidate.id === playerId);
    const parsedDelta = Number(delta);
    if (!player) throw new RoomError('PLAYER_NOT_FOUND', 'That player is no longer in the room.');
    if (!Number.isInteger(parsedDelta) || Math.abs(parsedDelta) > 100000) {
      throw new RoomError('INVALID_SCORE', 'Score adjustments must be whole dollars.');
    }
    player.score += parsedDelta;
    this.#touch(room);
    return room.code;
  }

  removePlayer(socketId, playerId) {
    const { room } = this.#requireHost(socketId);
    const player = room.players.find((candidate) => candidate.id === playerId);
    if (!player) throw new RoomError('PLAYER_NOT_FOUND', 'That player is no longer in the room.');
    if (player.socketId) this.sessions.delete(player.socketId);
    this.#removePlayerFromRoom(room, playerId);
    this.#touch(room);
    return { code: room.code, removedSocketId: player.socketId };
  }

  resetGame(socketId) {
    const { room } = this.#requireHost(socketId);
    if (!room.gameId) throw new RoomError('NO_GAME', 'Start a game before resetting it.');
    room.phase = 'board';
    room.answered = new Set();
    room.currentClue = null;
    room.final = null;
    room.players.forEach((player) => { player.score = 0; });
    this.#touch(room);
    return room.code;
  }

  returnToLobby(socketId) {
    const { room } = this.#requireHost(socketId);
    room.phase = 'lobby';
    room.gameId = null;
    room.answered = new Set();
    room.currentClue = null;
    room.final = null;
    room.players.forEach((player) => { player.score = 0; });
    this.#touch(room);
    return room.code;
  }

  startFinal(socketId) {
    const { room, game } = this.#requireBoardHost(socketId);
    if (room.currentClue) throw new RoomError('CLUE_ACTIVE', 'Finish the current clue before Final Jeopardy.');
    const eligiblePlayers = room.players.filter((player) => player.score > 0);
    if (eligiblePlayers.length === 0) {
      throw new RoomError('NO_ELIGIBLE_PLAYERS', 'At least one player needs a positive score for Final Jeopardy.');
    }
    if (!game.finalJeopardy) throw new RoomError('NO_FINAL', 'This game does not include Final Jeopardy.');
    room.phase = 'final';
    room.final = {
      phase: 'wager',
      entries: Object.fromEntries(eligiblePlayers.map((player) => [player.id, {
        wager: null,
        wagerSubmitted: false,
        response: '',
        responseSubmitted: false,
        correct: null,
        scored: false,
      }])),
    };
    this.#touch(room);
    return room.code;
  }

  submitFinalWager(socketId, wager) {
    const { room, player } = this.#requirePlayer(socketId);
    if (room.phase !== 'final' || room.final?.phase !== 'wager') {
      throw new RoomError('WAGER_CLOSED', 'Final Jeopardy wagers are closed.');
    }
    const entry = room.final.entries[player.id];
    if (!entry) throw new RoomError('NOT_ELIGIBLE', 'A positive score is required to play Final Jeopardy.');
    if (entry.wagerSubmitted) throw new RoomError('ALREADY_SUBMITTED', 'Your Final Jeopardy wager is already locked.');
    const parsedWager = Number(wager);
    const maxWager = player.score;
    if (!Number.isInteger(parsedWager) || parsedWager < 0 || parsedWager > maxWager) {
      throw new RoomError('INVALID_WAGER', `Enter a whole-dollar wager from $0 to $${maxWager}.`);
    }
    entry.wager = parsedWager;
    entry.wagerSubmitted = true;
    this.#touch(room);
    return room.code;
  }

  submitFinalResponse(socketId, response) {
    const { room, player } = this.#requirePlayer(socketId);
    if (room.phase !== 'final' || room.final?.phase !== 'clue') {
      throw new RoomError('RESPONSE_CLOSED', 'Final Jeopardy responses are closed.');
    }
    const entry = room.final.entries[player.id];
    if (!entry) throw new RoomError('NOT_ELIGIBLE', 'A positive score is required to play Final Jeopardy.');
    if (entry.responseSubmitted) throw new RoomError('ALREADY_SUBMITTED', 'Your Final Jeopardy response is already locked.');
    const cleaned = cleanResponse(response);
    if (!cleaned) throw new RoomError('INVALID_RESPONSE', 'Enter a response before submitting.');
    entry.response = cleaned;
    entry.responseSubmitted = true;
    this.#touch(room);
    return room.code;
  }

  advanceFinal(socketId, expectedPhase) {
    const { room } = this.#requireHost(socketId);
    if (room.phase !== 'final' || !room.final) throw new RoomError('NO_FINAL', 'Final Jeopardy is not active.');
    if (expectedPhase && room.final.phase !== expectedPhase) {
      throw new RoomError('STALE_ACTION', 'Final Jeopardy has already moved to the next step.');
    }
    if (room.final.phase === 'wager') {
      Object.values(room.final.entries).forEach((entry) => {
        if (!entry.wagerSubmitted) entry.wager = 0;
      });
      room.final.phase = 'clue';
    } else if (room.final.phase === 'clue') {
      room.final.phase = 'answer';
    } else {
      throw new RoomError('FINAL_LOCKED', 'Score each response before finishing Final Jeopardy.');
    }
    this.#touch(room);
    return room.code;
  }

  scoreFinal(socketId, { playerId, correct }) {
    const { room } = this.#requireHost(socketId);
    if (room.phase !== 'final' || room.final?.phase !== 'answer') {
      throw new RoomError('FINAL_NOT_READY', 'Reveal the Final Jeopardy answer before scoring.');
    }
    const player = room.players.find((candidate) => candidate.id === playerId);
    const entry = room.final.entries[playerId];
    if (!player || !entry) throw new RoomError('PLAYER_NOT_FOUND', 'That player is no longer in the room.');
    if (entry.scored) throw new RoomError('ALREADY_SCORED', `${player.name} has already been scored.`);
    const isCorrect = correct === true;
    player.score += isCorrect ? entry.wager : -entry.wager;
    entry.correct = isCorrect;
    entry.scored = true;
    this.#touch(room);
    return room.code;
  }

  finishFinal(socketId) {
    const { room } = this.#requireHost(socketId);
    if (room.phase !== 'final' || room.final?.phase !== 'answer') {
      throw new RoomError('FINAL_NOT_READY', 'Final Jeopardy is not ready to finish.');
    }
    const unscored = room.players.filter((player) => room.final.entries[player.id] && !room.final.entries[player.id].scored);
    if (unscored.length > 0) throw new RoomError('UNSCORED_PLAYERS', 'Score every player before showing the final standings.');
    room.final.phase = 'complete';
    this.#touch(room);
    return room.code;
  }

  stateFor(socketId, gameCatalog) {
    const { room, session } = this.#roomForSocket(socketId);
    const game = room.gameId ? this.gamesById.get(room.gameId) : null;
    const state = {
      code: room.code,
      role: session.role,
      phase: room.phase,
      hostConnected: room.host.connected,
      players: room.players.map((player) => ({
        id: player.id,
        name: player.name,
        score: player.score,
        connected: player.connected,
      })),
      game: game ? this.#serializeBoard(room, game) : null,
      currentClue: game && room.currentClue ? this.#serializeCurrentClue(room, game, session) : null,
      final: game && room.final ? this.#serializeFinal(room, game, session) : null,
    };
    if (session.role === 'host') state.gameCatalog = gameCatalog;
    if (session.role === 'player') {
      state.you = state.players.find((player) => player.id === session.playerId) || null;
    }
    return state;
  }

  roomCodeForSocket(socketId) {
    return this.sessions.get(socketId)?.code || null;
  }

  cleanup(maxIdleMs = 12 * 60 * 60 * 1000) {
    const cutoff = this.now() - maxIdleMs;
    const removedCodes = [];
    for (const room of this.rooms.values()) {
      const someoneConnected = room.host.connected || room.players.some((player) => player.connected);
      if (!someoneConnected && room.updatedAt < cutoff) {
        for (const [socketId, session] of this.sessions) {
          if (session.code === room.code) this.sessions.delete(socketId);
        }
        this.rooms.delete(room.code);
        removedCodes.push(room.code);
      }
    }
    return removedCodes;
  }

  #serializeBoard(room, game) {
    return {
      id: game.id,
      title: game.title,
      description: game.description,
      difficulty: game.difficulty,
      categories: game.categories.map((category, categoryIndex) => ({
        name: category.name,
        clues: category.clues.map((clue, clueIndex) => ({
          value: clue.value,
          answered: room.answered.has(clueKey(categoryIndex, clueIndex)),
        })),
      })),
      finalCategory: game.finalJeopardy?.category || null,
    };
  }

  #serializeCurrentClue(room, game, session) {
    const current = room.currentClue;
    const category = game.categories[current.categoryIndex];
    const clue = category.clues[current.clueIndex];
    const buzzes = current.buzzes.map((buzz, index) => {
      const player = room.players.find((candidate) => candidate.id === buzz.playerId);
      return { playerId: buzz.playerId, name: player?.name || 'Player', position: index + 1 };
    });
    const payload = {
      category: category.name,
      value: current.dailyDouble ? current.wager : current.value,
      boardValue: current.value,
      question: current.phase === 'daily-wager' ? null : clue.clue,
      answer: current.revealed ? clue.answer : null,
      dailyDouble: current.dailyDouble,
      phase: current.phase,
      revealed: current.revealed,
      buzzOpen: current.buzzOpen,
      buzzes,
      ineligiblePlayerIds: [...current.ineligiblePlayerIds],
      dailyPlayerId: current.dailyPlayerId,
    };
    if (session.role === 'host') payload.expectedAnswer = clue.answer;
    return payload;
  }

  #serializeFinal(room, game, session) {
    const final = room.final;
    const payload = {
      phase: final.phase,
      category: game.finalJeopardy.category,
      clue: ['clue', 'answer', 'complete'].includes(final.phase) ? game.finalJeopardy.clue : null,
      answer: ['answer', 'complete'].includes(final.phase) ? game.finalJeopardy.answer : null,
      submissions: room.players.filter((player) => final.entries[player.id]).map((player) => ({
        playerId: player.id,
        name: player.name,
        wagerSubmitted: final.entries[player.id]?.wagerSubmitted || false,
        responseSubmitted: final.entries[player.id]?.responseSubmitted || false,
        scored: final.entries[player.id]?.scored || false,
        ...(session.role === 'host' && ['answer', 'complete'].includes(final.phase) ? {
          wager: final.entries[player.id]?.wager ?? 0,
          response: final.entries[player.id]?.response || '(No response)',
          correct: final.entries[player.id]?.correct ?? null,
        } : {}),
      })),
    };
    if (session.role === 'player') {
      const entry = final.entries[session.playerId];
      payload.eligible = Boolean(entry);
      payload.yourWager = entry?.wager ?? null;
      payload.yourWagerSubmitted = entry?.wagerSubmitted || false;
      payload.yourResponseSubmitted = entry?.responseSubmitted || false;
      payload.yourResult = entry?.correct ?? null;
    }
    return payload;
  }

  #newRoomCode() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      let code = '';
      for (let index = 0; index < 5; index += 1) {
        code += ROOM_ALPHABET[crypto.randomInt(ROOM_ALPHABET.length)];
      }
      if (!this.rooms.has(code)) return code;
    }
    throw new RoomError('ROOM_LIMIT', 'Could not create a unique room. Try again.');
  }

  #assertFreshSocket(socketId) {
    if (!socketId) throw new RoomError('INVALID_SOCKET', 'Connection is not ready.');
    if (this.sessions.has(socketId)) throw new RoomError('ALREADY_IN_ROOM', 'Leave the current room before joining another.');
  }

  #requireRoom(code) {
    const cleanedCode = cleanRoomCode(code);
    const room = this.rooms.get(cleanedCode);
    if (!room) throw new RoomError('ROOM_NOT_FOUND', 'Room not found. Check the code and try again.');
    return room;
  }

  #roomForSocket(socketId) {
    const session = this.sessions.get(socketId);
    if (!session) throw new RoomError('NOT_IN_ROOM', 'Join or create a room first.');
    const room = this.rooms.get(session.code);
    if (!room) throw new RoomError('ROOM_NOT_FOUND', 'This room is no longer available.');
    return { room, session };
  }

  #requireHost(socketId) {
    const context = this.#roomForSocket(socketId);
    if (context.session.role !== 'host') throw new RoomError('HOST_ONLY', 'Only the host can do that.');
    return context;
  }

  #requirePlayer(socketId) {
    const context = this.#roomForSocket(socketId);
    if (context.session.role !== 'player') throw new RoomError('PLAYER_ONLY', 'Only players can do that.');
    const player = context.room.players.find((candidate) => candidate.id === context.session.playerId);
    if (!player) throw new RoomError('PLAYER_NOT_FOUND', 'Your player session is no longer available.');
    return { ...context, player };
  }

  #requireBoardHost(socketId) {
    const context = this.#requireHost(socketId);
    if (context.room.phase !== 'board' || !context.room.gameId) {
      throw new RoomError('NO_ACTIVE_GAME', 'Start a game before using the board.');
    }
    return { ...context, game: this.gamesById.get(context.room.gameId) };
  }

  #touch(room) {
    room.updatedAt = this.now();
  }

  #removePlayerFromRoom(room, playerId) {
    room.players = room.players.filter((player) => player.id !== playerId);
    if (room.currentClue) {
      room.currentClue.buzzes = room.currentClue.buzzes.filter((buzz) => buzz.playerId !== playerId);
      room.currentClue.ineligiblePlayerIds.delete(playerId);
      if (room.currentClue.dailyPlayerId === playerId) {
        room.currentClue.phase = 'daily-wager';
        room.currentClue.dailyPlayerId = null;
        room.currentClue.wager = null;
        room.currentClue.revealed = false;
        room.currentClue.buzzOpen = false;
      }
    }
    if (room.final) delete room.final.entries[playerId];
  }
}

module.exports = {
  MAX_PLAYERS,
  RoomError,
  RoomManager,
  cleanName,
  cleanRoomCode,
};
