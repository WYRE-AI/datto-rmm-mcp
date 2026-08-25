# Multi-stage build for efficient container size
FROM node:26-alpine AS builder

# Build arguments
ARG VERSION="unknown"
ARG COMMIT_SHA="unknown"
ARG BUILD_DATE="unknown"
ARG GITHUB_TOKEN

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies with GitHub Packages auth. A temporary .npmrc carries the
# token (passed via the GITHUB_TOKEN build arg) so npm can read the private
# @wyre-technology/* package, then it is removed so the token is never baked
# into the image. This ARG-based approach works with one-click build platforms
# (DigitalOcean App Platform) that inject build-time env vars but do not support
# BuildKit `--mount=type=secret`.
RUN echo "@wyre-ai:registry=https://npm.pkg.github.com" > .npmrc && \
    echo "@wyre-technology:registry=https://npm.pkg.github.com" >> .npmrc && \
    echo "//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}" >> .npmrc && \
    npm ci --ignore-scripts && \
    rm -f .npmrc

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Prune dev dependencies in builder stage (re-write the temporary .npmrc so npm
# can re-resolve registry metadata if needed, then remove it again)
RUN echo "@wyre-ai:registry=https://npm.pkg.github.com" > .npmrc && \
    echo "@wyre-technology:registry=https://npm.pkg.github.com" >> .npmrc && \
    echo "//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}" >> .npmrc && \
    npm prune --omit=dev && \
    rm -f .npmrc

# Production stage
FROM node:26-alpine AS production

# Create a non-root user for security
RUN addgroup -g 1001 -S datto && \
    adduser -S datto -u 1001 -G datto

# Set working directory
WORKDIR /app

# Copy package files and built application from builder stage
COPY package*.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules

# Clean npm cache
RUN npm cache clean --force

# Create logs directory
RUN mkdir -p /app/logs && chown -R datto:datto /app

# Switch to non-root user
USER datto

# Expose port for HTTP transport
EXPOSE 8080

# Health check against the actual HTTP endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# Set environment variables
ENV NODE_ENV=production
ENV MCP_TRANSPORT=http
ENV MCP_HTTP_PORT=8080
ENV MCP_HTTP_HOST=0.0.0.0
# Default to env mode for backward compatibility; set to 'gateway' for hosted deployment
ENV AUTH_MODE=env

# Start the application
CMD ["node", "dist/index.js"]

# Build arguments for runtime
ARG VERSION="unknown"
ARG COMMIT_SHA="unknown"
ARG BUILD_DATE="unknown"

# OCI labels for metadata
LABEL maintainer="engineering@wyre.ai"
LABEL version="${VERSION}"
LABEL description="Datto RMM MCP Server - Model Context Protocol server for Datto RMM"
LABEL org.opencontainers.image.title="datto-rmm-mcp"
LABEL org.opencontainers.image.description="Model Context Protocol server for Datto RMM integration"
LABEL org.opencontainers.image.version="${VERSION}"
LABEL org.opencontainers.image.created="${BUILD_DATE}"
LABEL org.opencontainers.image.revision="${COMMIT_SHA}"
LABEL org.opencontainers.image.source="https://github.com/WYRE-AI/datto-rmm-mcp"
LABEL org.opencontainers.image.documentation="https://github.com/WYRE-AI/datto-rmm-mcp/blob/main/README.md"
LABEL org.opencontainers.image.url="https://github.com/WYRE-AI/datto-rmm-mcp/pkgs/container/datto-rmm-mcp"
LABEL org.opencontainers.image.vendor="Wyre Technology"
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL io.modelcontextprotocol.server.name="io.github.WYRE-AI/datto-rmm-mcp"
