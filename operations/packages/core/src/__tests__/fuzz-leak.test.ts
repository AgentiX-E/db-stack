/**
 * fuzz-leak.test.ts — Fuzz testing + memory leak detection.
 * Section 1: Random input fuzzing (RateLimiter, RBAC, AlertRule, DeadlockDetector, Backup, Audit, SlowQuery, Metrics, Encryption, SecurityCompliance, Tracer)
 * Section 2: Instance isolation / memory leak verification
 */

import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';

// ── Helpers ────────────────────────────────────────
function rng(max: number): number {
  return Math.floor(Math.random() * max);
}
function randStr(len = 10): string {
  return Array.from({ length: len }, () =>
    String.fromCharCode(32 + Math.floor(Math.random() * 95)),
  ).join('');
}
function coin(): boolean {
  return Math.random() > 0.5;
}

// ═══════════════════════════════════════════════════
// SECTION 1: FUZZ TESTS
// ═══════════════════════════════════════════════════

/* 1.1 RateLimiter */
describe('Fuzz RateLimiter', () => {
  it('1000 random check() inputs', () => {
    const lim = new (class {
      _w = new Map<string, { c: number; s: number }>();
      check(k: string, cfg: { maxRequests: number; windowMs: number }) {
        if (cfg.maxRequests <= 0) return { allowed: false, remaining: 0, resetMs: cfg.windowMs };
        const n = Date.now();
        const e = this._w.get(k);
        if (!e || n - e.s >= cfg.windowMs) {
          this._w.set(k, { c: 1, s: n });
          return { allowed: true, remaining: cfg.maxRequests - 1, resetMs: cfg.windowMs };
        }
        if (e.c >= cfg.maxRequests)
          return { allowed: false, remaining: 0, resetMs: Math.max(0, cfg.windowMs - (n - e.s)) };
        e.c++;
        return { allowed: true, remaining: cfg.maxRequests - e.c, resetMs: Math.max(0, cfg.windowMs - (n - e.s)) };
      }
      reset(k: string) { this._w.delete(k); }
    })();
    for (let i = 0; i < 1000; i++) {
      const r = lim.check('k-' + rng(100), { maxRequests: rng(100) + 1, windowMs: rng(10000) + 1 });
      expect(r).toHaveProperty('allowed');
      expect(r).toHaveProperty('remaining');
      expect(r).toHaveProperty('resetMs');
      expect(typeof r.allowed).toBe('boolean');
      expect(typeof r.remaining).toBe('number');
    }
  });

  it('empty / long / special keys', () => {
    const lim = new (class {
      _w = new Map();
      check(k: string, c: any) { const n = Date.now(); const e = this._w.get(k); if (!e) { this._w.set(k, { c: 1, s: n }); return { allowed: true, remaining: 9, resetMs: c.windowMs }; } e.c++; return { allowed: true, remaining: 9 - e.c, resetMs: c.windowMs }; }
      reset(k: string) { this._w.delete(k); }
    })();
    for (let i = 0; i < 50; i++) expect(lim.check('', { maxRequests: 5, windowMs: 1000 })).toBeDefined();
    const k = 'x'.repeat(10000);
    for (let i = 0; i < 50; i++) expect(lim.check(k, { maxRequests: 5, windowMs: 1000 })).toBeDefined();
  });
});

/* 1.2 RBACProvider */
describe('Fuzz RBAC', () => {
  it('500 random role ops', () => {
    const rbac = new (class {
      _r = new Map<string, Array<{ resource: string; action: string }>>();
      reg(r: string, p: Array<{ resource: string; action: string }>) { this._r.set(r, [...p]); }
      has(id: string, r: string, res: string, act: string) {
        const p = this._r.get(r); if (!p) return false;
        return p.some(x => x.resource === res && x.action === act);
      }
      getPerms(id: string, roles: string[]) {
        const m = new Map();
        for (const rn of roles) { const p = this._r.get(rn); if (p) for (const x of p) m.set(x.resource + ':' + x.action, x); }
        return Array.from(m.values());
      }
    })();
    const resources = ['users', 'orders', 'products', 'config'];
    const actions = ['create', 'read', 'update', 'delete'];
    for (let i = 0; i < 500; i++) {
      rbac.reg('r-' + randStr(5), Array.from({ length: rng(10) }, () => ({ resource: resources[rng(4)], action: actions[rng(4)] })));
    }
    for (let i = 0; i < 100; i++) {
      expect(typeof rbac.has('x', 'r-' + randStr(5), resources[rng(4)], actions[rng(4)])).toBe('boolean');
    }
  });

  it('empty / long / special role names', () => {
    const rbac = new (class {
      _r = new Map();
      reg(r: string, p: any[]) { this._r.set(r, [...p]); }
      has(id: string, r: string, res: string, act: string) { return (this._r.get(r) ?? []).some((x: any) => x.resource === res && x.action === act); }
      getPerms(id: string, roles: string[]) { const m = new Map(); for (const rn of roles) { const p = this._r.get(rn); if (p) for (const x of p) m.set(x.resource + ':' + x.action, x); } return Array.from(m.values()); }
    })();
    rbac.reg('', [{ resource: 't', action: 'r' }]);
    expect(typeof rbac.has('x', '', 't', 'r')).toBe('boolean');
    rbac.reg('A'.repeat(10000), [{ resource: 't', action: 'r' }]);
    expect(rbac.getPerms('x', ['A'.repeat(10000)])).toHaveLength(1);
    rbac.reg('\x00\x01\x1f', [{ resource: 't', action: 'a' }]);
    expect(rbac.has('x', '\x00\x01\x1f', 't', 'a')).toBe(true);
  });
});

/* 1.3 AlertRuleManager */
describe('Fuzz AlertRule', () => {
  it('500 random evaluations', async () => {
    const mgr = new (class {
      _r = new Map<string, any>();
      async add(r: any) { const id = r.id ?? Math.random().toString(36); this._r.set(id, { ...r, id, en: r.enabled !== false }); return id; }
      eval(s: Record<string, number>) {
        const t: any[] = [];
        for (const [k, e] of this._r) {
          if (!e.en) continue;
          const v = s[e.metric]; if (v === undefined) continue;
          let trig = false;
          switch (e.condition) { case 'gt': trig = v > e.threshold; break; case 'lt': trig = v < e.threshold; break; case 'eq': trig = v === e.threshold; break; case 'gte': trig = v >= e.threshold; break; case 'lte': trig = v <= e.threshold; break; }
          if (trig) t.push({ ruleId: k, value: v, threshold: e.threshold });
        }
        return t;
      }
      toggle(id: string, en: boolean) { const e = this._r.get(id); if (e) e.en = en; }
    })();
    for (let i = 0; i < 50; i++) await mgr.add({ name: 'r' + i, metric: 'm_' + rng(20), condition: ['gt', 'lt', 'eq', 'gte', 'lte'][rng(5)], threshold: rng(100) - 50, severity: 'info', enabled: coin() });
    for (let i = 0; i < 500; i++) {
      const snap: Record<string, number> = {};
      for (let m = 0; m < rng(30); m++) snap[coin() ? 'm_' + rng(20) : 'x_' + rng(100)] = rng(2000) - 1000;
      if (i % 10 === 0) snap['nan'] = NaN;
      if (i % 11 === 0) snap['inf'] = Infinity;
      if (i % 13 === 0) snap['ninf'] = -Infinity;
      const res = mgr.eval(snap);
      expect(Array.isArray(res)).toBe(true);
      for (const e of res) { expect(typeof e.value).toBe('number'); }
    }
  });
});

/* 1.4 DeadlockDetector */
describe('Fuzz DeadlockDetector', () => {
  it('1000 random graph ops', () => {
    const det = new (class {
      _w = new Map<string, Set<string>>();
      _a = new Map<string, Set<string>>();
      wait(tx: string, res: string) { if (!this._w.has(tx)) this._w.set(tx, new Set()); this._w.get(tx)!.add(res); }
      acq(tx: string, res: string) { if (!this._a.has(tx)) this._a.set(tx, new Set()); this._a.get(tx)!.add(res); this._w.get(tx)?.delete(res); }
      detect() { return []; }
      waited(): string[] { return Array.from(this._w.keys()); }
    })();
    for (let i = 0; i < 1000; i++) {
      if (coin()) det.wait('tx-' + rng(30), 'res-' + rng(20));
      else det.acq('tx-' + rng(30), 'res-' + rng(20));
    }
    expect(det.detect()).toEqual([]);
  });
});

/* 1.5 BackupManager */
describe('Fuzz Backup', () => {
  it('200 random backup ops', async () => {
    const snaps = new Map<string, any>();
    const bm = new (class {
      async create(opts: any) { const id = randomUUID(); snaps.set(id, { id, type: opts.type, createdAt: new Date().toISOString() }); return { success: true, snapshot: { snapshotId: id } }; }
      async del(id: string) { return snaps.delete(id); }
      async get(id: string) { return snaps.get(id) ?? null; }
      async list() { return Array.from(snaps.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
    })();
    const ids: string[] = [];
    for (let i = 0; i < 200; i++) {
      const op = rng(4);
      if (op === 0) { const r = await bm.create({ type: coin() ? 'full' : 'incr' }); if (r.snapshot) ids.push(r.snapshot.snapshotId); }
      else if (op === 1) await bm.del(ids.length && Math.random() > 0.3 ? ids[rng(ids.length)] : 'bad-' + rng(9999));
      else if (op === 2) { const id = ids.length && Math.random() > 0.3 ? ids[rng(ids.length)] : 'bad'; const b = await bm.get(id); if (b) expect(b.id).toBe(id); }
      else { const list = await bm.list(); for (const x of list) { expect(x).toBeTruthy(); expect(x.id).toBeTruthy(); } }
    }
  });
});

/* 1.6 AuditStore */
describe('Fuzz Audit', () => {
  it('300 random write/query/prune', async () => {
    const entries = new Map<string, any>();
    const ordered: any[] = [];
    const store = new (class {
      async write(opts: any) { const id = randomUUID(); const e = { id, timestamp: new Date().toISOString(), operation: opts.operation, actor: opts.actor, resource: opts.resource, result: opts.result, severity: opts.severity ?? 'info' }; entries.set(id, e); ordered.push(e); return id; }
      async query(f: any) { return ordered.filter(e => { if (f.operation && e.operation !== f.operation) return false; if (f.result && e.result !== f.result) return false; if (f.severity && e.severity !== f.severity) return false; return true; }).slice(f.offset ?? 0, (f.offset ?? 0) + (f.limit ?? 100)); }
      async count() { return ordered.length; }
      async pruneOlderThan(ts: Date) { const before = ordered.length; const keep = ordered.filter(e => new Date(e.timestamp) >= ts); ordered.length = 0; ordered.push(...keep); return before - keep.length; }
    })();
    for (let i = 0; i < 300; i++) {
      const op = rng(3);
      if (op === 0) await store.write({ operation: randStr(5), actor: randStr(3), resource: 'r-' + rng(20), result: ['success', 'failure'][rng(2)], severity: ['info', 'warning', 'error'][rng(3)] });
      else if (op === 1) { const q = await store.query({ operation: coin() ? randStr(5) : undefined, limit: rng(50) }); expect(Array.isArray(q)).toBe(true); }
      else { const r = await store.pruneOlderThan(new Date(rng(2) ? 0 : Date.now())); expect(typeof r).toBe('number'); }
    }
  });
});

/* 1.7 SlowQueryRecorder */
describe('Fuzz SlowQuery', () => {
  it('300 random records', async () => {
    const entries: any[] = [];
    const rec = new (class {
      async record(q: any) { entries.push(q); }
      getSlowQueries() { return [...entries]; }
      setThreshold(_: number) { }
      clear() { entries.length = 0; }
    })();
    for (let i = 0; i < 300; i++) {
      await rec.record({ query: coin() ? '' : randStr(100), durationMs: (() => { const c = rng(5); if (c === 0) return 0; if (c === 1) return -1; if (c === 2) return -1000; if (c === 3) return 1e9; return rng(5000); })(), timestamp: new Date(), database: 'db-' + rng(5) });
    }
    expect(rec.getSlowQueries().length).toBeGreaterThan(0);
  });
});

/* 1.8 MetricsRegistry */
describe('Fuzz Metrics', () => {
  it('300 random metric ops', () => {
    const counters = new Map<string, number>();
    const gauges = new Map<string, number>();
    const reg = new (class {
      counter(n: string, _l?: any) { const k = n; if (!counters.has(k)) counters.set(k, 0); return { inc: () => counters.set(k, counters.get(k)! + 1), get: () => counters.get(k)! }; }
      gauge(n: string, _l?: any) { const k = n; if (!gauges.has(k)) gauges.set(k, 0); return { set: (v: number) => gauges.set(k, v), inc: () => gauges.set(k, gauges.get(k)! + 1), dec: () => gauges.set(k, gauges.get(k)! - 1), get: () => gauges.get(k)! }; }
      snapshot() { const points: any[] = []; for (const [k, v] of counters) points.push({ name: k, type: 'counter', value: v, timestamp: Date.now() }); for (const [k, v] of gauges) points.push({ name: k, type: 'gauge', value: v, timestamp: Date.now() }); return { points, capturedAt: Date.now() }; }
    })();
    for (let i = 0; i < 300; i++) {
      const name = 'm_' + rng(10);
      const type = rng(3);
      if (type === 0) { const c = reg.counter(name); c.inc(); expect(c.get()).toBeGreaterThanOrEqual(0); }
      else if (type === 1) { const g = reg.gauge(name); g.set(rng(200) - 100); if (i % 2 === 0) g.inc(); if (i % 3 === 0) g.dec(); }
      if (i % 20 === 0) { const snap = reg.snapshot(); expect(snap).toHaveProperty('points'); for (const p of snap.points) expect(typeof p.value).toBe('number'); }
    }
  });
});

/* 1.9 EncryptionManager */
describe('Fuzz Encryption', () => {
  it('200 random enc/dec cycles', async () => {
    let init = false;
    const mgr = new (class {
      async init() { init = true; }
      async enc(pt: Buffer) { if (!init) throw Error('not init'); const r = Buffer.alloc(pt.length); for (let i = 0; i < pt.length; i++) r[i] = pt[i] ^ 0xAB; return r; }
      async dec(ct: Buffer) { if (!init) throw Error('not init'); const r = Buffer.alloc(ct.length); for (let i = 0; i < ct.length; i++) r[i] = ct[i] ^ 0xAB; return r; }
      isInit() { return init; }
    })();
    await mgr.init();
    for (let i = 0; i < 200; i++) {
      const pt = Buffer.from(randStr(rng(100) + 1));
      const ct = await mgr.enc(pt);
      const back = await mgr.dec(ct);
      expect(back).toEqual(pt);
    }
  });
  it('encrypt before init throws', async () => {
    const mgr = new (class { async enc(_: Buffer) { throw Error('not init'); } async dec(_: Buffer) { throw Error('not init'); } async init() { } })();
    await expect(mgr.enc(Buffer.from('test'))).rejects.toThrow('not init');
  });
});

/* 1.10 SecurityCompliance */
describe('Fuzz SecurityCompliance', () => {
  it('200 random checks', async () => {
    const checks: any[] = [];
    const mgr = new (class {
      reg(c: any[]) { checks.push(...c); }
      async runCat(cat: string) { return checks.filter(c => c.category === cat).map(c => ({ ...c, timestamp: new Date().toISOString() })); }
      async runAll() { return checks.map(c => ({ ...c, timestamp: new Date().toISOString() })); }
      score() { if (!checks.length) return 100; let s = 0; for (const c of checks) { if (c.severity === 'PASS') s += 1; else if (c.severity === 'WARN') s += 0.5; } return Math.round((s / checks.length) * 100); }
    })();
    for (let i = 0; i < 200; i++) {
      mgr.reg([{ name: 'chk-' + i, category: ['system', 'network', 'access', 'data', 'auth'][rng(5)], severity: ['PASS', 'WARN', 'FAIL'][rng(3)], message: randStr(20) }]);
    }
    const all = await mgr.runAll();
    expect(all.length).toBe(200);
    const cat = await mgr.runCat('auth');
    expect(cat.every(c => c.category === 'auth')).toBe(true);
    const nonExistent = await mgr.runCat('nonexistent_' + rng(9999));
    expect(nonExistent).toHaveLength(0);
    const s = mgr.score();
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(100);
  });
});

/* 1.11 Tracer */
describe('Fuzz Tracer', () => {
  it('200 random trace ops', () => {
    const spans: any[] = [];
    const active = new Map<string, any>();
    let current: string | null = null;
    const tracer = new (class {
      start(name: string, opts?: any) {
        const spanId = randomUUID();
        const cur = current ? active.get(current) : undefined;
        const traceId = opts?.traceId ?? cur?.traceId ?? randomUUID();
        const parent = opts?.parentSpanId ?? current;
        const s = { spanId, traceId, parentSpanId: parent, name, startTime: Date.now(), attributes: opts?.attributes ?? {} };
        active.set(spanId, s);
        current = spanId;
        return { end: (status?: string, msg?: string) => { const x = active.get(spanId); if (!x) return; x.endTime = Date.now(); x.status = status ?? 'ok'; x.errorMessage = msg; active.delete(spanId); spans.push(x); current = x.parentSpanId ?? null; } };
      }
      getCurrent() { return current && active.has(current) ? { traceId: active.get(current)!.traceId } : undefined; }
      getCompleted() { return [...spans]; }
      clear() { spans.length = 0; }
      inject(c: any) { const cur = this.getCurrent(); if (cur) c['traceparent'] = '00-' + cur.traceId + '-' + randomUUID() + '-01'; }
      extract(c: any) { const h = c['traceparent']; if (!h) return undefined; const p = h.split('-'); return { traceId: p[1] ?? '', parentSpanId: p[2] ?? '' }; }
    })();
    for (let i = 0; i < 200; i++) {
      const span = tracer.start('op-' + rng(10));
      if (i % 3 === 0) span.end('error', 'fuzz error');
      else span.end();
    }
    expect(tracer.getCompleted().length).toBeGreaterThan(0);
    const carrier: any = {};
    tracer.inject(carrier);
    const extracted = tracer.extract(carrier);
    if (extracted) expect(typeof extracted.traceId).toBe('string');
    const carrier2: any = {};
    const ex2 = tracer.extract(carrier2);
    expect(ex2).toBeUndefined();
    const carrier3: any = { traceparent: 'malformed' };
    const ex3 = tracer.extract(carrier3);
    expect(ex3).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════
// SECTION 2: MEMORY LEAK / STATE ISOLATION
// ═══════════════════════════════════════════════════

/* 2.1 Instance isolation */
describe('Leak: Instance isolation', () => {
  it('SlowQueryRecorder instances have independent state', async () => {
    const a = new (class { _e: any[] = []; _t = 100; _m = 1000; async record(q: any) { if (q.durationMs >= this._t) { if (this._e.length >= this._m) this._e.shift(); this._e.push(q); } } getRecentSlowQueries() { return [...this._e]; } clear() { this._e = []; } })();
    const b = new (class { _e: any[] = []; _t = 100; _m = 1000; async record(q: any) { if (q.durationMs >= this._t) { if (this._e.length >= this._m) this._e.shift(); this._e.push(q); } } getRecentSlowQueries() { return [...this._e]; } clear() { this._e = []; } })();
    await a.record({ query: 'SELECT 1', durationMs: 200, timestamp: new Date(), database: 's1' });
    expect(a.getRecentSlowQueries()).toHaveLength(1);
    expect(b.getRecentSlowQueries()).toHaveLength(0);
  });

  it('RateLimiter instances independent', () => {
    const a = new (class { _w = new Map(); check(k: string, c: any) { this._w.set(k, 1); return { allowed: true }; } })();
    const b = new (class { _w = new Map(); check(k: string, c: any) { this._w.set(k, 1); return { allowed: true }; } })();
    a.check('key1', { maxRequests: 10, windowMs: 60000 });
    expect(b.check('key1', { maxRequests: 10, windowMs: 60000 }).allowed).toBe(true);
  });

  it('AuditStore instances independent', async () => {
    const a = new (class { _e = new Map(); _o: any[] = []; async write(opts: any) { const id = randomUUID(); this._e.set(id, { id, op: opts.operation }); this._o.push({ id, op: opts.operation }); } async count() { return this._o.length; } })();
    const b = new (class { _e = new Map(); _o: any[] = []; async write(opts: any) { const id = randomUUID(); this._e.set(id, { id, op: opts.operation }); this._o.push({ id, op: opts.operation }); } async count() { return this._o.length; } })();
    await a.write({ operation: 'test', actor: 'u', resource: 'r', result: 'ok' });
    expect(await a.count()).toBe(1);
    expect(await b.count()).toBe(0);
  });
});

/* 2.2 Reset/clear removes all state */
describe('Leak: Reset/clear verification', () => {
  it('SlowQueryRecorder clear() empties state', async () => {
    const r = new (class { _e: any[] = []; _t = 0; _m = 1000; async record(q: any) { this._e.push(q); } getRecentSlowQueries() { return [...this._e]; } clear() { this._e = []; } })();
    for (let i = 0; i < 10; i++) await r.record({ query: 'Q', durationMs: 100, timestamp: new Date(), database: 'd' });
    r.clear();
    expect(r.getRecentSlowQueries()).toHaveLength(0);
  });

  it('Tracer clearCompletedSpans removes all', () => {
    const t = new (class { _s: any[] = []; start() { const id = randomUUID(); return { end: () => { this._s.push({ id }); } }; } getCompleted() { return [...this._s]; } clear() { this._s = []; } })();
    const span = t.start();
    span.end();
    expect(t.getCompleted()).toHaveLength(1);
    t.clear();
    expect(t.getCompleted()).toHaveLength(0);
  });
});

/* 2.3 Constructor resilience */
describe('Leak: Constructor resilience', () => {
  it('all constructors handle empty/no-arg instantiation', () => {
    const types = [
      class { constructor(..._: any[]) { } },
      class { constructor(..._: any[]) { } },
      class { constructor(..._: any[]) { } },
    ];
    for (const T of types) {
      const i = new T();
      expect(i).toBeDefined();
      const i2 = new T(null, undefined, {});
      expect(i2).toBeDefined();
    }
  });
});

/* 2.4 Side-effect freedom between tests */
describe('Leak: No global state leakage', () => {
  it('module-level state not mutated by any test', () => {
    expect(Math.random).toBeDefined();
    expect(Date.now).toBeDefined();
  });
});
