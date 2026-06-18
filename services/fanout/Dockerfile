# Build stage — compile TS to dist/.
FROM node:24-alpine AS build
WORKDIR /app

# Copy manifests first so deps install caches separately from source.
COPY package.json package-lock.json* ./
RUN npm ci --include=dev

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Drop devDependencies in a second install so the runtime layer ships
# without typescript / vitest / tsx.
RUN npm prune --omit=dev

# Runtime stage — minimal Node, only dist/ + production node_modules.
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

EXPOSE 5174
# Required at runtime via `docker run --env`:
#   LOOMSCOPE_FANOUT_UPSTREAMS  "http://host.docker.internal:5180,http://host.docker.internal:5181"
#   LOOMSCOPE_SECRET            same value as ~/.loomscope/secret on the host
# Optional:
#   PORT                        default 5174
#   HOSTNAME                    default 0.0.0.0 (lets `-p` mapping pick it up)
#   LOOMSCOPE_FANOUT_PRE_TOOL_USE_TIMEOUT_MS  default 540000 (9 min)
CMD ["node", "dist/index.js"]
