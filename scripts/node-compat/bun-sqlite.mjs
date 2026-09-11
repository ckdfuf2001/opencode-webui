// Node.js (bun 차단 환경) 용 bun:sqlite 대체 구현.
// node:sqlite(stdlib, 추가 바이너리 없음) 위에 bun:sqlite 표면을 얹는다.
// 로더(loader.mjs)가 `bun:sqlite` import를 이 파일로 돌린다.
//
// 지원하는 표면 (backend/src 실제 사용분):
//   new Database(path[, { readonly }]) / .prepare() / .query()
//   .exec() / .close() / stmt .all()/.get()/.run()
//   run() 결과 { changes, lastInsertRowid } (Number로 정규화)
import { DatabaseSync } from 'node:sqlite';

// node:sqlite는 boolean 바인딩을 거부하지만 bun:sqlite는 0/1로 받아준다.
// 런타임별 동작 통일을 위해 여기서 강제한다 (backend 전체가 ?1:0 컨벤션이지만
// 실수로 boolean이 넘어와도 node에서 터지지 않게).
function bindable(params) {
  return params.map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v));
}

class Statement {
  constructor(inner) {
    this._inner = inner;
  }
  all(...params) {
    return this._inner.all(...bindable(params));
  }
  get(...params) {
    return this._inner.get(...bindable(params));
  }
  run(...params) {
    const r = this._inner.run(...bindable(params));
    return {
      changes: Number(r.changes ?? 0),
      lastInsertRowid: Number(r.lastInsertRowid ?? 0),
    };
  }
}

export class Database {
  constructor(path, options = {}) {
    const opts = options ?? {};
    const readOnly = Boolean(opts.readonly ?? opts.readOnly ?? false);
    this._db = new DatabaseSync(path, { open: true, readOnly });
  }
  prepare(sql) {
    return new Statement(this._db.prepare(String(sql)));
  }
  query(sql) {
    return this.prepare(sql);
  }
  run(sql, ...params) {
    // DDL/트랜잭션용. 바인딩이 있으면 prepare().run(), 없으면 exec()
    // (node prepare는 다중문 불가, exec는 바인딩 불가라 구분).
    if (params.length > 0) {
      const r = this._db.prepare(String(sql)).run(...bindable(params));
      return {
        changes: Number(r.changes ?? 0),
        lastInsertRowid: Number(r.lastInsertRowid ?? 0),
      };
    }
    this._db.exec(String(sql));
    return { changes: 0, lastInsertRowid: 0 };
  }
  exec(sql) {
    this._db.exec(String(sql));
  }
  close() {
    this._db.close();
  }
}

// 타입 전용 import(`import type { Database, SQLQueryBindings }`)는
// node 타입 스트리핑 단계에서 지워지므로 값 export는 Database만 있으면 된다.
