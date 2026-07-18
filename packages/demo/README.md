# `@rec/demo`

Deterministic fixtures and browser regression coverage for Rec’s replay player.

It includes:

- Scripts that create single-tab and multi-tab demo recordings.
- End-to-end player tests for progress, keyboard controls, idle treatment,
  navigation/refresh intervals, and browser tab lifecycle.

From the repository root:

```sh
pnpm demo:record
pnpm demo:record:multi
pnpm test
```

The demo is development evidence, not part of the installed agent workflow.
