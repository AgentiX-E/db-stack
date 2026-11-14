# Examples

## Swapping In Pino for Production

```typescript
import pino from 'pino';
import type { ILogger } from '@agentix-e/db-operations-logger';

// Adapter to make Pino implement ILogger
class PinoAdapter implements ILogger {
  private logger: pino.Logger;

  constructor(logger: pino.Logger) {
    this.logger = logger;
  }

  child(bindings: Record<string, unknown>): ILogger {
    return new PinoAdapter(this.logger.child(bindings));
  }

  trace(msg: string): void;
  trace(context: Record<string, unknown>, msg: string): void;
  trace(c: unknown, m?: string): void { m ? this.logger.trace(c as any, m) : this.logger.trace(c); }

  debug(msg: string): void;
  debug(context: Record<string, unknown>, msg: string): void;
  debug(c: unknown, m?: string): void { m ? this.logger.debug(c as any, m) : this.logger.debug(c); }

  info(msg: string): void;
  info(context: Record<string, unknown>, msg: string): void;
  info(c: unknown, m?: string): void { m ? this.logger.info(c as any, m) : this.logger.info(c); }

  warn(msg: string): void;
  warn(context: Record<string, unknown>, msg: string): void;
  warn(c: unknown, m?: string): void { m ? this.logger.warn(c as any, m) : this.logger.warn(c); }

  error(msg: string): void;
  error(context: Record<string, unknown>, msg: string): void;
  error(err: Error, msg?: string): void;
  error(context: Record<string, unknown>, err: Error, msg?: string): void;
  error(...args: unknown[]): void { this.logger.error(args as any); }

  fatal(msg: string): void;
  fatal(context: Record<string, unknown>, msg: string): void;
  fatal(err: Error, msg?: string): void;
  fatal(context: Record<string, unknown>, err: Error, msg?: string): void;
  fatal(...args: unknown[]): void { this.logger.fatal(args as any); }
}

// Usage
const prodLogger: ILogger = new PinoAdapter(pino({
  level: process.env.LOG_LEVEL ?? 'info',
  formatters: { level: (label) => ({ level: label }) },
}));

prodLogger.info({ service: 'sqlvec-engine' }, 'Starting');
```

## Testing with InMemoryLogger

```typescript
import { InMemoryLogger } from '@agentix-e/db-operations-logger';

describe('MyService', () => {
  let logger: InMemoryLogger;
  let service: MyService;

  beforeEach(() => {
    logger = new InMemoryLogger('test', 1000);
    service = new MyService(logger);
  });

  it('logs on successful operation', async () => {
    await service.doWork();
    
    const entries = logger.getEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0].message).toContain('Starting work');
    expect(entries[1]).toMatchObject({
      level: 'info',
      message: 'Work completed',
    });
    expect(entries[1].context?.durationMs).toBeDefined();
  });

  it('logs error on failure', async () => {
    await expect(service.doWorkThrowing()).rejects.toThrow();
    
    const errors = logger.getByLevel('error');
    expect(errors).toHaveLength(1);
    expect(errors[0].error?.message).toBe('Something went wrong');
    expect(errors[0].error?.stack).toBeDefined();
  });
});
```

## Distributed Tracing Correlation

```typescript
import { InMemoryLogger } from '@agentix-e/db-operations-logger';
import type { ITraceContextProvider } from '@agentix-e/db-operations-logger';

// Combine trace context with logger
const traceCtx = new MyTraceContextProvider();
const logger = new InMemoryLogger('service');

await traceCtx.withTraceAsync('trace-abc-123', async () => {
  const childLogger = logger.child({ traceId: traceCtx.getTraceId() });
  
  // All log entries from this block carry the trace ID
  childLogger.info('Operation started');
  childLogger.info('Operation completed');

  logger.getEntries().forEach(e => {
    console.log(`${e.traceId || e.context?.traceId}: ${e.message}`);
  });
  // → "trace-abc-123: Operation started"
  // → "trace-abc-123: Operation completed"
});
```
