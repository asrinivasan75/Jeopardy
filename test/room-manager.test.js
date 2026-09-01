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

test('keeps answers private, orders buzzes, and reopens after an incorrect response', () => {
  const { catalog, first, games, manager, second } = setupRoom();
  const game = games[0];
  const location = locateClue(game, (clue) => !clue.dailyDouble);
  manager.startGame('host-1', game.id);
  manager.openClue('host-1', location);

  const hostState = manager.stateFor('host-1', catalog);
  const playerState = manager.stateFor('player-1', catalog);
  assert.equal(hostState.currentClue.expectedAnswer, location.clue.answer);
  assert.equal(playerState.currentClue.answer, null);
  assert.equal(Object.hasOwn(playerState.currentClue, 'expectedAnswer'), false);
  assert.equal(JSON.stringify(playerState.game).includes(location.clue.clue), false);

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

  manager.scoreClue('host-1', { playerId: first.playerId, correct: false });
  assert.equal(manager.stateFor('host-1', catalog).players.find((player) => player.id === first.playerId).score, -600);
  assert.equal(manager.stateFor('host-1', catalog).currentClue, null);
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
});
