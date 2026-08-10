# Todo App — built by an autonomous SME team

A small, **zero-dependency** todo app (Node.js `node:http` REST API + vanilla-JS UI + `node:test` tests). It was produced by RelayForge’s team loop: planner decomposes the brief, backend/frontend implement in isolated worktrees, QA reviews before integration.

This is a real `relayforge run` artifact shape, not a hand-written marketing mock.

<p align="center">
  <img src="../../assets/todo-app.png" alt="RelayForge Todo running with sample tasks" width="520">
</p>

## Run it

```bash
cd examples/todo-app
npm start            # http://localhost:3000  (or PORT=3456 npm start)
npm test             # node:test store + API
```

Open the URL, add / complete / delete todos.

## What's inside

| File | Built by | What it is |
|------|----------|------------|
| `store.js` | Backend SME | In-memory todo store: `list / add / toggle / delete` |
| `server.js` | Backend SME | `node:http` server: `GET/POST /api/todos`, `POST /api/todos/:id/toggle`, `DELETE /api/todos/:id`, serves `index.html` |
| `index.html` | Frontend SME | Vanilla-JS UI talking to the API |
| `store.test.js`, `server.test.js` | QA / CT | `node:test` coverage of the store and the API |

## Reproduce with RelayForge

```bash
# from a clean git checkout of this example (or your own app)
relayforge learn
relayforge run "Build the todo app per the brief: node:http JSON REST API \
  (list/add/toggle/delete), in-memory store, static index.html, node:test. Zero deps."
relayforge run "…" --execute    # when you want real agent spend
relayforge serve                # local dashboard
relayforge monitor              # optional terminal mission control
```

The team decomposes the goal onto a shared board, implements in parallel worktrees, and the QA critic reviews and merges each task onto the run's integration branch (`loop/todo-app/<run-id>/integration`) — only accepting work whose tests pass. Nothing is auto-merged to `main`; the accepted branch is left for a human to review and merge.
