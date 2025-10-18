# Contributing to JobGuard

Thank you for your interest in contributing to JobGuard! We welcome contributions from the community.

## Code of Conduct

By participating in this project, you agree to abide by our [Code of Conduct](./CODE_OF_CONDUCT.md).

## How to Contribute

### Reporting Bugs

Before creating bug reports, please check existing issues to avoid duplicates. When creating a bug report, include:

- **Clear title and description**
- **Steps to reproduce** the behavior
- **Expected behavior**
- **Actual behavior**
- **Environment details** (Node.js version, PostgreSQL version, queue library version)
- **Code samples** or test cases if applicable

### Suggesting Enhancements

Enhancement suggestions are welcome! Please include:

- **Use case** - Why is this enhancement needed?
- **Proposed solution** - How should it work?
- **Alternatives considered** - What other approaches did you consider?

### Pull Requests

1. **Fork the repository** and create your branch from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Set up your development environment** (see [Development Environment Setup](#development-environment-setup) below)

3. **Make your changes:**
   - Write or update tests for your changes
   - Follow the existing code style
   - Add comments for complex logic
   - Update documentation if needed

4. **Test your changes** (see [Running Tests](#running-tests) below for details):
   ```bash
   npm test                    # Unit tests
   npm run test:integration    # Integration tests
   npm run lint                # Linting
   npm run build               # Build check
   ```

5. **Commit your changes:**
   - Use clear, descriptive commit messages
   - Follow [Conventional Commits](https://www.conventionalcommits.org/) format:
     ```
     feat: add support for custom reconciliation strategies
     fix: prevent duplicate job insertions during race conditions
     docs: update API reference for getStats method
     test: add integration tests for Bee-Queue adapter
     ```

6. **Push to your fork and create a Pull Request:**
   - Fill out the PR template completely
   - Link related issues
   - Request review from maintainers

## Development Guidelines

### Code Style

- **TypeScript**: Strict mode enabled
- **Formatting**: Run `npm run format` before committing
- **Linting**: Run `npm run lint` and fix all errors
- **No `any` types**: Use proper type definitions (warnings are acceptable where truly needed)

### Testing Requirements

- **Unit tests** for all new functions/methods
- **Integration tests** for queue adapter changes
- **Test coverage** should not decrease
- All tests must pass before PR can be merged

## Development Environment Setup

### Prerequisites

- **Node.js**: 22.0+
- **PostgreSQL**: 14+
- **Redis**: 6.0+
- **Docker** (optional, for running PostgreSQL + Redis via Docker Compose)

### One-Time Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/alexpota/jobguard.git
   cd jobguard
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Start PostgreSQL and Redis via Docker:**
   ```bash
   cd demo
   docker-compose up -d
   cd ..
   ```

4. **Create test database:**
   ```bash
   PGPASSWORD=demo123 psql -U demo -h localhost -p 5433 -d jobguard_demo -c "CREATE DATABASE jobguard_test;"
   ```

5. **Configure test environment:**
   ```bash
   cp .env.test.example .env.test
   ```

   The `.env.test` file contains:
   ```
   POSTGRES_URL=postgresql://demo:demo123@localhost:5433/jobguard_test
   REDIS_HOST=localhost
   REDIS_PORT=6379
   ```

### Running Tests

**Test commands:**
```bash
npm test                    # Unit tests only
npm run test:integration    # Integration tests (requires PostgreSQL + Redis)
npm run test:e2e            # E2E tests (starts Docker containers automatically)
npm run lint                # Lint code
npm run build               # Build TypeScript
```

**Test coverage:**
- **Unit tests (20)**: Core utilities and business logic
- **Integration tests (60)**: Bull, BullMQ, Bee-Queue adapters with real databases
- **E2E tests (2)**: Full Docker-based environment for regression testing

**Important notes:**
- Integration tests use environment variables from `.env.test` (gitignored)
- E2E tests manage their own Docker containers via docker-compose
- All tests run in CI/CD pipeline on pull requests

### Documentation

- Update README.md if adding new features
- Add JSDoc comments for public APIs
- Update TypeScript types if changing interfaces
- Add examples for complex features

## Project Structure

```
jobguard/
├── src/               # Source code
│   ├── adapters/      # Queue-specific adapters (Bull, BullMQ, Bee)
│   ├── persistence/   # PostgreSQL repository and queries
│   ├── reconciliation/# Reconciliation engine
│   ├── types/         # TypeScript type definitions
│   └── utils/         # Utilities (logger, circuit breaker)
├── test/
│   ├── unit/          # Unit tests
│   └── integration/   # Integration tests
├── schema/            # PostgreSQL schema files
├── demo/              # Demo applications
└── examples/          # Example code

```

## Release Process

Maintainers handle releases:

1. Update version in `package.json`
2. Update `CHANGELOG.md`
3. Create git tag: `git tag v1.x.x`
4. Push tag: `git push origin v1.x.x`
5. GitHub Actions will publish to npm

## Questions?

- Open a [Discussion](../../discussions) for questions
- Join our community (coming soon)
- Check existing issues and PRs

Thank you for contributing to JobGuard! 🎉
