# backend/Dockerfile
# Multi-stage build for the Golf League API server.
#
# A multi-stage build uses two separate Docker images:
#   Stage 1 (builder): a full Go toolchain image to compile the binary
#   Stage 2 (runtime): a minimal Alpine image that only contains the compiled binary
#
# The final image is much smaller (~10MB vs ~800MB) because it doesn't include
# the Go compiler, source code, or build tools — only what's needed to run.

# ---- Stage 1: Build ----
# golang:1.26-alpine includes the Go compiler and standard library on a minimal Alpine Linux base.
# The minor tag floats to the latest 1.26 patch, so each rebuild picks up Go stdlib security fixes.
FROM golang:1.26-alpine AS builder

# Set the working directory inside the container. All subsequent commands run from here.
WORKDIR /app

# Copy go.mod and go.sum first and download dependencies before copying source code.
# Docker caches each layer — by copying dependency files separately, the expensive
# "go mod download" step is only re-run when dependencies change, not on every code change.
COPY go.mod go.sum ./
RUN go mod download

# Copy all remaining source files into the container
COPY . .

# Build the binary.
# CGO_ENABLED=0 disables C bindings, producing a fully static binary with no external dependencies.
# GOOS=linux ensures the binary targets Linux even if built on macOS or Windows.
# -o server names the output binary "server".
# ./cmd/server is the package path to the main entry point.
RUN CGO_ENABLED=0 GOOS=linux go build -o server ./cmd/server

# ---- Stage 2: Runtime ----
# alpine:3.21 is a tiny Linux distribution (~5MB). We only copy the compiled binary here.
# Pinned to a specific version (not "latest") so builds are reproducible — a future "latest"
# release can't silently change behavior or break the image.
FROM alpine:3.21

# ca-certificates is needed for making HTTPS requests (e.g., to Clerk's JWKS endpoint).
# Without this, TLS certificate verification would fail.
RUN apk --no-cache add ca-certificates

WORKDIR /app

# Copy only the compiled binary from the builder stage — leave behind all Go source and tooling
COPY --from=builder /app/server .

# Copy the migrations directory so the server can run them on startup.
# These SQL files are read at runtime by golang-migrate.
COPY --from=builder /app/migrations ./migrations

# Tell Docker this container listens on port 8080 (matches the default in config.go).
# This is documentation only — it doesn't actually publish the port (docker run -p does that).
# On Railway, the actual port is injected via the PORT environment variable.
EXPOSE 8080

# Tell Docker (and Railway) which signal to send when stopping the container.
# SIGTERM is the standard "please shut down gracefully" signal. Fiber listens for it
# and closes open connections before exiting, rather than cutting them off hard.
STOPSIGNAL SIGTERM

# The command to run when the container starts
CMD ["./server"]
