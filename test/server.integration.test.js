'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');
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

function archiveFixture({ missing = '2:5' } = {}) {
  const jeopardy = [];
  for (let x = 1; x <= 6; x += 1) {
    for (let y = 1; y <= 5; y += 1) {
      if (`${x}:${y}` === missing) continue;
      jeopardy.push({
        x,
        y,
        q: `Archive clue ${x}-${y}`,
        a: `Secret archive answer ${x}-${y}`,
        cat: `ARCHIVE CATEGORY ${x}`,
        dd: x === 3 && y === 3,
        val: y * 200,
      });
    }
  }
  return {
    7866: {
      epNum: '7866',
      airDate: '2018-11-19',
      info: 'teen',
      jeopardy,
      final: [{
        x: 1,
        y: 1,
        q: 'Archive Final clue',
        a: 'Secret Archive Final answer',
        cat: 'ARCHIVE FINAL',
        dd: false,
        val: 0,
      }],
    },
  };
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
  const archiveStatus = await fetch(`${origin}/api/archive/status`).then((response) => response.json());
  assert.equal(archiveStatus.configured, false);
  assert.equal(archiveStatus.loaded, false);
  assert.match(archiveStatus.message, /JEOPARDY_ARCHIVE_PATH/);
  const archiveSearchResponse = await fetch(`${origin}/api/archive/search?q=7866`);
  assert.equal(archiveSearchResponse.status, 409);
  assert.deepEqual(await archiveSearchResponse.json(), {
    error: {
      code: 'ARCHIVE_NOT_CONFIGURED',
      message: 'Set JEOPARDY_ARCHIVE_PATH to a compatible .json.gz archive that you are authorized to use.',
    },
  });
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
  assert.equal(hostClueState.currentClue.answer, null);
  assert.equal(hostClueState.currentClue.hostKeyAvailable, true);
  assert.equal(Object.hasOwn(hostClueState.currentClue, 'expectedAnswer'), false);

  const hostSawPrivateKey = nextState(host, (state) => state.currentClue?.hostKeyOpened === true);
  const playerSawKeyState = nextState(player, (state) => Boolean(state.currentClue));
  await emitAck(host, 'host:open-answer-key');
  const [hostKeyState, remoteKeyState] = await Promise.all([hostSawPrivateKey, playerSawKeyState]);
  assert.equal(hostKeyState.currentClue.expectedAnswer, location.clue.answer);
  assert.equal(hostKeyState.currentClue.hostKeyOutcome, 'moderator');
  assert.equal(Object.hasOwn(remoteKeyState.currentClue, 'expectedAnswer'), false);

  const hostSawBuzz = nextState(host, (state) => state.currentClue?.buzzes.length === 1);
  await emitAck(player, 'player:buzz');
  const buzzState = await hostSawBuzz;
  assert.equal(buzzState.currentClue.buzzes[0].name, 'Jordan');

  const hostSawAnswer = nextState(host, (state) => state.currentClue?.answer === location.clue.answer);
  const playerSawAnswer = nextState(player, (state) => state.currentClue?.answer === location.clue.answer);
  await emitAck(host, 'host:reveal-answer');
  const [revealedHostState] = await Promise.all([hostSawAnswer, playerSawAnswer]);
  assert.equal(revealedHostState.currentClue.hostKeyOpened, false);
  assert.equal(revealedHostState.currentClue.hostKeyOutcome, null);
  assert.equal(Object.hasOwn(revealedHostState.currentClue, 'expectedAnswer'), false);
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

test('host can opt into the contestant roster, buzz, play Final, opt out, and remain host', async (context) => {
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

  const created = await emitAck(host, 'room:create');
  const hostSawSelf = nextState(host, (state) => state.you?.isHost === true);
  await emitAck(host, 'host:join-as-player', { name: 'Alex' });
  const joinedHostState = await hostSawSelf;
  const hostPlayerId = joinedHostState.you.id;
  assert.equal(joinedHostState.role, 'host');
  assert.ok(joinedHostState.gameCatalog);

  const hostSawPlayer = nextState(host, (state) => state.players.length === 2);
  const joinedPlayer = await emitAck(player, 'room:join', { code: created.session.code, name: 'Jordan' });
  await hostSawPlayer;
  const playerId = joinedPlayer.session.playerId;

  await emitAck(host, 'host:start-game', { gameId: games[0].id });
  let location;
  games[0].categories.some((category, categoryIndex) => category.clues.some((clue, clueIndex) => {
    if (clue.dailyDouble) return false;
    location = { categoryIndex, clueIndex, clue };
    return true;
  }));
  const hostSawClue = nextState(host, (state) => Boolean(state.currentClue));
  await emitAck(host, 'host:open-clue', location);
  const privateHostClue = await hostSawClue;
  assert.equal(privateHostClue.currentClue.answer, null);
  assert.equal(Object.hasOwn(privateHostClue.currentClue, 'expectedAnswer'), false);

  await emitAck(host, 'player:buzz');
  const hostSawTwoBuzzes = nextState(host, (state) => state.currentClue?.buzzes.length === 2);
  await emitAck(player, 'player:buzz', { playerId: hostPlayerId });
  const orderedState = await hostSawTwoBuzzes;
  assert.deepEqual(
    orderedState.currentClue.buzzes.map((buzz) => buzz.playerId),
    [hostPlayerId, playerId],
  );

  const hostSawCommittedKey = nextState(host, (state) => state.currentClue?.hostKeyOutcome === 'committed');
  const playerSawCommittedState = nextState(player, (state) => Boolean(state.currentClue));
  await emitAck(host, 'host:open-answer-key');
  const [committedKeyState, remoteCommittedState] = await Promise.all([hostSawCommittedKey, playerSawCommittedState]);
  assert.equal(committedKeyState.currentClue.expectedAnswer, location.clue.answer);
  assert.equal(committedKeyState.currentClue.buzzes[0].playerId, hostPlayerId);
  assert.equal(Object.hasOwn(remoteCommittedState.currentClue, 'expectedAnswer'), false);
  await emitAck(host, 'host:score-clue', { playerId: hostPlayerId, correct: true });
  const hostSawFinal = nextState(host, (state) => state.phase === 'final');
  await emitAck(host, 'host:start-final');
  const finalState = await hostSawFinal;
  assert.equal(finalState.final.eligible, true);
  assert.equal(finalState.final.yourMaxWager, location.clue.value);

  const hostSawWagerLock = nextState(host, (state) => state.final?.yourWagerSubmitted === true);
  await emitAck(host, 'player:final-wager', { wager: 100 });
  assert.equal((await hostSawWagerLock).final.yourWager, 100);
  await emitAck(host, 'host:advance-final', { phase: 'wager' });

  const hostSawResponseLock = nextState(host, (state) => state.final?.yourResponseSubmitted === true);
  await emitAck(host, 'player:final-response', { response: 'What is the host answer?' });
  await hostSawResponseLock;
  await emitAck(host, 'host:advance-final', { phase: 'clue' });
  await emitAck(host, 'host:score-final', { playerId: hostPlayerId, correct: true });
  await emitAck(host, 'host:finish-final');

  const hostSawLobby = nextState(host, (state) => state.phase === 'lobby');
  await emitAck(host, 'host:return-lobby');
  await hostSawLobby;
  const hostSawOptOut = nextState(host, (state) => state.you === null);
  await emitAck(host, 'host:leave-as-player');
  const optedOutState = await hostSawOptOut;
  assert.equal(optedOutState.role, 'host');
  assert.equal(optedOutState.players.some((contestant) => contestant.id === hostPlayerId), false);
});

test('dual-role host forfeits a queued attempt before privately judging and promoting remote buzzes', async (context) => {
  const games = loadGames();
  const jeopardy = createJeopardyServer({ games, logger: { error() {} } });
  const address = await jeopardy.start(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${address.port}`;
  const host = createClient(origin, { transports: ['websocket'], forceNew: true });
  const firstPlayer = createClient(origin, { transports: ['websocket'], forceNew: true });
  const secondPlayer = createClient(origin, { transports: ['websocket'], forceNew: true });

  context.after(async () => {
    host.disconnect();
    firstPlayer.disconnect();
    secondPlayer.disconnect();
    await jeopardy.stop();
  });

  const created = await emitAck(host, 'room:create');
  const hostSawSelf = nextState(host, (state) => state.you?.isHost === true);
  await emitAck(host, 'host:join-as-player', { name: 'Alex' });
  const hostPlayerId = (await hostSawSelf).you.id;
  const first = await emitAck(firstPlayer, 'room:join', { code: created.session.code, name: 'Jordan' });
  const second = await emitAck(secondPlayer, 'room:join', { code: created.session.code, name: 'Taylor' });
  await emitAck(host, 'host:start-game', { gameId: games[0].id });

  let location;
  games[0].categories.some((category, categoryIndex) => category.clues.some((clue, clueIndex) => {
    if (clue.dailyDouble) return false;
    location = { categoryIndex, clueIndex, clue };
    return true;
  }));
  await emitAck(host, 'host:open-clue', location);
  await emitAck(firstPlayer, 'player:buzz');
  await emitAck(host, 'player:buzz');
  await emitAck(secondPlayer, 'player:buzz');

  const hostSawForfeit = nextState(host, (state) => state.currentClue?.hostKeyOutcome === 'forfeited');
  const firstSawForfeit = nextState(firstPlayer, (state) => state.currentClue?.ineligiblePlayerIds.includes(hostPlayerId));
  await emitAck(host, 'host:open-answer-key');
  const [hostKeyState, remoteState] = await Promise.all([hostSawForfeit, firstSawForfeit]);
  assert.equal(hostKeyState.currentClue.expectedAnswer, location.clue.answer);
  assert.deepEqual(
    hostKeyState.currentClue.buzzes.map((buzz) => buzz.playerId),
    [first.session.playerId, second.session.playerId],
  );
  assert.equal(Object.hasOwn(remoteState.currentClue, 'expectedAnswer'), false);
  await assert.rejects(
    emitAck(host, 'player:buzz'),
    (error) => error.code === 'ALREADY_RULED',
  );

  const hostSawPromotion = nextState(host, (state) => state.currentClue?.buzzes[0]?.playerId === second.session.playerId);
  await emitAck(host, 'host:score-clue', { playerId: first.session.playerId, correct: false });
  const promotedState = await hostSawPromotion;
  assert.equal(promotedState.currentClue.hostKeyOutcome, 'forfeited');
  assert.equal(promotedState.currentClue.expectedAnswer, location.clue.answer);
  await emitAck(host, 'host:score-clue', { playerId: second.session.playerId, correct: true });
});

test('host can privately import the referenced archive episode while missing clues stay unavailable', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jeopardy-archive-server-'));
  const archiveFilePath = path.join(directory, 'jeopardy.json.gz');
  const fixture = archiveFixture();
  fixture['alternate-7866'] = {
    ...structuredClone(fixture['7866']),
    airDate: '2018-11-20',
    info: 'alternate fixture',
    jeopardy: fixture['7866'].jeopardy.map((clue) => ({
      ...clue,
      q: clue.q.replace('Archive clue', 'Alternate archive clue'),
      a: clue.a.replace('Secret archive answer', 'Alternate secret answer'),
    })),
  };
  fs.writeFileSync(archiveFilePath, zlib.gzipSync(Buffer.from(JSON.stringify(fixture))));

  const games = loadGames();
  const jeopardy = createJeopardyServer({
    games,
    archiveFilePath,
    archiveProvider: 'integration fixture',
    logger: { error() {} },
  });
  const address = await jeopardy.start(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${address.port}`;
  const host = createClient(origin, { transports: ['websocket'], forceNew: true });
  const player = createClient(origin, { transports: ['websocket'], forceNew: true });
  const otherHost = createClient(origin, { transports: ['websocket'], forceNew: true });

  context.after(async () => {
    host.disconnect();
    player.disconnect();
    otherHost.disconnect();
    await jeopardy.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const status = await fetch(`${origin}/api/archive/status`).then((response) => response.json());
  assert.equal(status.configured, true);
  assert.equal(status.loaded, true);
  assert.equal(status.episodes, 2);
  assert.equal(status.playableEpisodes, 2);

  const search = await fetch(`${origin}/api/archive/search?q=7866&limit=12`).then((response) => response.json());
  assert.equal(search.total, 2);
  assert.deepEqual(new Set(search.results.map((game) => game.id)), new Set(['archive-7866', 'archive-alternate-7866']));
  const selectedSearchResult = search.results.find((game) => game.id === 'archive-alternate-7866');
  assert.equal(selectedSearchResult.episodeNumber, '7866');
  assert.equal(selectedSearchResult.clueCount, 29);
  assert.equal(selectedSearchResult.missingClues, 1);
  assert.equal(JSON.stringify(search).includes('Archive clue 1-1'), false);
  assert.equal(JSON.stringify(search).includes('Secret archive answer'), false);
  assert.equal(JSON.stringify(search).includes('Alternate secret answer'), false);

  const created = await emitAck(host, 'room:create');
  await emitAck(player, 'room:join', { code: created.session.code, name: 'Jordan' });
  await assert.rejects(
    emitAck(player, 'host:import-archive', { episodeNumber: '7866' }),
    (error) => error.code === 'HOST_ONLY',
  );

  const imported = await emitAck(host, 'host:import-archive', { gameId: selectedSearchResult.id });
  assert.equal(imported.game.id, 'archive-alternate-7866');
  assert.equal(imported.game.source.clueCount, 29);
  assert.equal(JSON.stringify(imported).includes('Secret archive answer'), false);

  const unrelatedRoom = await emitAck(otherHost, 'room:create');
  assert.equal(unrelatedRoom.state.gameCatalog.some((game) => game.id === imported.game.id), false);
  const publicCatalog = await fetch(`${origin}/api/games`).then((response) => response.json());
  assert.equal(publicCatalog.length, 20);
  assert.equal(publicCatalog.some((game) => game.id === imported.game.id), false);

  const playerSawBoard = nextState(player, (state) => state.game?.id === 'archive-alternate-7866');
  await emitAck(host, 'host:start-game', { gameId: imported.game.id });
  const boardState = await playerSawBoard;
  assert.deepEqual(boardState.game.categories[1].clues[4], {
    value: 1000,
    answered: true,
    unavailable: true,
  });
  await assert.rejects(
    emitAck(host, 'host:import-archive', { gameId: selectedSearchResult.id }),
    (error) => error.code === 'LOBBY_ONLY',
  );
  await assert.rejects(
    emitAck(host, 'host:open-clue', { categoryIndex: 1, clueIndex: 4 }),
    (error) => error.code === 'CLUE_UNAVAILABLE',
  );

  const playerSawClue = nextState(player, (state) => state.currentClue?.question === 'Alternate archive clue 1-1');
  const hostSawClue = nextState(host, (state) => state.currentClue?.question === 'Alternate archive clue 1-1');
  await emitAck(host, 'host:open-clue', { categoryIndex: 0, clueIndex: 0 });
  const [playerState, hostState] = await Promise.all([playerSawClue, hostSawClue]);
  assert.equal(playerState.currentClue.answer, null);
  assert.equal(Object.hasOwn(playerState.currentClue, 'expectedAnswer'), false);
  assert.equal(Object.hasOwn(hostState.currentClue, 'expectedAnswer'), false);

  const playerSawReset = nextState(player, (state) => !state.currentClue);
  await emitAck(host, 'host:reset-game');
  const resetState = await playerSawReset;
  assert.deepEqual(resetState.game.categories[1].clues[4], {
    value: 1000,
    answered: true,
    unavailable: true,
  });
});
