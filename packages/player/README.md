# `@rec/player`

The browser replay UI, built with Vite and rrweb replay. The daemon and hosted
share server both serve its compiled `dist/` assets.

The player renders a full browser-session timeline: recorded tabs, markers,
navigation/refresh intervals, reconstructed cursor movement, and captured assets.
It reads replay defaults embedded in the manifest and lets reviewers switch idle
treatment between **Cut**, configured fast-forward, and **Keep** without changing
the artifact.

Build it through the root `pnpm build` command, which compiles the TypeScript
packages first and then runs Vite here. Browser regressions live in
`packages/demo/src/player.e2e.test.ts`.
