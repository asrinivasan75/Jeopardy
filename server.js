'use strict';

const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { Server } = require('socket.io');
const {
  ARCHIVE_PATH_ENV,
  ArchiveSourceError,
  loadArchiveRepository,
} = require('./lib/archive-game-source');
const { catalogGames, loadGames, validateGame } = require('./lib/game-store');
const { RoomError, RoomManager } = require('./lib/room-manager');

const ROOT = __dirname;

function createJeopardyServer({
  games = loadGames(),
  logger = console,
  archiveFilePath = process.env[ARCHIVE_PATH_ENV],
  archiveProvider = 'jeopardy.app-compatible local archive',
  archiveLoader = loadArchiveRepository,
} = {}) {
  const app = express();
  const httpServer = http.createServer(app);
  const io = new Server(httpServer, {
    serveClient: true,
    transports: ['websocket', 'polling'],
  });
  const gameCatalog = catalogGames(games);
  const rooms = new RoomManager({ games });
  const archiveConfigured = typeof archiveFilePath === 'string' && archiveFilePath.trim().length > 0;

  async function loadConfiguredArchive() {
    if (!archiveConfigured) {
      throw new ArchiveSourceError(
        'ARCHIVE_NOT_CONFIGURED',
        `Set ${ARCHIVE_PATH_ENV} to a compatible .json.gz archive that you are authorized to use.`,
      );
    }
    return archiveLoader({ filePath: archiveFilePath, provider: archiveProvider });
  }

  function archiveStatusPayload(loaded = null, error = null) {
    const repository = loaded?.repository;
    return {
      configured: archiveConfigured,
      loaded: Boolean(repository),
      episodes: repository?.episodeCount || 0,
      playableEpisodes: repository?.playableCount || 0,
      sourceLabel: 'Local Jeopardy.app-compatible archive',
      message: error?.code === 'ARCHIVE_NOT_CONFIGURED'
        ? error.message
        : error
          ? 'The configured archive could not be loaded. Check the server terminal for details.'
          : repository
            ? 'Archive ready. Imported clues remain on this server and answers stay private.'
            : `Set ${ARCHIVE_PATH_ENV} to enable archive search.`,
    };
  }

  function archiveSearchEntry(game) {
    const source = game.source || {};
    return {
      ...game,
      episodeNumber: source.episodeNumber || source.episodeKey || '',
      airDate: source.airDate || '',
      special: source.info || '',
      clueCount: source.clueCount || 0,
      missingClues: Array.isArray(source.missingClues) ? source.missingClues.length : 0,
    };
  }

  app.disable('x-powered-by');
  app.get('/health', (_request, response) => {
    response.json({ ok: true, games: games.length, rooms: rooms.rooms.size });
  });
  app.get('/api/network', (request, response) => {
    response.json({ urls: localNetworkUrls(request.socket.localPort) });
  });
  app.get('/api/games', (_request, response) => response.json(gameCatalog));
  app.get('/api/archive/status', async (_request, response) => {
    if (!archiveConfigured) {
      const error = new ArchiveSourceError(
        'ARCHIVE_NOT_CONFIGURED',
        `Set ${ARCHIVE_PATH_ENV} to a compatible .json.gz archive that you are authorized to use.`,
      );
      response.json(archiveStatusPayload(null, error));
      return;
    }
    try {
      const loaded = await loadConfiguredArchive();
      response.json(archiveStatusPayload(loaded));
    } catch (error) {
      logger.error(error);
      response.json(archiveStatusPayload(null, error));
    }
  });
  app.get('/api/archive/search', async (request, response) => {
    try {
      const loaded = await loadConfiguredArchive();
      const query = String(request.query.q || '').trim().slice(0, 100);
      const requestedLimit = Number.parseInt(request.query.limit, 10);
      const limit = Number.isInteger(requestedLimit) ? Math.min(50, Math.max(1, requestedLimit)) : 12;
      const result = loaded.repository.listGames({ query, limit });
      response.json({
        query,
        total: result.total,
        results: result.games.map(archiveSearchEntry),
      });
    } catch (error) {
      if (!(error instanceof ArchiveSourceError)) logger.error(error);
      const status = error?.code === 'ARCHIVE_NOT_CONFIGURED' ? 409 : 503;
      response.status(status).json({
        error: {
          code: error?.code || 'ARCHIVE_UNAVAILABLE',
          message: error?.code === 'ARCHIVE_NOT_CONFIGURED'
            ? error.message
            : 'The configured archive could not be loaded.',
        },
      });
    }
  });
  app.get(['/', '/index.html'], (_request, response) => response.sendFile(path.join(ROOT, 'index.html')));
  app.get('/app.js', (_request, response) => response.sendFile(path.join(ROOT, 'app.js')));
  app.get('/style.css', (_request, response) => response.sendFile(path.join(ROOT, 'style.css')));
  app.get('/favicon.ico', (_request, response) => response.status(204).end());
  app.use((_request, response) => response.status(404).json({ error: 'Not found' }));

  function sendError(socket, error, acknowledge) {
    const roomError = error instanceof RoomError
      ? error
      : error instanceof ArchiveSourceError
        ? new RoomError(
          error.code,
          error.code === 'ARCHIVE_NOT_CONFIGURED'
            ? error.message
            : 'The configured archive could not be loaded. Check the server terminal for details.',
        )
        : new RoomError('SERVER_ERROR', 'The server could not complete that action.');
    if (!(error instanceof RoomError)) logger.error(error);
    if (typeof acknowledge === 'function') {
      acknowledge({ ok: false, error: { code: roomError.code, message: roomError.message } });
    } else {
      socket.emit('room:error', { code: roomError.code, message: roomError.message });
    }
  }

  function stateForSocket(socket) {
    const roomCatalog = [
      ...gameCatalog,
      ...catalogGames(rooms.importedGamesForSocket(socket.id)),
    ];
    return rooms.stateFor(socket.id, roomCatalog);
  }

  async function broadcastRoom(code) {
    if (!code || !rooms.rooms.has(code)) return;
    const sockets = await io.in(code).fetchSockets();
    for (const socket of sockets) {
      if (rooms.roomCodeForSocket(socket.id) !== code) continue;
      socket.emit('room:state', stateForSocket(socket));
    }
  }

  function registerMutation(socket, eventName, mutate) {
    socket.on(eventName, async (payload = {}, acknowledge) => {
      try {
        const result = await mutate(payload);
        const code = typeof result === 'string' ? result : result?.code;
        await broadcastRoom(code);
        if (typeof acknowledge === 'function') acknowledge({ ok: true });
      } catch (error) {
        sendError(socket, error, acknowledge);
      }
    });
  }

  io.on('connection', (socket) => {
    socket.on('room:create', async (_payload = {}, acknowledge) => {
      try {
        const session = rooms.createRoom(socket.id);
        await socket.join(session.code);
        const state = stateForSocket(socket);
        acknowledge?.({ ok: true, session, state });
      } catch (error) {
        sendError(socket, error, acknowledge);
      }
    });

    socket.on('room:join', async (payload = {}, acknowledge) => {
      try {
        const session = rooms.joinRoom(socket.id, payload);
        await socket.join(session.code);
        const state = stateForSocket(socket);
        acknowledge?.({ ok: true, session, state });
        await broadcastRoom(session.code);
      } catch (error) {
        sendError(socket, error, acknowledge);
      }
    });

    socket.on('room:resume', async (payload = {}, acknowledge) => {
      try {
        const resumedSession = rooms.resumeRoom(socket.id, payload);
        const { replacedSocketId, ...session } = resumedSession;
        if (replacedSocketId && replacedSocketId !== socket.id) {
          const replacedSocket = io.sockets.sockets.get(replacedSocketId);
          replacedSocket?.emit('room:replaced', { message: 'This room was resumed in another tab or device.' });
          await replacedSocket?.leave(session.code);
          replacedSocket?.disconnect(true);
        }
        await socket.join(session.code);
        const state = stateForSocket(socket);
        acknowledge?.({ ok: true, session, state });
        await broadcastRoom(session.code);
      } catch (error) {
        sendError(socket, error, acknowledge);
      }
    });

    socket.on('room:leave', async (_payload = {}, acknowledge) => {
      try {
        const result = rooms.leaveRoom(socket.id);
        if (result.closed) {
          io.to(result.code).emit('room:closed', { message: 'The host ended this room.' });
          io.in(result.code).socketsLeave(result.code);
        } else {
          await socket.leave(result.code);
          await broadcastRoom(result.code);
        }
        acknowledge?.({ ok: true });
      } catch (error) {
        sendError(socket, error, acknowledge);
      }
    });

    socket.on('room:close', async (_payload = {}, acknowledge) => {
      try {
        const result = rooms.closeRoom(socket.id);
        io.to(result.code).emit('room:closed', { message: 'The host ended this room.' });
        io.in(result.code).socketsLeave(result.code);
        acknowledge?.({ ok: true });
      } catch (error) {
        sendError(socket, error, acknowledge);
      }
    });

    registerMutation(socket, 'host:start-game', ({ gameId }) => rooms.startGame(socket.id, gameId));
    registerMutation(socket, 'host:join-as-player', ({ name }) => rooms.joinHostAsPlayer(socket.id, { name }));
    registerMutation(socket, 'host:leave-as-player', () => rooms.leaveHostAsPlayer(socket.id));
    registerMutation(socket, 'host:open-clue', (payload) => rooms.openClue(socket.id, payload));
    registerMutation(socket, 'host:set-daily-double', (payload) => rooms.setDailyDouble(socket.id, payload));
    registerMutation(socket, 'host:reset-buzzers', () => rooms.resetBuzzers(socket.id));
    registerMutation(socket, 'host:open-answer-key', () => rooms.openAnswerKey(socket.id));
    registerMutation(socket, 'host:reveal-answer', () => rooms.revealAnswer(socket.id));
    registerMutation(socket, 'host:score-clue', (payload) => rooms.scoreClue(socket.id, payload));
    registerMutation(socket, 'host:skip-clue', () => rooms.skipClue(socket.id));
    registerMutation(socket, 'host:adjust-score', (payload) => rooms.adjustScore(socket.id, payload));
    registerMutation(socket, 'host:reset-game', () => rooms.resetGame(socket.id));
    registerMutation(socket, 'host:return-lobby', () => rooms.returnToLobby(socket.id));
    registerMutation(socket, 'host:start-final', () => rooms.startFinal(socket.id));
    registerMutation(socket, 'host:advance-final', ({ phase }) => rooms.advanceFinal(socket.id, phase));
    registerMutation(socket, 'host:score-final', (payload) => rooms.scoreFinal(socket.id, payload));
    registerMutation(socket, 'host:finish-final', () => rooms.finishFinal(socket.id));
    registerMutation(socket, 'player:buzz', () => rooms.buzz(socket.id));
    registerMutation(socket, 'player:final-wager', ({ wager }) => rooms.submitFinalWager(socket.id, wager));
    registerMutation(socket, 'player:final-response', ({ response }) => rooms.submitFinalResponse(socket.id, response));

    socket.on('host:import-archive', async (payload = {}, acknowledge) => {
      try {
        const actorState = stateForSocket(socket);
        if (actorState.role !== 'host') throw new RoomError('HOST_ONLY', 'Only the host can import an archive game.');
        if (actorState.phase !== 'lobby') throw new RoomError('LOBBY_ONLY', 'Archive games can be added only from the lobby.');

        const requestedId = String(payload.gameId || '').trim().slice(0, 64);
        const episodeNumber = String(payload.episodeNumber || '').trim().slice(0, 30);
        if (!requestedId && !episodeNumber) throw new RoomError('INVALID_EPISODE', 'Choose a valid archive episode.');

        const loaded = await loadConfiguredArchive();
        const game = requestedId
          ? loaded.repository.getGame(requestedId)
          : loaded.repository.getGameByEpisodeNumber(episodeNumber);
        if (!game) throw new RoomError('EPISODE_NOT_FOUND', 'That episode is not playable in the configured archive.');
        const validationErrors = validateGame(game, requestedId || `episode-${episodeNumber}`);
        if (validationErrors.length > 0) {
          logger.error(new Error(`Archive game validation failed:\n- ${validationErrors.join('\n- ')}`));
          throw new RoomError('INVALID_ARCHIVE_GAME', 'That archived episode could not be converted safely.');
        }

        const result = rooms.addGameForHost(socket.id, game);
        const catalogEntry = catalogGames([result.game])[0];
        await broadcastRoom(result.code);
        acknowledge?.({ ok: true, game: catalogEntry });
      } catch (error) {
        sendError(socket, error, acknowledge);
      }
    });

    socket.on('host:remove-player', async ({ playerId } = {}, acknowledge) => {
      try {
        const result = rooms.removePlayer(socket.id, playerId);
        if (result.removedSocketId) {
          const removedSocket = io.sockets.sockets.get(result.removedSocketId);
          removedSocket?.emit('room:removed', { message: 'The host removed you from the room.' });
          await removedSocket?.leave(result.code);
        }
        await broadcastRoom(result.code);
        acknowledge?.({ ok: true });
      } catch (error) {
        sendError(socket, error, acknowledge);
      }
    });

    socket.on('disconnect', () => {
      const code = rooms.disconnect(socket.id);
      if (code) void broadcastRoom(code);
    });
  });

  const cleanupTimer = setInterval(() => {
    const removedCodes = rooms.cleanup();
    for (const code of removedCodes) {
      io.to(code).emit('room:closed', { message: 'This room expired after a long period of inactivity.' });
      io.in(code).socketsLeave(code);
    }
  }, 30 * 60 * 1000);
  cleanupTimer.unref();

  return {
    app,
    gameCatalog,
    games,
    httpServer,
    io,
    rooms,
    async start(port = 3000, host = '0.0.0.0') {
      await new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, host, () => {
          httpServer.off('error', reject);
          resolve();
        });
      });
      return httpServer.address();
    },
    async stop() {
      clearInterval(cleanupTimer);
      await new Promise((resolve) => io.close(resolve));
      if (httpServer.listening) await new Promise((resolve) => httpServer.close(resolve));
    },
  };
}

function localNetworkUrls(port) {
  const urls = [`http://localhost:${port}`];
  const seen = new Set();
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family !== 'IPv4' || address.internal || seen.has(address.address)) continue;
      seen.add(address.address);
      urls.push(`http://${address.address}:${port}`);
    }
  }
  return urls;
}

if (require.main === module) {
  const port = Number.parseInt(process.env.PORT || '3000', 10);
  const host = process.env.HOST || '0.0.0.0';
  const jeopardy = createJeopardyServer();
  jeopardy.start(port, host).then((address) => {
    const actualPort = typeof address === 'object' ? address.port : port;
    console.log('\nJeopardy multiplayer is live.');
    console.log('Open one of these addresses:');
    localNetworkUrls(actualPort).forEach((url) => console.log(`  ${url}`));
    console.log('\nPlayers on the same Wi-Fi should use the local-network address.\n');
  }).catch((error) => {
    console.error('Could not start Jeopardy:', error.message);
    process.exitCode = 1;
  });

  const shutdown = async () => {
    await jeopardy.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = {
  createJeopardyServer,
  localNetworkUrls,
};
