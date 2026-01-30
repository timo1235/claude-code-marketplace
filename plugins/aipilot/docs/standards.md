# Review Standards

Standard review criteria for all Codex-powered reviews in the AIPilot pipeline.

## Categories

### 1. Security (OWASP)

- Input validation at system boundaries (user input, external APIs, file uploads)
- No SQL injection, XSS, command injection, path traversal
- Authentication and authorization checks on all protected resources
- No hardcoded secrets, API keys, or credentials
- Error messages do not leak internal details
- CSRF protection on state-changing operations
- Secure defaults (deny by default)

**Severity mapping**: Any security finding is at minimum `major`. Exploitable vulnerabilities are `critical`.

### 2. Error Handling

- Errors caught at appropriate boundaries (not swallowed silently)
- Error messages are actionable and user-friendly
- Async errors are handled (unhandled promise rejections, missing try/catch on await)
- Fallback behavior is defined for external service failures
- No bare `catch {}` blocks that silently discard errors

**Severity mapping**: Missing error handling on user-facing paths is `major`. Internal-only is `minor`.

### 3. Resource Management

- Database connections, file handles, and network sockets are properly closed
- Event listeners are cleaned up (no memory leaks)
- Timeouts are set on external calls (HTTP, DB queries)
- Large data sets are streamed, not loaded into memory
- Temporary files are cleaned up

**Severity mapping**: Leaks in hot paths are `critical`. One-time operations are `minor`.

### 4. Configuration

- No hardcoded environment-specific values (URLs, ports, paths)
- Configuration is loaded from environment variables or config files
- Sensitive config is not logged or exposed
- Defaults are sensible and documented

**Severity mapping**: Hardcoded production values are `major`. Missing defaults are `minor`.

### 5. Code Quality

- Follows existing codebase patterns and conventions
- No dead code (unused imports, functions, variables)
- No copy-pasted code that should be abstracted
- Files under 800 lines
- Functions under 50 lines (prefer smaller)
- Meaningful variable and function names
- No print/console.log statements (use project logging conventions)

**Severity mapping**: Pattern violations are `minor`. Dead code is `minor`. Unreadable code is `major`.

### 6. Concurrency

- Shared state is protected (mutexes, atomic operations, or immutable patterns)
- Race conditions are avoided in async code
- Database operations use transactions where needed
- Parallel operations have proper error handling (Promise.allSettled vs Promise.all)

**Severity mapping**: Data corruption risks are `critical`. Non-deterministic behavior is `major`.

### 7. Logging

- Significant operations are logged (API calls, state changes, errors)
- Log levels are appropriate (error for errors, info for operations, debug for details)
- No sensitive data in logs (passwords, tokens, PII)
- Structured logging where the project supports it

**Severity mapping**: Missing error logging is `major`. Missing operation logging is `suggestion`.

### 8. Dependencies

- New dependencies are justified and actively maintained
- No known vulnerabilities in added dependencies
- License compatibility verified
- Minimal dependency footprint (no kitchen-sink libraries for single features)

**Severity mapping**: Vulnerable dependencies are `critical`. Unjustified dependencies are `minor`.

### 9. API Design

- RESTful conventions followed (correct HTTP methods, status codes)
- Request/response contracts are documented or typed
- Backward compatibility maintained for existing endpoints
- Rate limiting and pagination where appropriate
- Input validation on all endpoints

**Severity mapping**: Breaking changes without versioning are `critical`. Missing validation is `major`.

### 10. Backward Compatibility

- Public API signatures are not changed without versioning
- Database migrations are reversible where possible
- Feature flags for gradual rollout of breaking changes
- Deprecation warnings before removal

**Severity mapping**: Silent breaking changes are `critical`. Missing deprecation is `major`.

### 11. Testing

- New business logic has unit tests
- Edge cases are tested (empty input, boundary values, error paths)
- Integration tests for cross-component interactions
- Tests are deterministic (no time-dependent, order-dependent, or flaky tests)
- Test patterns match existing codebase conventions

**Severity mapping**: Missing tests for critical paths are `major`. Missing edge case tests are `minor`.

### 12. Over-Engineering

- Solution complexity matches problem complexity
- No premature abstractions (YAGNI)
- No unnecessary indirection layers
- No feature flags or configuration for single-use values
- Prefer simple, direct implementations over clever ones

**Severity mapping**: Unnecessary complexity is `minor`. Abstractions that obscure logic are `major`.

## Decision Rules

### Status: `approved`
- Zero `critical` findings
- Zero `major` findings
- Any number of `minor` or `suggestion` findings (informational only)

### Status: `needs_changes`
- One or more `major` findings, OR
- Plan-level issues that are fixable with revision

### Status: `needs_clarification` (plan review only)
- Requirements are ambiguous and cannot be reviewed without user input
- Clarification questions must be provided

### Status: `rejected`
- One or more `critical` findings, OR
- Fundamental design/approach problems requiring a complete rethink
