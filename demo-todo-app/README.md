# Demo Todo App

A small, dependency-free todo app used as a debugging exercise.

## Run it

This app must be served over HTTP. **Do not open `index.html` directly
(`file://`)** — browsers treat each `file:` URL as a unique security origin, so
they block the stylesheet, the script, and `localStorage`. You'll see an error
like: `Unsafe attempt to load URL ... 'file:' URLs are treated as unique
security origins`.

Start a local server from this folder (no build step; `python3` ships with
macOS):

```sh
cd demo-todo-app
python3 -m http.server 8765
```

Then open **http://127.0.0.1:8765/** in your browser. Stop the server with
`Ctrl+C` when done. (If port 8765 is taken, use any free port, e.g. `8000`.)

Todos are stored in the browser's `localStorage`, so they survive page reloads —
reload the page to test persistence behavior.

## Features

- Add a todo
- Mark a todo complete / incomplete
- Delete a todo
- "X items left" counter

## Known issue

This app ships with **one known bug** — see [`BUG_TICKET.md`](./BUG_TICKET.md).
