'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { catalogGames, loadGames } = require('../lib/game-store');
const { RoomError, RoomManager } = require('../lib/room-manager');

function setupRoom() {
  const games = loadGames();
  let timestamp = 1000;
  const manager = new RoomManager({ games, now: () => timestamp++ });
  const host = manager.createRoom('host-1');
  const first = manager.joinRoom('player-1', { code: host.code, name: 'Maya' });
  const second = manager.joinRoom('player-2', { code: host.code, name: 'Theo' });
  return { catalog: catalogGames(games), first, games, host, manager, second };
}

function locateClue(game, predicate) {
  for (let categoryIndex = 0; categoryIndex < game.categories.length; categoryIndex += 1) {
    for (let clueIndex = 0; clueIndex < game.categories[categoryIndex].clues.length; clueIndex += 1) {
      const clue = game.categories[categoryIndex].clues[clueIndex];
      if (predicate(clue)) return { categoryIndex, clueIndex, clue };
    }
  }
  throw new Error('Matching clue not found');
}

test('creates rooms, enforces unique names, and resumes disconnected sessions', () => {
  const { catalog, first, host, manager } = setupRoom();

  assert.equal(host.code.length, 5);
  assert.throws(
    () => manager.joinRoom('player-3', { code: host.code, name: '  maya  ' }),
    (error) => error instanceof RoomError && error.code === 'NAME_TAKEN',
  );

  manager.disconnect('player-1');
  assert.equal(manager.stateFor('host-1', catalog).players.find((player) => player.id === first.playerId).connected, false);

  const resumed = manager.resumeRoom('player-1-new', { code: host.code, token: first.token });
  assert.equal(resumed.playerId, first.playerId);
  assert.equal(resumed.token, first.token);
  assert.equal(manager.stateFor('player-1-new', catalog).you.name, 'Maya');
  assert.equal(manager.stateFor('host-1', catalog).players.find((player) => player.id === first.playerId).connected, true);
});

test('an active session takeover ejects the previous socket without risking lost credentials', () => {
  const { catalog, first, host, manager } = setupRoom();
  const resumed = manager.resumeRoom('player-1-new', { code: host.code, token: first.token });

  assert.equal(resumed.replacedSocketId, 'player-1');
  assert.throws(() => manager.stateFor('player-1', catalog), (error) => error.code === 'NOT_IN_ROOM');
  assert.equal(manager.stateFor('player-1-new', catalog).you.id, first.playerId);
  const retried = manager.resumeRoom('player-1-retry', { code: host.code, token: first.token });
  assert.equal(retried.replacedSocketId, 'player-1-new');
  assert.equal(retried.token, first.token);
});

test('host can join the roster, keep host privileges, and participate in authoritative buzz order', () => {
  const { catalog, first, games, manager, second } = setupRoom();
  manager.joinHostAsPlayer('host-1', { name: 'Alex' });

  let hostState = manager.stateFor('host-1', catalog);
  const hostPlayerId = hostState.you.id;
  assert.equal(hostState.role, 'host');
  assert.equal(hostState.you.name, 'Alex');
  assert.equal(hostState.you.isHost, true);
  assert.equal(hostState.players.find((player) => player.id === hostPlayerId).isHost, true);
  assert.equal(hostState.players.filter((player) => player.isHost).length, 1);

  manager.joinHostAsPlayer('host-1', { name: 'Alexis' });
  hostState = manager.stateFor('host-1', catalog);
  assert.equal(hostState.players.length, 3);
  assert.equal(hostState.you.id, hostPlayerId);
  assert.equal(hostState.you.name, 'Alexis');
  assert.throws(
    () => manager.joinRoom('duplicate-name', { code: hostState.code, name: 'alexis' }),
    (error) => error.code === 'NAME_TAKEN',
  );

  const location = locateClue(games[0], (clue) => !clue.dailyDouble);
  manager.startGame('host-1', games[0].id);
  manager.openClue('host-1', location);
  manager.buzz('player-2');
  manager.buzz('host-1');
  manager.buzz('player-1');
  assert.deepEqual(
    manager.stateFor('host-1', catalog).currentClue.buzzes.map((buzz) => buzz.playerId),
    [second.playerId, hostPlayerId, first.playerId],
  );

  manager.openAnswerKey('host-1');
  hostState = manager.stateFor('host-1', catalog);
  assert.equal(hostState.currentClue.hostKeyOutcome, 'forfeited');
  assert.equal(hostState.currentClue.expectedAnswer, location.clue.answer);
  assert.equal(hostState.currentClue.ineligiblePlayerIds.includes(hostPlayerId), true);
  assert.deepEqual(
    hostState.currentClue.buzzes.map((buzz) => buzz.playerId),
    [second.playerId, first.playerId],
  );
  assert.equal(Object.hasOwn(manager.stateFor('player-1', catalog).currentClue, 'expectedAnswer'), false);
  assert.throws(() => manager.buzz('host-1'), (error) => error.code === 'ALREADY_RULED');
  manager.scoreClue('host-1', { playerId: second.playerId, correct: false });
  hostState = manager.stateFor('host-1', catalog);
  assert.deepEqual(hostState.currentClue.buzzes.map((buzz) => buzz.playerId), [first.playerId]);
  assert.equal(hostState.currentClue.ineligiblePlayerIds.includes(hostPlayerId), true);
  manager.scoreClue('host-1', { playerId: first.playerId, correct: true });
  hostState = manager.stateFor('host-1', catalog);
  assert.equal(hostState.you.score, 0);
  assert.equal(hostState.players.find((player) => player.id === first.playerId).score, location.clue.value);
});

test('host contestant membership is lobby-only, counts toward the cap, and cannot be generically removed', () => {
  const games = loadGames();
  const manager = new RoomManager({ games });
  const host = manager.createRoom('host-cap');
  manager.joinHostAsPlayer('host-cap', { name: 'Host Player' });
  const hostPlayerId = manager.stateFor('host-cap', catalogGames(games)).you.id;

  for (let index = 1; index <= 7; index += 1) {
    manager.joinRoom(`player-cap-${index}`, { code: host.code, name: `Player ${index}` });
  }
  assert.equal(manager.stateFor('host-cap', catalogGames(games)).players.length, 8);
  assert.throws(
    () => manager.joinRoom('player-cap-8', { code: host.code, name: 'Player 8' }),
    (error) => error.code === 'ROOM_FULL',
  );
  assert.throws(
    () => manager.removePlayer('host-cap', hostPlayerId),
    (error) => error.code === 'CANNOT_REMOVE_HOST',
  );

  manager.leaveHostAsPlayer('host-cap');
  assert.equal(manager.stateFor('host-cap', catalogGames(games)).you, null);
  assert.equal(manager.stateFor('host-cap', catalogGames(games)).players.length, 7);
  manager.startGame('host-cap', games[0].id);
  assert.throws(
    () => manager.joinHostAsPlayer('host-cap', { name: 'Host Player' }),
    (error) => error.code === 'LOBBY_ONLY',
  );
  assert.throws(
    () => manager.leaveHostAsPlayer('host-cap'),
    (error) => error.code === 'LOBBY_ONLY',
  );
});

test('host contestant identity survives disconnect and resume without losing its score', () => {
  const { catalog, games, host, manager } = setupRoom();
  manager.joinHostAsPlayer('host-1', { name: 'Alex' });
  const beforeDisconnect = manager.stateFor('host-1', catalog).you;
  manager.startGame('host-1', games[0].id);
  manager.adjustScore('host-1', { playerId: beforeDisconnect.id, delta: 600 });
  const location = locateClue(games[0], (clue) => !clue.dailyDouble);
  manager.openClue('host-1', location);
  manager.openAnswerKey('host-1');
  manager.disconnect('host-1');

  const disconnectedHost = manager.stateFor('player-1', catalog).players.find((player) => player.id === beforeDisconnect.id);
  assert.equal(disconnectedHost.connected, false);
  assert.equal(disconnectedHost.isHost, true);

  manager.resumeRoom('host-resumed', { code: host.code, token: host.token });
  const resumedState = manager.stateFor('host-resumed', catalog);
  assert.equal(resumedState.role, 'host');
  assert.equal(resumedState.you.id, beforeDisconnect.id);
  assert.equal(resumedState.you.connected, true);
  assert.equal(resumedState.you.score, 600);
  assert.equal(resumedState.currentClue.hostKeyOpened, true);
  assert.equal(resumedState.currentClue.hostKeyOutcome, 'forfeited');
  assert.equal(resumedState.currentClue.expectedAnswer, location.clue.answer);
  assert.equal(resumedState.currentClue.ineligiblePlayerIds.includes(beforeDisconnect.id), true);

  const takeover = manager.resumeRoom('host-takeover', { code: host.code, token: host.token });
  assert.equal(takeover.replacedSocketId, 'host-resumed');
  assert.throws(() => manager.stateFor('host-resumed', catalog), (error) => error.code === 'NOT_IN_ROOM');
  const takeoverState = manager.stateFor('host-takeover', catalog);
  assert.equal(takeoverState.you.id, beforeDisconnect.id);
  assert.equal(takeoverState.you.connected, true);
  assert.equal(takeoverState.players.filter((player) => player.isHost).length, 1);
});

test('keeps answers private, orders buzzes, and reopens after an incorrect response', () => {
  const { catalog, first, games, manager, second } = setupRoom();
  const game = games[0];
  const location = locateClue(game, (clue) => !clue.dailyDouble);
  manager.startGame('host-1', game.id);
  manager.openClue('host-1', location);

  let hostState = manager.stateFor('host-1', catalog);
  const playerState = manager.stateFor('player-1', catalog);
  assert.equal(hostState.currentClue.answer, null);
  assert.equal(hostState.currentClue.hostKeyAvailable, true);
  assert.equal(hostState.currentClue.hostKeyOpened, false);
  assert.equal(hostState.currentClue.hostKeyOutcome, null);
  assert.equal(Object.hasOwn(hostState.currentClue, 'expectedAnswer'), false);
  assert.equal(playerState.currentClue.answer, null);
  assert.equal(Object.hasOwn(playerState.currentClue, 'expectedAnswer'), false);
  assert.equal(JSON.stringify(playerState.game).includes(location.clue.clue), false);

  manager.openAnswerKey('host-1');
  hostState = manager.stateFor('host-1', catalog);
  assert.equal(hostState.currentClue.expectedAnswer, location.clue.answer);
  assert.equal(hostState.currentClue.hostKeyAvailable, false);
  assert.equal(hostState.currentClue.hostKeyOpened, true);
  assert.equal(hostState.currentClue.hostKeyOutcome, 'moderator');
  assert.equal(Object.hasOwn(manager.stateFor('player-1', catalog).currentClue, 'expectedAnswer'), false);

  manager.buzz('player-2');
  manager.buzz('player-1');
  assert.deepEqual(
    manager.stateFor('host-1', catalog).currentClue.buzzes.map((buzz) => buzz.playerId),
    [second.playerId, first.playerId],
  );

  manager.scoreClue('host-1', { playerId: second.playerId, correct: false });
  const afterMiss = manager.stateFor('host-1', catalog);
  assert.equal(afterMiss.players.find((player) => player.id === second.playerId).score, -location.clue.value);
  assert.equal(afterMiss.currentClue.buzzOpen, true);
  assert.deepEqual(afterMiss.currentClue.buzzes.map((buzz) => buzz.playerId), [first.playerId]);
  assert.throws(
    () => manager.buzz('player-2'),
    (error) => error.code === 'ALREADY_RULED',
  );
  assert.throws(
    () => manager.scoreClue('host-1', { playerId: second.playerId, correct: false }),
    (error) => error.code === 'ALREADY_RULED',
  );

  manager.scoreClue('host-1', { playerId: first.playerId, correct: true });
  const completeState = manager.stateFor('host-1', catalog);
  assert.equal(completeState.currentClue, null);
  assert.equal(completeState.players.find((player) => player.id === first.playerId).score, location.clue.value);
  assert.equal(completeState.game.categories[location.categoryIndex].clues[location.clueIndex].answered, true);
});

test('first-buzz dual-role host commits before opening the private answer key', () => {
  const { catalog, games, host, manager } = setupRoom();
  manager.joinHostAsPlayer('host-1', { name: 'Alex' });
  const hostPlayerId = manager.stateFor('host-1', catalog).you.id;
  const location = locateClue(games[0], (clue) => !clue.dailyDouble);
  manager.startGame('host-1', games[0].id);
  manager.openClue('host-1', location);

  for (const socketId of ['host-1', 'player-1', 'player-2']) {
    const clue = manager.stateFor(socketId, catalog).currentClue;
    assert.equal(clue.answer, null);
    assert.equal(Object.hasOwn(clue, 'expectedAnswer'), false);
  }

  manager.buzz('host-1');
  assert.throws(
    () => manager.scoreClue('host-1', { playerId: hostPlayerId, correct: true }),
    (error) => error.code === 'HOST_ATTEMPT_NOT_COMMITTED',
  );
  manager.openAnswerKey('host-1');
  let hostClue = manager.stateFor('host-1', catalog).currentClue;
  assert.equal(hostClue.hostKeyOpened, true);
  assert.equal(hostClue.hostKeyOutcome, 'committed');
  assert.equal(hostClue.expectedAnswer, location.clue.answer);
  assert.equal(hostClue.buzzes[0].playerId, hostPlayerId);
  assert.throws(() => manager.resetBuzzers('host-1'), (error) => error.code === 'HOST_ATTEMPT_LOCKED');
  assert.equal(Object.hasOwn(manager.stateFor('player-1', catalog).currentClue, 'expectedAnswer'), false);

  manager.disconnect('host-1');
  manager.resumeRoom('host-reconnected', { code: host.code, token: host.token });
  hostClue = manager.stateFor('host-reconnected', catalog).currentClue;
  assert.equal(hostClue.hostKeyOpened, true);
  assert.equal(hostClue.hostKeyOutcome, 'committed');
  assert.equal(hostClue.expectedAnswer, location.clue.answer);
  assert.equal(hostClue.buzzes[0].playerId, hostPlayerId);

  manager.resumeRoom('host-takeover', { code: host.code, token: host.token });
  hostClue = manager.stateFor('host-takeover', catalog).currentClue;
  assert.equal(hostClue.hostKeyOutcome, 'committed');
  assert.equal(hostClue.buzzes[0].playerId, hostPlayerId);
  manager.scoreClue('host-takeover', { playerId: hostPlayerId, correct: true });
  assert.equal(manager.stateFor('host-takeover', catalog).you.score, location.clue.value);
});

test('unopened answer key remains private across host reconnect', () => {
  const { catalog, games, host, manager } = setupRoom();
  manager.joinHostAsPlayer('host-1', { name: 'Alex' });
  const location = locateClue(games[0], (clue) => !clue.dailyDouble);
  manager.startGame('host-1', games[0].id);
  manager.openClue('host-1', location);
  manager.disconnect('host-1');
  manager.resumeRoom('host-reconnected', { code: host.code, token: host.token });

  const clue = manager.stateFor('host-reconnected', catalog).currentClue;
  assert.equal(clue.hostKeyAvailable, true);
  assert.equal(clue.hostKeyOpened, false);
  assert.equal(clue.hostKeyOutcome, null);
  assert.equal(Object.hasOwn(clue, 'expectedAnswer'), false);
});

test('unbuzzed dual-role host forfeits the clue before opening the private answer key', () => {
  const { catalog, games, manager } = setupRoom();
  manager.joinHostAsPlayer('host-1', { name: 'Alex' });
  const hostPlayerId = manager.stateFor('host-1', catalog).you.id;
  const location = locateClue(games[0], (clue) => !clue.dailyDouble);
  manager.startGame('host-1', games[0].id);
  manager.openClue('host-1', location);

  manager.openAnswerKey('host-1');
  let clue = manager.stateFor('host-1', catalog).currentClue;
  assert.equal(clue.hostKeyOutcome, 'forfeited');
  assert.equal(clue.ineligiblePlayerIds.includes(hostPlayerId), true);
  assert.throws(() => manager.buzz('host-1'), (error) => error.code === 'ALREADY_RULED');
  manager.resetBuzzers('host-1');
  assert.throws(() => manager.buzz('host-1'), (error) => error.code === 'ALREADY_RULED');

  manager.buzz('player-1');
  manager.scoreClue('host-1', { playerId: manager.stateFor('player-1', catalog).you.id, correct: true });
  const nextLocation = locateClue(games[0], (candidate) => !candidate.dailyDouble && candidate !== location.clue);
  manager.openClue('host-1', nextLocation);
  clue = manager.stateFor('host-1', catalog).currentClue;
  assert.equal(clue.hostKeyAvailable, true);
  assert.equal(clue.hostKeyOpened, false);
  assert.equal(clue.hostKeyOutcome, null);
  assert.equal(clue.ineligiblePlayerIds.includes(hostPlayerId), false);
  assert.equal(Object.hasOwn(clue, 'expectedAnswer'), false);
  manager.buzz('host-1');
  assert.equal(manager.stateFor('host-1', catalog).currentClue.buzzes[0].playerId, hostPlayerId);
});

test('public reveal resets private key disclosure state', () => {
  const { catalog, games, manager } = setupRoom();
  const location = locateClue(games[0], (clue) => !clue.dailyDouble);
  manager.startGame('host-1', games[0].id);
  manager.openClue('host-1', location);
  manager.openAnswerKey('host-1');
  assert.equal(manager.stateFor('host-1', catalog).currentClue.hostKeyOpened, true);

  manager.revealAnswer('host-1');
  const hostClue = manager.stateFor('host-1', catalog).currentClue;
  assert.equal(hostClue.answer, location.clue.answer);
  assert.equal(hostClue.hostKeyAvailable, false);
  assert.equal(hostClue.hostKeyOpened, false);
  assert.equal(hostClue.hostKeyOutcome, null);
  assert.equal(Object.hasOwn(hostClue, 'expectedAnswer'), false);
  assert.equal(manager.stateFor('player-1', catalog).currentClue.answer, location.clue.answer);
});

test('authoritative buzz handling pauses while the host is disconnected', () => {
  const { catalog, first, games, host, manager } = setupRoom();
  const location = locateClue(games[0], (clue) => !clue.dailyDouble);
  manager.startGame('host-1', games[0].id);
  manager.openClue('host-1', location);
  manager.disconnect('host-1');

  assert.equal(manager.stateFor('player-1', catalog).hostConnected, false);
  assert.throws(() => manager.buzz('player-1'), (error) => error.code === 'HOST_OFFLINE');

  manager.resumeRoom('host-2', { code: host.code, token: host.token });
  manager.buzz('player-1');
  assert.equal(manager.stateFor('host-2', catalog).currentClue.buzzes[0].playerId, first.playerId);
});

test('runs a Daily Double with host-controlled contestant and wager', () => {
  const { catalog, first, games, manager } = setupRoom();
  const game = games[0];
  const location = locateClue(game, (clue) => clue.dailyDouble);
  manager.startGame('host-1', game.id);
  manager.openClue('host-1', location);
  assert.equal(manager.stateFor('player-1', catalog).currentClue.phase, 'daily-wager');
  assert.equal(manager.stateFor('player-1', catalog).currentClue.question, null);
  assert.equal(manager.stateFor('host-1', catalog).currentClue.hostKeyAvailable, false);
  assert.throws(() => manager.openAnswerKey('host-1'), (error) => error.code === 'NO_ACTIVE_CLUE');

  assert.throws(
    () => manager.setDailyDouble('host-1', { playerId: first.playerId, wager: 1001 }),
    (error) => error.code === 'INVALID_WAGER',
  );
  manager.setDailyDouble('host-1', { playerId: first.playerId, wager: 600 });
  const questionState = manager.stateFor('player-1', catalog);
  assert.equal(questionState.currentClue.phase, 'question');
  assert.equal(questionState.currentClue.dailyPlayerId, first.playerId);
  assert.equal(questionState.currentClue.value, 600);
  assert.throws(() => manager.buzz('player-1'), (error) => error.code === 'BUZZ_CLOSED');

  manager.openAnswerKey('host-1');
  const hostQuestionState = manager.stateFor('host-1', catalog);
  assert.equal(hostQuestionState.currentClue.hostKeyOutcome, 'moderator');
  assert.equal(hostQuestionState.currentClue.expectedAnswer, location.clue.answer);

  manager.scoreClue('host-1', { playerId: first.playerId, correct: false });
  assert.equal(manager.stateFor('host-1', catalog).players.find((player) => player.id === first.playerId).score, -600);
  assert.equal(manager.stateFor('host-1', catalog).currentClue, null);
});

test('host contestant can be selected for and scored on a Daily Double', () => {
  const { catalog, games, manager } = setupRoom();
  manager.joinHostAsPlayer('host-1', { name: 'Alex' });
  const hostPlayerId = manager.stateFor('host-1', catalog).you.id;
  const location = locateClue(games[0], (clue) => clue.dailyDouble);
  manager.startGame('host-1', games[0].id);
  manager.openClue('host-1', location);

  assert.throws(
    () => manager.setDailyDouble('host-1', { playerId: hostPlayerId, wager: 1001 }),
    (error) => error.code === 'INVALID_WAGER',
  );
  manager.setDailyDouble('host-1', { playerId: hostPlayerId, wager: 1000 });
  assert.equal(manager.stateFor('host-1', catalog).currentClue.dailyPlayerId, hostPlayerId);
  assert.throws(() => manager.buzz('host-1'), (error) => error.code === 'BUZZ_CLOSED');
  assert.throws(
    () => manager.scoreClue('host-1', { playerId: hostPlayerId, correct: true }),
    (error) => error.code === 'HOST_ATTEMPT_NOT_COMMITTED',
  );
  manager.openAnswerKey('host-1');
  const hostClue = manager.stateFor('host-1', catalog).currentClue;
  assert.equal(hostClue.hostKeyOutcome, 'committed');
  assert.equal(hostClue.expectedAnswer, location.clue.answer);
  assert.equal(Object.hasOwn(manager.stateFor('player-1', catalog).currentClue, 'expectedAnswer'), false);
  manager.scoreClue('host-1', { playerId: hostPlayerId, correct: true });
  assert.equal(manager.stateFor('host-1', catalog).you.score, 1000);
});

test('dual-role host moderates a remote Daily Double without changing roster eligibility', () => {
  const { catalog, first, games, manager, second } = setupRoom();
  manager.joinHostAsPlayer('host-1', { name: 'Alex' });
  const hostPlayerId = manager.stateFor('host-1', catalog).you.id;
  const location = locateClue(games[0], (clue) => clue.dailyDouble);
  manager.startGame('host-1', games[0].id);
  manager.openClue('host-1', location);
  manager.setDailyDouble('host-1', { playerId: first.playerId, wager: 400 });

  manager.openAnswerKey('host-1');
  const moderated = manager.stateFor('host-1', catalog).currentClue;
  assert.equal(moderated.hostKeyOutcome, 'moderator');
  assert.equal(moderated.ineligiblePlayerIds.includes(hostPlayerId), false);
  assert.equal(moderated.expectedAnswer, location.clue.answer);

  manager.leaveRoom('player-1');
  assert.throws(
    () => manager.setDailyDouble('host-1', { playerId: hostPlayerId, wager: 400 }),
    (error) => error.code === 'PLAYER_INELIGIBLE',
  );
  manager.setDailyDouble('host-1', { playerId: second.playerId, wager: 400 });
  manager.scoreClue('host-1', { playerId: second.playerId, correct: true });
  assert.equal(manager.stateFor('host-1', catalog).players.find((player) => player.id === second.playerId).score, 400);
});

test('rejects the wrong Daily Double contestant and safely reopens the wager if the selected player leaves', () => {
  const { catalog, first, games, manager, second } = setupRoom();
  const location = locateClue(games[0], (clue) => clue.dailyDouble);
  manager.startGame('host-1', games[0].id);
  manager.openClue('host-1', location);
  manager.setDailyDouble('host-1', { playerId: first.playerId, wager: 500 });

  assert.throws(
    () => manager.scoreClue('host-1', { playerId: second.playerId, correct: true }),
    (error) => error.code === 'WRONG_DAILY_PLAYER',
  );
  manager.leaveRoom('player-1');
  const reopened = manager.stateFor('host-1', catalog).currentClue;
  assert.equal(reopened.phase, 'daily-wager');
  assert.equal(reopened.dailyPlayerId, null);
  assert.equal(reopened.question, null);

  manager.setDailyDouble('host-1', { playerId: second.playerId, wager: 400 });
  manager.scoreClue('host-1', { playerId: second.playerId, correct: true });
  assert.equal(manager.stateFor('host-1', catalog).players[0].score, 400);
});

test('a revealed Daily Double closes if its selected contestant leaves', () => {
  const { catalog, first, games, manager } = setupRoom();
  const location = locateClue(games[0], (clue) => clue.dailyDouble);
  manager.startGame('host-1', games[0].id);
  manager.openClue('host-1', location);
  manager.setDailyDouble('host-1', { playerId: first.playerId, wager: 400 });
  manager.revealAnswer('host-1');
  manager.leaveRoom('player-1');

  const hostState = manager.stateFor('host-1', catalog);
  assert.equal(hostState.currentClue, null);
  assert.equal(hostState.game.categories[location.categoryIndex].clues[location.clueIndex].answered, true);
});

test('runs private Final Jeopardy wagers and responses through final standings', () => {
  const { catalog, first, games, manager, second } = setupRoom();
  manager.startGame('host-1', games[0].id);
  manager.adjustScore('host-1', { playerId: first.playerId, delta: 1200 });
  manager.adjustScore('host-1', { playerId: second.playerId, delta: 800 });
  manager.startFinal('host-1');

  manager.submitFinalWager('player-1', 1000);
  manager.submitFinalWager('player-2', 500);
  let hostState = manager.stateFor('host-1', catalog);
  assert.equal(hostState.final.phase, 'wager');
  assert.equal(Object.hasOwn(hostState.final.submissions[0], 'wager'), false);

  manager.advanceFinal('host-1');
  manager.submitFinalResponse('player-1', 'What is a test response?');
  manager.submitFinalResponse('player-2', 'What is another response?');
  hostState = manager.stateFor('host-1', catalog);
  assert.equal(hostState.final.phase, 'clue');
  assert.equal(Object.hasOwn(hostState.final.submissions[0], 'response'), false);
  assert.equal(manager.stateFor('player-1', catalog).final.answer, null);

  manager.advanceFinal('host-1');
  hostState = manager.stateFor('host-1', catalog);
  assert.equal(hostState.final.submissions[0].response, 'What is a test response?');
  assert.ok(hostState.final.answer);

  manager.scoreFinal('host-1', { playerId: first.playerId, correct: true });
  manager.scoreFinal('host-1', { playerId: second.playerId, correct: false });
  manager.finishFinal('host-1');
  hostState = manager.stateFor('host-1', catalog);
  assert.equal(hostState.final.phase, 'complete');
  assert.equal(hostState.players.find((player) => player.id === first.playerId).score, 2200);
  assert.equal(hostState.players.find((player) => player.id === second.playerId).score, 300);
});

test('host contestant can submit private Final Jeopardy entries while retaining judging controls', () => {
  const { catalog, first, games, manager } = setupRoom();
  manager.joinHostAsPlayer('host-1', { name: 'Alex' });
  const hostPlayerId = manager.stateFor('host-1', catalog).you.id;
  manager.startGame('host-1', games[0].id);
  manager.adjustScore('host-1', { playerId: hostPlayerId, delta: 1000 });
  manager.adjustScore('host-1', { playerId: first.playerId, delta: 800 });
  manager.startFinal('host-1');

  let hostState = manager.stateFor('host-1', catalog);
  assert.equal(hostState.final.eligible, true);
  assert.equal(hostState.final.yourMaxWager, 1000);
  assert.equal(hostState.final.yourWagerSubmitted, false);
  manager.adjustScore('host-1', { playerId: hostPlayerId, delta: 1000 });
  assert.throws(
    () => manager.submitFinalWager('host-1', 1001),
    (error) => error.code === 'INVALID_WAGER',
  );
  manager.adjustScore('host-1', { playerId: hostPlayerId, delta: -1000 });
  manager.submitFinalWager('host-1', 600);
  assert.throws(
    () => manager.submitFinalWager('host-1', 100),
    (error) => error.code === 'ALREADY_SUBMITTED',
  );
  manager.submitFinalWager('player-1', 500);
  hostState = manager.stateFor('host-1', catalog);
  assert.equal(hostState.final.yourWager, 600);
  assert.equal(hostState.final.yourWagerSubmitted, true);
  assert.equal(Object.hasOwn(hostState.final.submissions.find((entry) => entry.playerId === hostPlayerId), 'wager'), false);
  assert.equal(JSON.stringify(manager.stateFor('player-1', catalog).final).includes('600'), false);

  manager.advanceFinal('host-1', 'wager');
  manager.submitFinalResponse('host-1', 'What is the host response?');
  assert.throws(
    () => manager.submitFinalResponse('host-1', 'What is a replacement response?'),
    (error) => error.code === 'ALREADY_SUBMITTED',
  );
  manager.submitFinalResponse('player-1', 'What is the player response?');
  assert.equal(manager.stateFor('host-1', catalog).final.yourResponseSubmitted, true);
  assert.equal(JSON.stringify(manager.stateFor('player-1', catalog).final).includes('host response'), false);

  manager.advanceFinal('host-1', 'clue');
  hostState = manager.stateFor('host-1', catalog);
  assert.equal(hostState.final.submissions.find((entry) => entry.playerId === hostPlayerId).response, 'What is the host response?');
  manager.scoreFinal('host-1', { playerId: hostPlayerId, correct: true });
  manager.scoreFinal('host-1', { playerId: first.playerId, correct: false });
  manager.finishFinal('host-1');
  hostState = manager.stateFor('host-1', catalog);
  assert.equal(hostState.final.yourResult, true);
  assert.equal(hostState.you.score, 1600);
});

test('zero-score host contestant is excluded from Final Jeopardy', () => {
  const { catalog, first, games, manager } = setupRoom();
  manager.joinHostAsPlayer('host-1', { name: 'Alex' });
  manager.startGame('host-1', games[0].id);
  manager.adjustScore('host-1', { playerId: first.playerId, delta: 200 });
  manager.startFinal('host-1');

  const hostState = manager.stateFor('host-1', catalog);
  assert.equal(hostState.final.eligible, false);
  assert.equal(hostState.final.yourMaxWager, 0);
  assert.throws(
    () => manager.submitFinalWager('host-1', 0),
    (error) => error.code === 'NOT_ELIGIBLE',
  );
});

test('removing a remote finalist cannot remove the host contestant or deadlock Final', () => {
  const { catalog, first, games, manager, second } = setupRoom();
  manager.joinHostAsPlayer('host-1', { name: 'Alex' });
  const hostPlayerId = manager.stateFor('host-1', catalog).you.id;
  manager.startGame('host-1', games[0].id);
  manager.adjustScore('host-1', { playerId: hostPlayerId, delta: 600 });
  manager.adjustScore('host-1', { playerId: first.playerId, delta: 400 });
  manager.adjustScore('host-1', { playerId: second.playerId, delta: 200 });
  manager.startFinal('host-1');
  manager.advanceFinal('host-1', 'wager');
  manager.advanceFinal('host-1', 'clue');

  assert.throws(
    () => manager.removePlayer('host-1', hostPlayerId),
    (error) => error.code === 'CANNOT_REMOVE_HOST',
  );
  manager.scoreFinal('host-1', { playerId: hostPlayerId, correct: true });
  manager.scoreFinal('host-1', { playerId: first.playerId, correct: false });
  manager.removePlayer('host-1', second.playerId);
  assert.throws(() => manager.stateFor('player-2', catalog), (error) => error.code === 'NOT_IN_ROOM');
  manager.finishFinal('host-1');
  assert.equal(manager.stateFor('host-1', catalog).final.phase, 'complete');
});

test('Final Jeopardy excludes nonpositive scores, locks submissions, and rejects stale advances', () => {
  const { catalog, first, games, host, manager } = setupRoom();
  manager.startGame('host-1', games[0].id);
  manager.adjustScore('host-1', { playerId: first.playerId, delta: 500 });
  manager.startFinal('host-1');

  assert.equal(manager.stateFor('player-1', catalog).final.eligible, true);
  assert.equal(manager.stateFor('player-2', catalog).final.eligible, false);
  assert.throws(
    () => manager.joinRoom('late-player', { code: host.code, name: 'Latecomer' }),
    (error) => error.code === 'GAME_IN_FINAL',
  );
  assert.throws(() => manager.submitFinalWager('player-2', 0), (error) => error.code === 'NOT_ELIGIBLE');
  assert.throws(() => manager.submitFinalWager('player-1', 501), (error) => error.code === 'INVALID_WAGER');
  manager.submitFinalWager('player-1', 500);
  assert.throws(() => manager.submitFinalWager('player-1', 100), (error) => error.code === 'ALREADY_SUBMITTED');

  manager.advanceFinal('host-1', 'wager');
  assert.throws(() => manager.advanceFinal('host-1', 'wager'), (error) => error.code === 'STALE_ACTION');
  manager.submitFinalResponse('player-1', 'What is locked?');
  assert.throws(
    () => manager.submitFinalResponse('player-1', 'What is changed?'),
    (error) => error.code === 'ALREADY_SUBMITTED',
  );
});

test('cleanup retains connected rooms and expires only fully disconnected idle rooms', () => {
  const games = loadGames();
  let timestamp = 0;
  const manager = new RoomManager({ games, now: () => timestamp });
  const host = manager.createRoom('host-cleanup');
  manager.joinRoom('player-cleanup', { code: host.code, name: 'Maya' });

  timestamp = 20;
  assert.deepEqual(manager.cleanup(10), []);
  manager.disconnect('player-cleanup');
  manager.disconnect('host-cleanup');
  timestamp = 40;
  assert.deepEqual(manager.cleanup(10), [host.code]);
  assert.equal(manager.rooms.has(host.code), false);
});

test('rejects player attempts to use host actions', () => {
  const { games, manager } = setupRoom();
  assert.throws(
    () => manager.startGame('player-1', games[0].id),
    (error) => error.code === 'HOST_ONLY',
  );
  assert.throws(
    () => manager.joinHostAsPlayer('player-1', { name: 'Impostor' }),
    (error) => error.code === 'HOST_ONLY',
  );
  manager.startGame('host-1', games[0].id);
  const location = locateClue(games[0], (clue) => !clue.dailyDouble);
  manager.openClue('host-1', location);
  assert.throws(
    () => manager.openAnswerKey('player-1'),
    (error) => error.code === 'HOST_ONLY',
  );
  assert.throws(
    () => manager.buzz('host-1'),
    (error) => error.code === 'CONTESTANT_ONLY',
  );
});
