# Choose Your Own Ethics

An interactive choose-your-own-adventure about using AI ethically in school. Players get a good/bad decision score at the end and see how their answers to the real-world poll compare with everyone else's.

## Run it

Requires Docker Desktop.

```bash
docker compose up -d --build
```

- Game: http://localhost:3000
- Admin: http://localhost:3000/admin (default password `admin`)

To use a different admin password (recommended before presenting):

```bash
ADMIN_PASSWORD=something-secret docker compose up -d
```

Stop it with `docker compose down`. Stats are kept in `./data/stats.db` and survive restarts and rebuilds.

## Editing the story

Everything lives in [`story.json`](story.json), which is mounted into the container, so after an edit you only need to **refresh the page**. If the file has a broken link (a `next` pointing at a node that doesn't exist), the server will refuse to start and print which node is wrong (`docker compose logs`).

Node types:

| Kind | Fields | Flowchart equivalent |
|---|---|---|
| Text screen | `text`, `next` | Tan boxes, shown with a **Continue** button |
| Decision | `text`, `choices[]` | Tan question + green/red boxes |
| If-check | `branch[]`, `else` | Dark-blue boxes (invisible to the player) |
| Poll | `text`, `poll`, `choices[]` with `pollOption` | Purple "real-world poll" bubbles |
| Ending | `text`, `ending` | End of the game, which shows the score screen |

Each choice can have:
- `"score": "good"` or `"bad"`: counts toward the final score (green / red).
- `"inc": ["aiUses"]`: adds 1 to the AI-use counter, which the if-checks read.
- `"set": { "readingQuizAI": true }`: sets a flag.
- `"recap"`: the short line shown in the end-of-game decision list.

## Admin page

- Completed and total playthroughs, completion rate, average good/bad decisions
- Real-world poll results
- Which endings players reached and the score distribution
- Recent playthroughs (delete individual test runs)
- Export everything to CSV, remove unfinished runs, reset all stats
