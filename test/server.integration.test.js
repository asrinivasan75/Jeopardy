'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { io: createClient } = require('socket.io-client');
const { loadGames } = require('../lib/game-store');
const { createJeopardyServer } = require('../server');

function emitAck(socket, eventName, payload = {}) {
  return new Promise((resolve, reject) => {
    socket.timeout(3000).emit(eventName, payload, (timeoutError, response) => {
      if (timeoutError) return reject(timeoutError);
      if (!response?.ok) {
        const error = new Error(response?.error?.message || 'Socket action failed');
        error.code = response?.error?.code;
        return reject(error);
      }
      resolve(response);
    });
  });
}

function nextState(socket, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off('room:state', onState);
      reject(new Error('Timed out waiting for room state'));
    }, 3000);
    function onState(state) {
      if (!predicate(state)) return;
      clearTimeout(timeout);
      socket.off('room:state', onState);
      resolve(state);
    }
    socket.on('room:state', onState);
  });
}

test('HTTP and Socket.IO clients can host, join, start, and buzz without leaking answers', async (context) => {
  const games = loadGames();
  const jeopardy = createJeopardyServer({ games, logger: { error() {} } });
  const address = await jeopardy.start(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${address.port}`;
  const host = createClient(origin, { transports: ['websocket'], forceNew: true });
  const player = createClient(origin, { transports: ['websocket'], forceNew: true });

  context.after(async () => {
    host.disconnect();
    player.disconnect();
    await jeopardy.stop();
  });

  const health = await fetch(`${origin}/health`).then((response) => response.json());
  assert.deepEqual(health, { ok: true, games: 20, rooms: 0 });
  assert.equal((await fetch(`${origin}/data/games/set-a.json`)).status, 404);
  assert.equal((await fetch(`${origin}/games.js`)).status, 404);

  const created = await emitAck(host, 'room:create');
  assert.equal(created.state.role, 'host');
  const hostSawJoin = nextState(host, (state) => state.players.length === 1);
  const joined = await emitAck(player, 'room:join', { code: created.session.code, name: 'Jordan' });
  assert.equal(joined.state.role, 'player');
  await hostSawJoin;

  const playerSawBoard = nextState(player, (state) => state.phase === 'board');
  await emitAck(host, 'host:start-game', { gameId: games[0].id });
  await playerSawBoard;

  let location;
  games[0].categories.some((category, categoryIndex) => category.clues.some((clue, clueIndex) => {
    if (clue.dailyDouble) return false;
    location = { categoryIndex, clueIndex, clue };
    return true;
  }));

  const playerSawClue = nextState(player, (state) => Boolean(state.currentClue));
  const hostSawClue = nextState(host, (state) => Boolean(state.currentClue));
  await emitAck(host, 'host:open-clue', location);
  const [playerClueState, hostClueState] = await Promise.all([playerSawClue, hostSawClue]);
  assert.equal(playerClueState.currentClue.question, location.clue.clue);
  assert.equal(playerClueState.currentClue.answer, null);
  assert.equal(Object.hasOwn(playerClueState.currentClue, 'expectedAnswer'), false);
  assert.equal(hostClueState.currentClue.expectedAnswer, location.clue.answer);

  const hostSawBuzz = nextState(host, (state) => state.currentClue?.buzzes.length === 1);
  await emitAck(player, 'player:buzz');
  const buzzState = await hostSawBuzz;
  assert.equal(buzzState.currentClue.buzzes[0].name, 'Jordan');
});

test('stable resume credentials recover from a lost acknowledgement and keep host-offline buzzes authoritative', async (context) => {
  const games = loadGames();
  const jeopardy = createJeopardyServer({ games, logger: { error() {} } });
  const address = await jeopardy.start(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${address.port}`;
  const sockets = [
    createClient(origin, { transports: ['websocket'], forceNew: true }),
    createClient(origin, { transports: ['websocket'], forceNew: true }),
  ];
  const [host, player] = sockets;

  context.after(async () => {
    sockets.forEach((socket) => socket.disconnect());
    await jeopardy.stop();
  });

  const created = await emitAck(host, 'room:create');
  await emitAck(player, 'room:join', { code: created.session.code, name: 'Jordan' });
  await emitAck(host, 'host:start-game', { gameId: games[0].id });

  let location;
  games[0].categories.some((category, categoryIndex) => category.clues.some((clue, clueIndex) => {
    if (clue.dailyDouble) return false;
    location = { categoryIndex, clueIndex };
    return true;
  }));
  await emitAck(host, 'host:open-clue', location);

  const playerSawHostOffline = nextState(player, (state) => state.hostConnected === false);
  host.disconnect();
  await playerSawHostOffline;
  await assert.rejects(
    emitAck(player, 'player:buzz'),
    (error) => error.code === 'HOST_OFFLINE',
  );

  const firstReplacement = createClient(origin, { transports: ['websocket'], forceNew: true });
  sockets.push(firstReplacement);
  const playerSawHostReturn = nextState(player, (state) => state.hostConnected === true);
  firstReplacement.emit('room:resume', {
    code: created.session.code,
    token: created.session.token,
  }, () => {
    // Intentionally ignore the acknowledgement, matching a client that lost it in transit.
  });
  await playerSawHostReturn;

  const retryingHost = createClient(origin, { transports: ['websocket'], forceNew: true });
  sockets.push(retryingHost);
  const retried = await emitAck(retryingHost, 'room:resume', {
    code: created.session.code,
    token: created.session.token,
  });
  assert.equal(retried.session.role, 'host');
  assert.equal(retried.session.token, created.session.token);

  const retryingHostSawBuzz = nextState(retryingHost, (state) => state.currentClue?.buzzes.length === 1);
  await emitAck(player, 'player:buzz');
  const buzzState = await retryingHostSawBuzz;
  assert.equal(buzzState.currentClue.buzzes[0].name, 'Jordan');
});
