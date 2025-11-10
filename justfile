# List available commands
default:
    @just --list

# Install dependencies
install:
    bun install

# Run all checks (format-check, lint, typecheck, test)
check:
    bun run format-check && bun run lint && bun run typecheck && bun test

# Build the project
build:
    bun run build

# Run tests
test:
    bun test

# Run tests in watch mode
test-watch:
    bun test --watch

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
    bun run format && bun run lint

# Clean build artifacts
clean:
    rm -rf dist

# Prepare for publishing (run all checks and build)
prepublish:
    bun run prepublishOnly

# Publish to npm
publish: prepublish
    npm publish
