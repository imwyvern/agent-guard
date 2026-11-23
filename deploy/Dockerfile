# Local source template; build from the repository root (see README.md).
FROM node:20.19-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsup.config.ts ./
RUN npm ci --ignore-scripts
COPY scripts/build.ts ./scripts/build.ts
COPY src ./src
RUN npm run build

FROM node:20.19-slim AS runtime
WORKDIR /app
# Keep business files root-owned and unwritable by the runtime UID.
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
USER 65532:65532
EXPOSE 8080
# Supply --upstream at runtime. The CLI only accepts detect mode.
ENTRYPOINT ["node", "dist/cli/main.js", "proxy", "--listen", "0.0.0.0:8080", "--allow-public-bind"]
