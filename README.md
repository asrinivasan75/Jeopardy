# Jeopardy!

A browser-based Jeopardy-style trivia game for hosting game nights, classrooms, and friendly competitions. It ships with 62 ready-to-play games and 1,889 clues, while also letting you build and import your own boards.

## Features

- 62 bundled sample games across sports, travel, history, science, pop culture, food, and more
- Live scoring for one to eight teams, including quick score adjustments
- Clue reveals with correct and incorrect scoring controls
- Final Jeopardy wagers and per-team results
- A built-in editor for creating and updating custom six-category games
- JSON import and export for individual games or the complete collection
- Automatic browser storage for custom games, scores, and board progress
- Keyboard controls for faster hosting
- Responsive layout for desktop and smaller screens

## Run locally

No installation, build step, or package manager is required.

1. Clone the repository:

   ```bash
   git clone https://github.com/asrinivasan75/Jeopardy.git
   cd Jeopardy
   ```

2. Start a local web server:

   ```bash
   python3 -m http.server 8000
   ```

3. Open [http://localhost:8000](http://localhost:8000) in your browser.

You can also open `index.html` directly, although a local server provides behavior closer to a deployed website.

## How to play

1. Select one of the sample games or create a custom game.
2. Rename teams, add or remove teams, and adjust starting scores if needed.
3. Choose a clue, reveal its response, and award or deduct points.
4. Continue until the board is complete, then select **Final Jeopardy** for wagers and final scoring.
5. Use **Reset** to start that game again with a fresh board and scores.

Progress is saved in the browser automatically. Returning to the same game restores its answered clues, teams, and scores when the board structure has not changed.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `?` | Open or close keyboard help |
| `Space` | Reveal the response for the current clue |
| `1`–`9` | Award the clue value to the corresponding team |
| `Shift` + `1`–`9` | Deduct the clue value from the corresponding team |
| `Esc` | Close the active clue or dialog |

Scoring shortcuts work after the response has been revealed.

## Custom game format

Games can be created in the built-in editor or imported as JSON. Imports accept up to six categories and five clues per category; shorter games are padded to fit the standard board.

```json
{
  "title": "Example Game",
  "description": "An optional description",
  "difficulty": "Custom",
  "categories": [
    {
      "name": "SCIENCE",
      "clues": [
        {
          "value": 200,
          "clue": "This planet is known as the Red Planet.",
          "answer": "What is Mars?"
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

Only `title` and a non-empty `categories` array are required. Missing clue values default to `$200`, `$400`, `$600`, `$800`, and `$1,000` by row.

## Project structure

| File | Purpose |
| --- | --- |
| `index.html` | Application screens, dialogs, and controls |
| `style.css` | Visual design and responsive layout |
| `app.js` | Game state, scoring, builder, import/export, and keyboard behavior |
| `games.js` | Bundled sample game data |
| `games.js.bak*` | Historical working copies of the sample game data |

## Data and privacy

The app has no backend. Custom games and active game state are stored only in the browser's `localStorage`. Clearing site data removes that saved state, so export important custom games before clearing browser storage or moving to another device.

## Disclaimer

This is an unofficial fan-made project and is not affiliated with or endorsed by Jeopardy Productions, Inc. or Sony Pictures Television.
