FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
RUN addgroup -S rivermoon && adduser -S -G rivermoon rivermoon \
  && mkdir -p /var/lib/rivermoon-codex-gateway \
  && chown -R rivermoon:rivermoon /var/lib/rivermoon-codex-gateway
USER rivermoon
EXPOSE 8787
CMD ["node", "dist/index.js"]
