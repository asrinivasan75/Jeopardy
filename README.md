# Jeopardy! Local Multiplayer

A live, browser-based Jeopardy-style game built for game nights, classrooms, and friendly competitions. One person hosts the board on a computer and can also play, while up to eight total contestants join from the host screen, phones, or laptops over the same local network.

The game includes 20 original, medium-difficulty boards with 600 regular clues, 20 Daily Doubles, and 20 Final Jeopardy clues.

## What it does

- Creates a private five-character room code for each game
- Keeps the board, clues, buzz order, and scores synchronized across every device
- Lets players use their phone as a low-latency buzzer
- Lets the host take a contestant spot, buzz, play Daily Doubles, and enter Final Jeopardy without giving up moderator controls
- Uses a compact, Lichess-inspired lobby for browsing and selecting boards
- Keeps every answer hidden until the host deliberately opens the private key or reveals it to the room
- Reopens buzzing after an incorrect response while locking out that player for the clue
- Supports host-assigned Daily Double contestants and wagers
- Runs private Final Jeopardy wagers and written responses before the host judges them
- Restores host and player sessions after an ordinary Wi-Fi interruption
- Includes 20 varied games spanning history, science, geography, sports, film, music, literature, food, nature, technology, mythology, architecture, and more

## Requirements

- [Node.js](https://nodejs.org/) 20 or newer
- All participating devices connected to the same local network or Wi-Fi

## Start the server

```bash
git clone https://github.com/asrinivasan75/Jeopardy.git
cd Jeopardy
npm install
npm start
```

The server listens on port `3000` and prints addresses similar to these:

```text
Jeopardy multiplayer is live.
Open one of these addresses:
  http://localhost:3000
  http://192.168.1.42:3000
```

Open either address on the host computer. Players must use the `192.168.x.x`-style local-network address—not `localhost`—because `localhost` always points back to the device currently holding it.

To use a different port:

```bash
PORT=8080 npm start
```

## Host a game

1. Open the server address and select **Create lobby game**, or choose a board directly from the lobby list.
2. To compete too, enter your name under **Play while you host** and select **Play too**. The host counts as one of the eight contestant spots.
3. Share the player link or the five-character room code.
4. Wait for players to appear in the contestant list, then choose one of the 20 games.
5. Select clues, watch the buzz order, and mark responses correct or incorrect.
6. Use **Final Jeopardy** when the board is complete—or whenever you are ready to finish.

The host can adjust scores manually, reset buzzers, close unanswered clues, remove players, reset the board, or return to the game library.

### Answer privacy when the host plays

Answers never appear automatically. If the host buzzes first, **Lock my response & view key** commits the host's spoken response before showing the private key. If another contestant buzzes first, **Sit out this clue & view key** removes the host from that clue before opening the key, so the remaining buzz queue stays fair. The key is intended for a private host screen; use **Reveal response** when everyone should see it.

A host who does not join the contestant roster gets an **Open host key** control for judging. It is still closed by default, which keeps the main screen clean and prevents accidental answer reveals.

## Join as a player

1. Open the host's local-network address on a phone or laptop.
2. Enter the room code and a display name.
3. Keep the page open while the host chooses a game.
4. When a clue appears, press the large red buzzer. The host sees everyone in server-received order.
5. Players with a positive score can submit a private Final Jeopardy wager and response from their device.

## How multiplayer works

```text
Host browser ─┐
Player phones ├── Socket.IO ── Node.js room server ── 20-game question bank
Player laptop ┘                     │
                                    └── authoritative scores and game state
```

The server is authoritative: browsers send actions, and the server validates them before broadcasting a role-specific state update. Players do not receive hidden clue responses, Final Jeopardy wagers, or other players' written responses before the host reveals them.

Rooms live in memory. A fully disconnected room expires after 12 hours of inactivity, while a room with at least one connected device remains active. Stopping the Node.js process ends all rooms; scores and progress are intentionally not written to disk.

## Question bank

The replacement bank lives in [`data/games`](data/games). Each JSON file contains an array of games. A game requires exactly six categories, five clues per category, one Daily Double, and one Final Jeopardy clue. This abbreviated example shows the object shape:

```json
{
  "id": "game-example",
  "title": "Example Game",
  "description": "A balanced mix of familiar subjects.",
  "difficulty": "Medium",
  "categories": [
    {
      "name": "SCIENCE",
      "clues": [
        {
          "value": 200,
          "clue": "This planet is known as the Red Planet.",
          "answer": "What is Mars?",
          "dailyDouble": true
        }
      ]
    }
  ],
  "finalJeopardy": {
    "category": "SPACE",
    "clue": "This is the largest planet in our solar system.",
    "answer": "What is Jupiter?"
  }
}
```

The server validates the complete bank at startup and refuses to launch if a file is malformed, an ID or title is duplicated, a category is incomplete, clue values are out of order, or a game does not contain exactly one Daily Double.

## Development

```bash
npm run dev    # restart automatically when server files change
npm run check  # syntax-check the server and browser JavaScript
npm test       # run game-bank, room-engine, privacy, and socket integration tests
```

See the [changelog](CHANGELOG.md) for release history.

## Project structure

| Path | Purpose |
| --- | --- |
| `server.js` | HTTP server, Socket.IO events, room broadcasts, and local-network addresses |
| `lib/room-manager.js` | Authoritative room, buzzer, scoring, Daily Double, and Final Jeopardy rules |
| `lib/game-store.js` | Question-bank loading and validation |
| `data/games/*.json` | The 20-game replacement question bank |
| `index.html` | Host and player application shell |
| `app.js` | Synchronized host/player rendering and controls |
| `style.css` | Responsive lobby, board, buzzer, and Final Jeopardy design |
| `test/` | Unit and multi-client integration tests |

## Local-network troubleshooting

- Make sure every device is connected to the same Wi-Fi network.
- Share the address beginning with your computer's local IP, such as `192.168.1.42`, rather than `localhost`.
- Allow incoming Node.js connections if macOS or Windows shows a firewall prompt.
- Guest Wi-Fi and some corporate or school networks block devices from talking to each other. Use a normal home network or a phone hotspot if players cannot connect.
- Keep the terminal running for the entire game.

This server is intended for a trusted local network. The room code is convenient game-night access, not production-grade authentication; do not expose the server directly to the public internet.

## Disclaimer

This is an unofficial fan-made project and is not affiliated with or endorsed by Jeopardy Productions, Inc. or Sony Pictures Television.
