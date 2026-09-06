'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');
const {
  ARCHIVE_PATH_ENV,
  ArchiveGameRepository,
  adaptArchiveEpisode,
  archiveGameId,
  clearArchiveMemoryCache,
  decodeArchive,
  loadArchiveRepository,
} = require('../lib/archive-game-source');
const { CLUE_VALUES } = require('../lib/game-store');

function questions({ round = 'jeopardy', missing = '', dailyDoubles } = {}) {
  const ddCoordinates = dailyDoubles === undefined
    ? (round === 'jeopardy' ? ['3:4'] : ['2:3', '5:5'])
    : dailyDoubles;
  const multiplier = round === 'double' ? 2 : 1;
  const output = [];
  for (let x = 1; x <= 6; x += 1) {
    for (let y = 1; y <= 5; y += 1) {
      if (`${x}:${y}` === missing) continue;
      output.push({
        x,
        y,
        q: `${round} clue ${x}-${y}`,
        a: `${round} answer ${x}-${y}`,
        cat: `${round.toUpperCase()} CATEGORY ${x}`,
        dd: ddCoordinates.includes(`${x}:${y}`),
        val: y * 200 * multiplier,
      });
    }
  }
  return output;
}

function episode({
  epNum = '9001',
  airDate = '2026-09-01',
  info = 'champions',
  jeopardy = questions(),
  double = questions({ round: 'double' }),
  final = [{ x: 1, y: 1, q: 'Final clue', a: 'Exact source answer', cat: 'FINAL CATEGORY', val: 0 }],
} = {}) {
  return { epNum, airDate, info, jeopardy, double, final };
}

function zipped(value) {
  return zlib.gzipSync(Buffer.from(JSON.stringify(value)));
}

test.beforeEach(() => clearArchiveMemoryCache());

test('maps a complete Jeopardy round first and preserves source answers and metadata', () => {
  const game = adaptArchiveEpisode('9001', episode(), { provider: 'user-supplied-test-data' });

  assert.ok(game);
  assert.equal(game.id, 'archive-9001');
  assert.equal(game.difficulty, 'Archive');
  assert.equal(game.source.provider, 'user-supplied-test-data');
  assert.equal(game.source.episodeNumber, '9001');
  assert.equal(game.source.airDate, '2026-09-01');
  assert.equal(game.source.info, 'champions');
  assert.equal(game.source.round, 'jeopardy');
  assert.equal(game.source.clueCount, 30);
  assert.deepEqual(game.source.missingClues, []);
  assert.equal(game.categories[0].clues[0].clue, 'jeopardy clue 1-1');
  assert.equal(game.categories[0].clues[0].answer, 'jeopardy answer 1-1');
  assert.equal(game.finalJeopardy.answer, 'Exact source answer');
  assert.deepEqual(game.categories[0].clues.map((clue) => clue.value), CLUE_VALUES);
  assert.equal(game.categories.flatMap((category) => category.clues).filter((clue) => clue.dailyDouble).length, 1);
});

test('maps the referenced 29-clue episode shape with a deterministic unavailable square', () => {
  const game = adaptArchiveEpisode('7866', episode({
    epNum: '7866',
    airDate: '2018-11-19',
    info: 'teen',
    jeopardy: questions({ missing: '2:5', dailyDoubles: ['3:3'] }),
  }));

  assert.ok(game);
  assert.equal(game.source.round, 'jeopardy');
  assert.equal(game.source.clueCount, 29);
  assert.deepEqual(game.source.missingClues, ['2:5']);
  assert.deepEqual(game.categories[1].clues[4], { value: 1000, unavailable: true });
  assert.equal(game.categories[2].clues[2].dailyDouble, true);
  assert.equal(game.description.includes('29/30 clues available'), true);
});

test('falls back to Double Jeopardy and selects one source Daily Double', () => {
  const source = episode({ jeopardy: questions({ dailyDoubles: [] }) });
  const game = adaptArchiveEpisode('9002', source);

  assert.ok(game);
  assert.equal(game.source.round, 'double');
  assert.equal(game.source.sourceDailyDoubleCount, 2);
  assert.equal(game.categories[1].clues[2].dailyDouble, true);
  assert.equal(game.categories[4].clues[4].dailyDouble, false);
  assert.equal(game.categories[1].clues[2].value, 600);
  assert.equal(game.categories[1].clues[2].answer, 'double answer 2-3');
});

test('rejects episodes without six discoverable columns, a usable Daily Double, or Final', () => {
  const fewerColumns = questions().filter((clue) => clue.x !== 6);
  assert.equal(adaptArchiveEpisode('bad', episode({ jeopardy: fewerColumns, double: [] })), null);
  assert.equal(adaptArchiveEpisode('bad', episode({ final: [] })), null);

  const duplicateCategories = questions();
  duplicateCategories.filter((clue) => clue.x === 6).forEach((clue) => { clue.cat = 'JEOPARDY CATEGORY 1'; });
  assert.equal(adaptArchiveEpisode('bad', episode({ jeopardy: duplicateCategories, double: [] })), null);
  assert.equal(adaptArchiveEpisode('bad', episode({ jeopardy: [...questions(), ...Array(31).fill(null)], double: [] })), null);
  assert.equal(adaptArchiveEpisode('bad', episode({ final: Array(21).fill(episode().final[0]) })), null);
  assert.equal(archiveGameId('../not-safe'), null);
});

test('rejects archive rounds with fewer than 24 usable clues', () => {
  const sparseMissing = new Set(['1:4', '1:5', '2:5', '3:5', '4:5', '5:5', '6:5']);
  const sparseRound = questions().filter((clue) => !sparseMissing.has(`${clue.x}:${clue.y}`));
  assert.equal(sparseRound.length, 23);
  assert.equal(adaptArchiveEpisode('sparse', episode({ jeopardy: sparseRound, double: [] })), null);

  const minimumRound = questions().filter((clue) => !['1:5', '2:5', '3:5', '4:5', '5:5', '6:5'].includes(`${clue.x}:${clue.y}`));
  assert.equal(minimumRound.length, 24);
  assert.ok(adaptArchiveEpisode('minimum', episode({ jeopardy: minimumRound, double: [] })));
});

test('repository returns searchable answer-free catalog pages and full games only by id', () => {
  const secretAnswer = 'DO NOT LEAK THIS ANSWER';
  const archive = {
    9000: episode({ epNum: '9000', airDate: '2025-01-01' }),
    9001: episode({
      epNum: '9001',
      airDate: '2026-01-01',
      jeopardy: questions().map((clue, index) => index === 0 ? { ...clue, a: secretAnswer } : clue),
    }),
    incomplete: episode({ jeopardy: [], double: [] }),
  };
  const repository = new ArchiveGameRepository(archive, { provider: 'fixture' });

  assert.equal(repository.episodeCount, 3);
  assert.equal(repository.playableCount, 2);
  const page = repository.listGames({ query: '2026', limit: 1 });
  assert.equal(page.total, 1);
  assert.equal(page.games[0].id, 'archive-9001');
  assert.equal(page.games[0].source.provider, 'fixture');
  assert.equal(page.games[0].source.round, 'jeopardy');
  assert.equal(JSON.stringify(page).includes(secretAnswer), false);
  assert.equal(JSON.stringify(page).includes('jeopardy clue 1-1'), false);
  assert.equal(repository.getGame('archive-9001').categories[0].clues[0].answer, secretAnswer);
  assert.equal(repository.getGameByEpisodeNumber('9001').id, 'archive-9001');
  assert.equal(repository.getGameByEpisodeNumber('missing'), null);
  assert.equal(repository.getGame('archive-incomplete'), null);
  assert.deepEqual(repository.listGames({ limit: 1 }).games.map((game) => game.id), ['archive-9001']);

  const crowdedArchive = { 2: episode({ epNum: '2', airDate: '1984-09-11' }) };
  for (let number = 100; number < 120; number += 1) {
    crowdedArchive[number] = episode({ epNum: String(number), airDate: `2026-02-${String(number - 99).padStart(2, '0')}` });
  }
  const crowdedRepository = new ArchiveGameRepository(crowdedArchive);
  assert.equal(crowdedRepository.listGames({ query: '2', limit: 1 }).games[0].source.episodeNumber, '2');
});

test('decodes a gzipped episode object and rejects malformed files', () => {
  const archive = { 9001: episode() };
  assert.equal(decodeArchive(zipped(archive))['9001'].epNum, '9001');
  assert.throws(() => decodeArchive(Buffer.from('not gzip')), (error) => error.code === 'INVALID_ARCHIVE');
  assert.throws(() => decodeArchive(zipped([])), (error) => error.code === 'INVALID_ARCHIVE');
});

test('loads only an explicitly configured local archive and reuses it from memory', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jeopardy-local-archive-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'archive.json.gz');
  fs.writeFileSync(filePath, zipped({ 9001: episode() }));

  const loaded = await loadArchiveRepository({
    env: { [ARCHIVE_PATH_ENV]: filePath },
    provider: 'local-fixture',
  });
  assert.equal(loaded.source, 'file');
  assert.equal(loaded.repository.playableCount, 1);
  assert.equal(loaded.repository.listGames().games[0].source.provider, 'local-fixture');

  const cached = await loadArchiveRepository({ filePath, provider: 'local-fixture' });
  assert.equal(cached.source, 'memory-cache');
  assert.equal(cached.repository, loaded.repository);
});

test('single-flights concurrent cold loads of the same archive', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jeopardy-local-concurrent-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'archive.json.gz');
  fs.writeFileSync(filePath, zipped({ 9001: episode() }));

  const loaded = await Promise.all([
    loadArchiveRepository({ filePath }),
    loadArchiveRepository({ filePath }),
    loadArchiveRepository({ filePath }),
  ]);

  assert.deepEqual(loaded.map((result) => result.source), ['file', 'file', 'file']);
  assert.equal(loaded[1].repository, loaded[0].repository);
  assert.equal(loaded[2].repository, loaded[0].repository);
});

test('does not keep serving a configured archive after the file becomes invalid', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jeopardy-local-stale-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'archive.json.gz');
  fs.writeFileSync(filePath, zipped({ 9001: episode() }));
  await loadArchiveRepository({ filePath });

  fs.writeFileSync(filePath, Buffer.from('broken source file'));
  await assert.rejects(
    loadArchiveRepository({ filePath }),
    (error) => error.code === 'INVALID_ARCHIVE',
  );
});

test('fails clearly when no local archive path is configured', async () => {
  await assert.rejects(
    loadArchiveRepository({ env: {} }),
    (error) => error.code === 'ARCHIVE_NOT_CONFIGURED' && error.message.includes(ARCHIVE_PATH_ENV),
  );
});
