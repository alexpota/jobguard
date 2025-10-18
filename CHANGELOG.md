# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Note:** Versions `0.x.x` are for initial development. The public API may change between minor versions during this phase. Version `1.0.0` will be released once the API is stable and validated in production.

## [Unreleased]

## [0.1.0] - Unreleased

Initial release of JobGuard.

### Added
- **Core Features:**
  - Drop-in integration for Redis-backed job queues
  - PostgreSQL persistence layer with automatic job tracking
  - Event monitoring for real-time job status updates
  - Reconciliation engine for stuck job recovery
  - Circuit breaker pattern for PostgreSQL failures

- **Queue Support:**
  - Bull adapter with full event support
  - BullMQ adapter with modern API
  - Bee-Queue adapter with simplified API

- **Configuration:**
  - Flexible PostgreSQL connection options (object or string)
  - Configurable reconciliation intervals and thresholds
  - Adjustable logging levels (debug, info, warn, error)
  - Retention policies for completed jobs

- **Developer Experience:**
  - Full TypeScript definitions
  - API documentation with examples
  - Example projects for each queue library
  - Docker-based demo environment

- **Testing:**
  - 82 tests (20 unit, 60 integration, 2 E2E)
  - Race condition testing
  - Connection pool testing
  - Partial index behavior verification
  - Docker-based E2E test environment

### Security
- SSL/TLS support for PostgreSQL connections
- Environment-based configuration
- No credential logging

---

## Release Notes Format

### Types of Changes
- `Added` for new features
- `Changed` for changes in existing functionality
- `Deprecated` for soon-to-be removed features
- `Removed` for now removed features
- `Fixed` for any bug fixes
- `Security` for vulnerability fixes
