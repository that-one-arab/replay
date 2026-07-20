FROM node:24-alpine

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
RUN corepack enable && pnpm install --frozen-lockfile && pnpm build

ENV PORT=8080
ENV REPLAY_SHARE_DATA_DIR=/data
EXPOSE 8080
CMD ["node", "packages/share-server/dist/main.js"]
