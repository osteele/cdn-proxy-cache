# List available commands
default:
    @just --list

# Install dependencies
install:
    bun install

# Run all checks (format-check, lint, typecheck, test)
check:
    bun run check

# Build the project
build:
    bun run build

# Smoke-test the packed artifact with an installed Express major
compatibility-smoke express-version:
    bun run build
    sh scripts/test-packed-compatibility.sh {{quote(express-version)}}

# Run tests
test:
    bun test

# Run tests in watch mode
test-watch:
    bun test --watch

# Verify the Bun command-runner mutation setup without executing mutants
mutation-dry:
    bun run mutation:dry

# Run the bounded mutation baseline configured in stryker.config.mjs
mutation:
    bun run mutation

# Verify the stream-slice mutation setup without executing mutants
mutation-stream-dry:
    bun run mutation:stream:dry

# Run mutation testing for stream transformation and failure handling
mutation-stream:
    bun run mutation:stream

# Verify the security-slice mutation setup without executing mutants
mutation-security-dry:
    bun run mutation:security:dry

# Run mutation testing for URL and response-header trust boundaries
mutation-security:
    bun run mutation:security

# Type check
typecheck:
    bun run typecheck

# Run linting
lint:
    bun run lint

# Auto-format code
format:
    bun run format

# Check formatting (without modifying files)
format-check:
    bun run format-check

# Fix formatting and linting issues
fix:
    bun run fix

# Clean build artifacts
clean:
    rm -rf dist

# Prepare for publishing (run all checks and build)
prepublish:
    bun run prepublishOnly

# Publish to npm
publish: prepublish
    npm publish
