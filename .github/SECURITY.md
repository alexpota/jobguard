# Security Policy

## Reporting Vulnerabilities

🔒 **Please do NOT open public issues for security vulnerabilities.**

If you discover a security issue, please **[Create a private security advisory](https://github.com/alexpota/jobguard/security/advisories/new)**

We will respond within 48 hours and work with you to address the issue.

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Security Best Practices

When using JobGuard in production:

### PostgreSQL Security
- ✅ Use SSL/TLS for PostgreSQL connections (`ssl: true`)
- ✅ Store connection strings in environment variables, not code
- ✅ Use least-privilege database user with only required permissions:
  ```sql
  GRANT SELECT, INSERT, UPDATE, DELETE ON jobguard_jobs TO jobguard_user;
  ```
- ✅ Rotate database credentials regularly
- ✅ Set appropriate `max_connections` for your PostgreSQL instance
- ✅ Enable PostgreSQL audit logging for compliance requirements

### Application Security
- ✅ Keep dependencies up to date (`npm audit` and `npm update`)
- ✅ Validate job data in your application before enqueueing
- ✅ Implement idempotent job handlers to prevent duplicate processing issues
- ✅ Monitor logs for suspicious activity (unusual error patterns, connection failures)

### What JobGuard Does
- ✅ Sanitizes error messages to remove credentials and sensitive data
- ✅ Uses parameterized SQL queries to prevent SQL injection
- ✅ Validates job data size and format
- ✅ Implements circuit breaker pattern for fault tolerance

### What JobGuard Does NOT Do
- ❌ JobGuard does not encrypt job data at rest (use PostgreSQL encryption if needed)
- ❌ JobGuard does not implement authentication (secure your PostgreSQL instance)
- ❌ JobGuard does not sanitize job data payloads (validate in your application)

## Known Security Considerations

### Race Conditions
See [Known Limitations](../README.md#known-limitations) in the README for details on edge-case race conditions inherent to distributed systems.

### Multi-Instance Reconciliation
Only enable reconciliation on one JobGuard instance per queue to prevent duplicate re-enqueue attempts. See [Configuration](../README.md#configuration) for details.

## Security Update Policy

- **Critical vulnerabilities**: Patch released within 48 hours
- **High severity**: Patch released within 7 days
- **Medium/Low severity**: Patch released in next minor version

## Acknowledgments

We appreciate responsible disclosure of security issues. Contributors who report valid security issues will be acknowledged in the CHANGELOG (unless they prefer to remain anonymous).
