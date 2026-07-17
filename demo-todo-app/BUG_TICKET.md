# BUG-001: Completed state does not persist across page reloads

| Field      | Value                                    |
| ---------- | ---------------------------------------- |
| **Type**   | Defect (data persistence)                |
| **Severity** | Medium                                |
| **Priority** | P2                                    |
| **Component** | `app.js` → `toggleTodo`              |
| **Reported** | 2026-07-17                            |

## Summary

Toggling a todo's checkbox updates the UI immediately, but the completed state
is **not written to `localStorage`**. After a page reload, every todo reverts to
its last saved completion state (which the toggle never updates), so items that
were checked off appear unchecked again. Adding and deleting todos still persist
correctly — only the completed state is lost.

## Steps to reproduce

1. Open `index.html` in a browser.
2. Add a todo, e.g. **"Buy milk"**. (It is saved correctly.)
3. Tick the checkbox next to the todo — it shows a strikethrough.
4. Reload the page (Cmd/Ctrl+R).

## Expected behavior

After reload, **"Buy milk"** should still appear completed (checkbox checked +
strikethrough), matching the state before reload.

## Actual behavior

After reload, **"Buy milk"** appears **incomplete** (checkbox unchecked, no
strikethrough). The todo itself is still present; only its completed state was
lost.

## Environment

- **Browser:** any (reproduces in Chrome, Firefox, Safari)
- **OS:** macOS / Windows / Linux
- **How to run:** open `demo-todo-app/index.html` directly (no build step)

## Suspected cause

`toggleTodo(id)` in `app.js` flips `todo.completed` and calls `render()`, but it
never calls `save()` to persist the updated list. By contrast, `addTodo` and
`deleteTodo` both call `save()`, which is why those operations survive a reload
but toggling does not.

## Acceptance criteria

- [ ] Toggling a todo's checkbox persists the new completed state to `localStorage`.
- [ ] After a full page reload, every todo's completed state matches what was shown before the reload.
- [ ] No regressions: adding and deleting still persist correctly, and the "X items left" count is correct after a reload.

## Suggested fix

Add a `save()` call inside `toggleTodo` (after updating `todo.completed`, before
or after `render()`), mirroring `addTodo` and `deleteTodo`.
