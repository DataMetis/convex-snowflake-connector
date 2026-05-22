# Convex Snowflake Connector — Build System
# ============================================================================
# Recipes for common development tasks. Run `just --list` to see everything.
# ============================================================================

APP_NAME := "Convex Snowflake Connector"
APP_NAME_KEBAB := "convex-snowflake-connector"
APP_DESCRIPTION := "Node.js CLI + library starter — TypeScript strict, Vitest, Pino, Zod, tsup, Commander"
COMPANY_NAME := "Convex Snowflake Connector"

# Default: show help
default:
    @just --list

# ============================================================================
# Development
# ============================================================================

# Build the CLI + library bundle (runs quality gates first)
build:
    bun run build

# Watch mode — rebuild on source change
dev:
    bun run dev

# Run the built CLI
start *ARGS:
    node dist/cli.js {{ARGS}}

# ============================================================================
# Quality
# ============================================================================

# Run all quality gates (typecheck, lint, format check)
check:
    bun run quality-gates

# TypeScript type check
typecheck:
    bun run typecheck

# ESLint
lint:
    bun run lint

# ESLint with auto-fix
lint-fix:
    bun run lint:fix

# Prettier format (write)
format:
    bun run format

# Prettier format check
format-check:
    bun run format:check

# ============================================================================
# Tests
# ============================================================================

# Run tests once
test:
    bun run test

# Watch mode
test-watch:
    bun run test:watch

# Coverage
test-coverage:
    bun run test:coverage

# ============================================================================
# Publish
# ============================================================================

# Dry-run npm publish (prints what would be published)
publish-dry:
    npm pack --dry-run

# Publish to npm (runs prepublishOnly = build + quality gates)
publish:
    npm publish --access public

# ============================================================================
# Housekeeping
# ============================================================================

# Remove build artifacts and caches
clean:
    rm -rf dist coverage *.tsbuildinfo

# Reinstall dependencies from scratch
reinstall:
    rm -rf node_modules bun.lock
    bun install
