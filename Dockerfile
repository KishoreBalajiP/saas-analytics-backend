# =============================================================================
# Dockerfile - multi-stage production image.
# Builds a minimal image that runs the same code on any container host
# (Docker, AWS ECS/Fargate, Render, Railway, ...). No host-specific logic.
# =============================================================================

# Stage 1: install production dependencies ----------------------------------
FROM node:22-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Stage 2: runtime image -----------------------------------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Create an unprivileged user - never run containers as root.
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Copy installed dependencies and application source.
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# Uploads/logs directories are expected to exist at runtime.
RUN mkdir -p uploads logs && chown -R appuser:appgroup /app

USER appuser

ENV PORT=8080
EXPOSE 8080

# Healthcheck relies on the public health endpoint (works without a database).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/api/v1/health || exit 1

CMD ["node", "src/server.js"]
