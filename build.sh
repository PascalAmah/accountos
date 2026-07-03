#!/usr/bin/env sh
set -e

# Install all dependencies (including devDependencies needed for nest build)
pnpm install --frozen-lockfile

# Generate Prisma client — needs a DATABASE_URL to parse the schema.
# Use the real one if available, otherwise a dummy for build-time generation only.
export DATABASE_URL="${DATABASE_URL:-postgresql://accountos:accountos@localhost:5432/dummy}"
pnpm exec prisma generate

# Compile TypeScript
pnpm run build

echo "Build complete."
