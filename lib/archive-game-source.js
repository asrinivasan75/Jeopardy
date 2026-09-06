'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { CLUE_VALUES } = require('./game-store');

const ARCHIVE_PATH_ENV = 'JEOPARDY_ARCHIVE_PATH';
const DEFAULT_PROVIDER = 'local-archive';
const MAX_COMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 192 * 1024 * 1024;
const MAX_ROUND_RECORDS = 60;
const MAX_FINAL_RECORDS = 20;
const MIN_PLAYABLE_CLUES = 24;
const GAME_ID_PREFIX = 'archive-';
const memoryCache = new Map();
const inFlightLoads = new Map();

class ArchiveSourceError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ArchiveSourceError';
    this.code = code;
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function trimmedText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function metadataText(value, maxLength) {
  return trimmedText(value).replace(/\s+/g, ' ').slice(0, maxLength);
}

function archiveGameId(episodeKey) {
  const key = String(episodeKey ?? '');
  if (!/^[A-Za-z0-9_-]{1,56}$/.test(key)) return null;
  return `${GAME_ID_PREFIX}${key}`;
}

function inspectRound(questions, round) {
  if (!Array.isArray(questions) || questions.length > MAX_ROUND_RECORDS) return null;

  const coordinates = new Map();
  const categoriesByColumn = new Map();
  const seenCoordinates = new Set();
  const dailyDoubles = [];

  for (const question of questions) {
    if (!isRecord(question)) continue;
    const x = Number(question.x);
    const y = Number(question.y);
    if (!Number.isInteger(x) || x < 1 || x > 6 || !Number.isInteger(y) || y < 1 || y > 5) return null;
    const key = `${x}:${y}`;
    if (seenCoordinates.has(key)) return null;
    seenCoordinates.add(key);

    const category = trimmedText(question.cat);
    if (category) {
      if (category.length > 60) return null;
      const existingCategory = categoriesByColumn.get(x);
      if (existingCategory && existingCategory.toLocaleLowerCase('en-US') !== category.toLocaleLowerCase('en-US')) {
        return null;
      }
      categoriesByColumn.set(x, existingCategory || category);
    }

    const clue = trimmedText(question.q);
    const answer = trimmedText(question.a);
    if (!category || !clue || clue.length > 500 || !answer || answer.length > 240) continue;
    coordinates.set(key, question);
    if (question.dd === true) dailyDoubles.push(key);
  }

  const categories = Array.from({ length: 6 }, (_, index) => categoriesByColumn.get(index + 1) || '');
  if (categories.some((category) => !category)) return null;
  if (new Set(categories.map((name) => name.toLocaleLowerCase('en-US'))).size !== 6) return null;
  if (coordinates.size < MIN_PLAYABLE_CLUES) return null;
  if (dailyDoubles.length === 0) return null;
  if (round === 'jeopardy' && dailyDoubles.length !== 1) return null;
  dailyDoubles.sort((first, second) => {
    const [firstX, firstY] = first.split(':').map(Number);
    const [secondX, secondY] = second.split(':').map(Number);
    return firstX - secondX || firstY - secondY;
  });

  const missingClues = [];
  for (let x = 1; x <= 6; x += 1) {
    for (let y = 1; y <= 5; y += 1) {
      if (!coordinates.has(`${x}:${y}`)) missingClues.push(`${x}:${y}`);
    }
  }

  return {
    categories,
    coordinates,
    dailyDoubleKey: dailyDoubles[0],
    sourceDailyDoubleCount: dailyDoubles.length,
    clueCount: coordinates.size,
    missingClues,
  };
}

function inspectFinal(finalQuestions) {
  if (!Array.isArray(finalQuestions) || finalQuestions.length > MAX_FINAL_RECORDS) return null;
  const finalIndex = finalQuestions.findIndex((question) => {
    if (!isRecord(question)) return false;
    const category = trimmedText(question.cat);
    const clue = trimmedText(question.q);
    const answer = trimmedText(question.a);
    return category.length > 0 && category.length <= 80
      && clue.length > 0 && clue.length <= 500
      && answer.length > 0 && answer.length <= 240;
  });
  return finalIndex < 0 ? null : finalIndex;
}

function inspectArchiveEpisode(episodeKey, episode) {
  const id = archiveGameId(episodeKey);
  if (!id || !isRecord(episode)) return null;

  const finalIndex = inspectFinal(episode.final);
  if (finalIndex === null) return null;

  const jeopardy = inspectRound(episode.jeopardy, 'jeopardy');
  const double = jeopardy ? null : inspectRound(episode.double, 'double');
  const round = jeopardy ? 'jeopardy' : double ? 'double' : null;
  const roundInspection = jeopardy || double;
  if (!round || !roundInspection) return null;

  const episodeNumber = metadataText(episode.epNum, 30) || String(episodeKey);
  const airDate = metadataText(episode.airDate, 30);
  const info = metadataText(episode.info, 60);

  return {
    id,
    episodeKey: String(episodeKey),
    episodeNumber,
    airDate,
    info,
    round,
    finalIndex,
    categories: roundInspection.categories,
    dailyDoubleKey: roundInspection.dailyDoubleKey,
    sourceDailyDoubleCount: roundInspection.sourceDailyDoubleCount,
    clueCount: roundInspection.clueCount,
    missingClues: roundInspection.missingClues,
  };
}

function titleForEpisode(inspection) {
  const dateSuffix = inspection.airDate ? ` · ${inspection.airDate}` : '';
  return `Jeopardy! #${inspection.episodeNumber}${dateSuffix}`.slice(0, 80);
}

function descriptionForEpisode(inspection) {
  const roundLabel = inspection.round === 'double' ? 'Double Jeopardy!' : 'Jeopardy!';
  const eventLabel = inspection.info ? ` · ${inspection.info}` : '';
  const availability = inspection.missingClues.length
    ? ` · ${inspection.clueCount}/30 clues available`
    : '';
  return `Archived ${roundLabel} round from episode ${inspection.episodeNumber}${eventLabel}${availability}.`.slice(0, 180);
}

function sourceMetadata(inspection, provider) {
  return {
    provider,
    episodeKey: inspection.episodeKey,
    episodeNumber: inspection.episodeNumber,
    airDate: inspection.airDate,
    info: inspection.info,
    round: inspection.round,
    clueCount: inspection.clueCount,
    missingClues: [...inspection.missingClues],
  };
}

function safeCatalogEntry(inspection, provider) {
  return {
    id: inspection.id,
    title: titleForEpisode(inspection),
    description: descriptionForEpisode(inspection),
    difficulty: 'Archive',
    categories: [...inspection.categories],
    source: sourceMetadata(inspection, provider),
  };
}

function adaptArchiveEpisode(episodeKey, episode, { provider = DEFAULT_PROVIDER } = {}) {
  const inspection = inspectArchiveEpisode(episodeKey, episode);
  if (!inspection) return null;
  const roundInspection = inspectRound(episode[inspection.round], inspection.round);
  const finalQuestion = episode.final[inspection.finalIndex];

  const categories = inspection.categories.map((categoryName, categoryIndex) => ({
    name: categoryName,
    clues: CLUE_VALUES.map((value, clueIndex) => {
      const key = `${categoryIndex + 1}:${clueIndex + 1}`;
      const sourceQuestion = roundInspection.coordinates.get(key);
      if (!sourceQuestion) return { value, unavailable: true };
      return {
        value,
        clue: trimmedText(sourceQuestion.q),
        answer: trimmedText(sourceQuestion.a),
        dailyDouble: key === inspection.dailyDoubleKey,
      };
    }),
  }));

  return {
    id: inspection.id,
    title: titleForEpisode(inspection),
    description: descriptionForEpisode(inspection),
    difficulty: 'Archive',
    categories,
    finalJeopardy: {
      category: trimmedText(finalQuestion.cat),
      clue: trimmedText(finalQuestion.q),
      answer: trimmedText(finalQuestion.a),
    },
    source: {
      ...sourceMetadata(inspection, provider),
      sourceDailyDoubleCount: inspection.sourceDailyDoubleCount,
    },
  };
}

function compareArchiveEntries(first, second) {
  if (first.airDate !== second.airDate) return second.airDate.localeCompare(first.airDate);
  const firstNumber = Number(first.episodeNumber);
  const secondNumber = Number(second.episodeNumber);
  if (Number.isFinite(firstNumber) && Number.isFinite(secondNumber) && firstNumber !== secondNumber) {
    return secondNumber - firstNumber;
  }
  return second.episodeKey.localeCompare(first.episodeKey, 'en-US', { numeric: true });
}

class ArchiveGameRepository {
  #archive;
  #episodeCount;
  #index;
  #provider;

  constructor(archive, { provider = DEFAULT_PROVIDER } = {}) {
    if (!isRecord(archive) || Object.keys(archive).length === 0) {
      throw new ArchiveSourceError('INVALID_ARCHIVE', 'The archive must be a non-empty episode object.');
    }

    this.#archive = new Map();
    this.#episodeCount = Object.keys(archive).length;
    this.#provider = metadataText(provider, 80) || DEFAULT_PROVIDER;
    this.#index = [];
    for (const episodeKey of Object.keys(archive)) {
      const episode = archive[episodeKey];
      const inspection = inspectArchiveEpisode(episodeKey, episode);
      if (inspection) {
        const selectedRound = inspectRound(episode[inspection.round], inspection.round);
        this.#index.push(inspection);
        this.#archive.set(inspection.episodeKey, {
          epNum: episode.epNum,
          airDate: episode.airDate,
          info: episode.info,
          [inspection.round]: [...selectedRound.coordinates.values()],
          final: [episode.final[inspection.finalIndex]],
        });
      }
    }
    this.#index.sort(compareArchiveEntries);
  }

  get playableCount() {
    return this.#index.length;
  }

  get episodeCount() {
    return this.#episodeCount;
  }

  listGames({ query = '', offset = 0, limit = 50 } = {}) {
    const normalizedQuery = String(query).trim().toLocaleLowerCase('en-US');
    const parsedOffset = Number(offset);
    const parsedLimit = Number(limit);
    const safeOffset = Math.max(0, Number.isInteger(parsedOffset) ? parsedOffset : 0);
    const safeLimit = Math.min(100, Math.max(1, Number.isInteger(parsedLimit) ? parsedLimit : 50));
    const matching = normalizedQuery
      ? this.#index.filter((entry) => [
        entry.episodeKey,
        entry.episodeNumber,
        entry.airDate,
        entry.info,
        ...entry.categories,
      ].some((value) => value.toLocaleLowerCase('en-US').includes(normalizedQuery)))
      : this.#index;
    const ordered = normalizedQuery
      ? [
        ...matching.filter((entry) => [entry.episodeKey, entry.episodeNumber]
          .some((value) => value.toLocaleLowerCase('en-US') === normalizedQuery)),
        ...matching.filter((entry) => ![entry.episodeKey, entry.episodeNumber]
          .some((value) => value.toLocaleLowerCase('en-US') === normalizedQuery)),
      ]
      : matching;

    return {
      total: matching.length,
      offset: safeOffset,
      limit: safeLimit,
      games: ordered.slice(safeOffset, safeOffset + safeLimit)
        .map((entry) => safeCatalogEntry(entry, this.#provider)),
    };
  }

  getGame(gameId) {
    const inspection = this.#index.find((entry) => entry.id === gameId);
    return inspection
      ? adaptArchiveEpisode(inspection.episodeKey, this.#archive.get(inspection.episodeKey), { provider: this.#provider })
      : null;
  }

  getGameByEpisodeNumber(episodeNumber) {
    const normalizedNumber = String(episodeNumber ?? '').trim();
    if (!normalizedNumber) return null;
    const inspection = this.#index.find((entry) => entry.episodeNumber === normalizedNumber);
    return inspection
      ? adaptArchiveEpisode(inspection.episodeKey, this.#archive.get(inspection.episodeKey), { provider: this.#provider })
      : null;
  }
}

function decodeArchive(buffer) {
  if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) {
    throw new ArchiveSourceError('INVALID_ARCHIVE', 'The archive was not binary data.');
  }
  if (buffer.byteLength > MAX_COMPRESSED_BYTES) {
    throw new ArchiveSourceError('ARCHIVE_TOO_LARGE', 'The compressed archive exceeded the safe size limit.');
  }

  let decoded;
  try {
    decoded = zlib.gunzipSync(buffer, { maxOutputLength: MAX_UNCOMPRESSED_BYTES });
  } catch (error) {
    throw new ArchiveSourceError('INVALID_ARCHIVE', 'The archive could not be decompressed.', error);
  }

  let archive;
  try {
    archive = JSON.parse(decoded.toString('utf8'));
  } catch (error) {
    throw new ArchiveSourceError('INVALID_ARCHIVE', 'The archive was not valid JSON.', error);
  }
  if (!isRecord(archive) || Object.keys(archive).length === 0) {
    throw new ArchiveSourceError('INVALID_ARCHIVE', 'The archive must be a non-empty episode object.');
  }
  return archive;
}

async function statArchive(filePath) {
  let stats;
  try {
    stats = await fs.stat(filePath);
  } catch (error) {
    throw new ArchiveSourceError('ARCHIVE_READ_FAILED', `Could not read the configured archive file: ${filePath}`, error);
  }
  if (!stats.isFile()) {
    throw new ArchiveSourceError('ARCHIVE_READ_FAILED', `The configured archive path is not a file: ${filePath}`);
  }
  if (stats.size > MAX_COMPRESSED_BYTES) {
    throw new ArchiveSourceError('ARCHIVE_TOO_LARGE', 'The compressed archive exceeded the safe size limit.');
  }
  return stats;
}

async function readStableArchive(filePath, initialStats = null) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = attempt === 0 && initialStats ? initialStats : await statArchive(filePath);

    let buffer;
    let after;
    try {
      buffer = await fs.readFile(filePath);
      after = await statArchive(filePath);
    } catch (error) {
      throw new ArchiveSourceError('ARCHIVE_READ_FAILED', `Could not read the configured archive file: ${filePath}`, error);
    }
    if (before.size === after.size && before.mtimeMs === after.mtimeMs) {
      return { buffer, size: after.size, modifiedAt: after.mtimeMs };
    }
  }
  throw new ArchiveSourceError('ARCHIVE_CHANGED', 'The archive file changed while it was being read. Try again.');
}

function configuredArchivePath({ filePath, env = process.env } = {}) {
  const configured = trimmedText(filePath) || trimmedText(env?.[ARCHIVE_PATH_ENV]);
  if (!configured) {
    throw new ArchiveSourceError(
      'ARCHIVE_NOT_CONFIGURED',
      `Set ${ARCHIVE_PATH_ENV} to a locally supplied .json.gz archive file.`,
    );
  }
  return path.resolve(configured);
}

async function loadArchiveRepository({
  filePath,
  env = process.env,
  provider = DEFAULT_PROVIDER,
  useMemoryCache = true,
} = {}) {
  const resolvedPath = configuredArchivePath({ filePath, env });
  const normalizedProvider = metadataText(provider, 80) || DEFAULT_PROVIDER;
  const cacheKey = `${resolvedPath}\u0000${normalizedProvider}`;
  const previous = memoryCache.get(cacheKey) || null;

  const load = async () => {
    const stats = await statArchive(resolvedPath);
    if (useMemoryCache && previous
      && previous.size === stats.size
      && previous.modifiedAt === stats.mtimeMs) {
      return {
        repository: previous.repository,
        source: 'memory-cache',
        stale: false,
        warning: null,
        filePath: resolvedPath,
      };
    }

    const source = await readStableArchive(resolvedPath, stats);
    const archive = decodeArchive(source.buffer);
    const repository = new ArchiveGameRepository(archive, { provider: normalizedProvider });
    if (useMemoryCache) {
      memoryCache.set(cacheKey, {
        repository,
        size: source.size,
        modifiedAt: source.modifiedAt,
      });
    }
    return {
      repository,
      source: 'file',
      stale: false,
      warning: null,
      filePath: resolvedPath,
    };
  };

  if (!useMemoryCache) return load();
  const inFlight = inFlightLoads.get(cacheKey);
  if (inFlight) return inFlight;

  const currentLoad = load();
  inFlightLoads.set(cacheKey, currentLoad);
  try {
    return await currentLoad;
  } finally {
    if (inFlightLoads.get(cacheKey) === currentLoad) inFlightLoads.delete(cacheKey);
  }
}

function clearArchiveMemoryCache() {
  memoryCache.clear();
  inFlightLoads.clear();
}

module.exports = {
  ARCHIVE_PATH_ENV,
  ArchiveGameRepository,
  ArchiveSourceError,
  DEFAULT_PROVIDER,
  adaptArchiveEpisode,
  archiveGameId,
  clearArchiveMemoryCache,
  configuredArchivePath,
  decodeArchive,
  inspectArchiveEpisode,
  loadArchiveRepository,
};
