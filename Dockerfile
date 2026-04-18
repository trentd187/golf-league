# Dockerfile (repo root)
# Railway deployment build for the Golf League API server.
#
# Railway always uses the repo root as the Docker build context, so COPY paths here
# are relative to the repo root (e.g., "backend/go.mod" not "go.mod").
# The local docker-compose setup uses backend/Dockerfile with "build: ./backend",
# which has a different context — that file is left unchanged for local dev.
#
# A multi-stage build keeps the final image small:
#   Stage 1 (builder): full Go toolchain to compile the binary (~800MB image, discarded)
#   Stage 2 (runtime): minimal Alpine image with only the compiled binary (~10MB final image)

# ---- Stage 1: Build ----
# golang:1.25-alpine includes the Go compiler and standard library on a minimal Alpine Linux base.
FROM golang:1.25-alpine AS builder

# Set the working directory inside the container. All subsequent commands run from here.
WORKDIR /app

# Copy dependency files first and download modules before copying source.
# Docker caches each layer — by copying go.mod/go.sum separately, the expensive
# "go mod download" step is only re-run when dependencies change, not on every code push.
# Paths are relative to the repo root (the Railway build context).
COPY backend/go.mod backend/go.sum ./
RUN go mod download

# Copy the entire backend source directory into the container.
# "backend/." copies the contents of backend/ into the current WORKDIR (/app),
# so /app/cmd/server/main.go, /app/internal/..., /app/migrations/... etc.
COPY backend/. .

# Build the binary.
# CGO_ENABLED=0 disables C bindings, producing a fully static binary with no external dependencies.
# GOOS=linux ensures the binary targets Linux even if the CI runner is another OS.
# -o server names the output binary "server".
# ./cmd/server is the package path to the main entry point.
RUN CGO_ENABLED=0 GOOS=linux go build -o server ./cmd/server

# ---- Stage 2: Runtime ----
# alpine:3.21 is a tiny Linux distribution (~5MB). Pinned to avoid surprise upgrades.
FROM alpine:3.21

# ca-certificates is needed for outbound HTTPS requests (e.g., to Clerk's API and JWKS endpoint).
# Without it, TLS certificate verification fails.
RUN apk --no-cache add ca-certificates

WORKDIR /app

# Copy only the compiled binary from the builder stage — leave all Go source and tooling behind.
COPY --from=builder /app/server .

# Copy the migrations directory so golang-migrate can find and run the SQL files on startup.
# RunMigrations() uses "file://migrations" which resolves to /app/migrations at runtime.
COPY --from=builder /app/migrations ./migrations

# Document the default port. Railway overrides this with its own PORT env var, which
# config.go already reads. This line is informational only.
EXPOSE 8080

# Tell Docker (and Railway) which signal to send when stopping the container.
# SIGTERM triggers Fiber's graceful shutdown — open connections finish before the process exits.
STOPSIGNAL SIGTERM

# Start the server binary.
CMD ["./server"]
