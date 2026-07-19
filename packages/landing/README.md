# @replay/landing

The marketing landing page for Replay — a dark, animated single-page React app
built for the OpenAI Hackathon. It foregrounds the product's core idea
(agent-driven browser replays with the dead air cut) and prominently credits
**GPT-5.6 Terra** as the model it was forged with.

## Stack

- React 18 + TypeScript
- Vite 7
- Tailwind CSS v4 (CSS-first config in `src/index.css`)
- Framer Motion (scroll reveals, gestures, the looping hero timeline)
- Fonts: Inter, Space Grotesk, JetBrains Mono (via Google Fonts)

## Develop

```sh
pnpm install
pnpm dev:landing      # http://127.0.0.1:5175
```

## Scripts

| Script                 | What it does                          |
| ---------------------- | ------------------------------------- |
| `pnpm dev:landing`     | Vite dev server on port 5175          |
| `pnpm build:landing`   | Typecheck + production build to `dist` |
| `pnpm check:landing`   | Typecheck only                        |
| `pnpm preview:landing` | Preview the production build          |

## Structure

```
src/
  App.tsx            # composes the page sections in order
  index.css          # theme tokens, keyframes, utilities (Tailwind v4 @theme)
  components/
    Background.tsx   # fixed aurora + grid + drifting motes
    Nav.tsx          # sticky glass nav with mobile menu
    Hero.tsx         # headline, GPT-5.6 Terra badges, CTAs
    HeroReplay.tsx   # animated looping replay-player mock (signature visual)
    Marquee.tsx      # tech / stack strip
    Problem.tsx      # the pain points
    HowItWorks.tsx   # 3-step flow
    IdleTreatment.tsx# interactive Cut / Fast-forward / Keep demo
    Features.tsx     # 8-card feature grid
    AskAI.tsx        # Ask-AI assistant spotlight + chat mock
    TerraCore.tsx    # animated GPT-5.6 Terra "core" reactor
    TerraSection.tsx # the GPT-5.6 Terra / OpenAI-hackathon story
    CodeShowcase.tsx # prompt + terminal mock
    FinalCTA.tsx     # closing call-to-action
    Footer.tsx
    primitives.tsx   # Reveal, Button, Tag, SectionHeading, OrbitMark
    icons.tsx        # inline SVG icon set
```

Everything is static content; there is no backend. Links to GitHub / docs are
placeholders (`#`) to be wired to real URLs at launch.
