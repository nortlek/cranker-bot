FROM node:24-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY dashboard/package.json dashboard/package-lock.json ./dashboard/
RUN npm --prefix dashboard ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY dashboard ./dashboard
RUN npm run build:keeper && npm --prefix dashboard run build

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/dashboard/dist ./dashboard/dist
COPY migrations ./migrations
USER node
CMD ["node", "dist/main.js"]
