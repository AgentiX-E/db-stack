# Performance & Chaos Engineering Tests

## Testing Principles

- **Reproducibility**: fixed random seed per test
- **Statistical significance**: minimum 5 samples per scenario
- **Isolation**: independent TCP port and DB file per test
- **Safety**: all tests in-process, does not affect production

## Execution

```bash
npx vitest run src/__tests__/performance/
```
