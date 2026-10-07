import { DatabaseSync } from "node:sqlite";
import type { SqlDatabase, SqlRow, SqlValue } from "@codewise/index-core";

export class NodeSqlDatabase implements SqlDatabase {
  public constructor(
    private readonly database: DatabaseSync,
    private readonly ownsDatabase: boolean
  ) {}

  public all(
    sql: string,
    parameters: readonly SqlValue[] = []
  ): readonly SqlRow[] {
    return this.database.prepare(sql).all(...parameters);
  }

  public close(): void {
    if (this.ownsDatabase) {
      this.database.close();
    }
  }
}
