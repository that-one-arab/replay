# `@replay/demo`

Deterministic fixtures and browser regression coverage for Replay’s replay player.

It includes:

- Scripts that create single-tab and multi-tab demo replays.
- End-to-end player tests for progress, keyboard controls, idle treatment,
  navigation/refresh intervals, and browser tab lifecycle.

From the repository root:

```sh
pnpm demo:capture
pnpm demo:capture:multi
pnpm test
```

The demo is development evidence, not part of the installed agent workflow.
