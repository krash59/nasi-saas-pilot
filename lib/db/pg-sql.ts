import { Pool } from "pg";

export type SqlQuery = ((
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<Record<string, unknown>[]>) & {
  withTenant?: <T>(customerId: string, fn: (tx: SqlQuery) => Promise<T>) => Promise<T>;
};

const pools = new Map<string, Pool>();

export async function closePgPools(): Promise<void> {
  await Promise.all([...pools.values()].map(pool => pool.end()));
  pools.clear();
}

function poolFor(connectionString: string): Pool {
  let pool = pools.get(connectionString);
  if (!pool) {
    pool = new Pool({ connectionString, max: 10 });
    pools.set(connectionString, pool);
  }
  return pool;
}

/** Tagged-template SQL for direct PostgreSQL (local Docker, RDS, etc.). */
export function createPgSql(connectionString: string): SqlQuery {
  const pool = poolFor(connectionString);
  const queryFor = (client: Pick<Pool, "query">): SqlQuery => async (strings, ...values) => {
    let text = "";
    const params: unknown[] = [];
    for (let i = 0; i < strings.length; i++) {
      text += strings[i];
      if (i < values.length) {
        params.push(values[i]);
        text += `$${params.length}`;
      }
    }
    const result = await client.query(text, params);
    return result.rows;
  };
  const sql = queryFor(pool);
  sql.withTenant = async (customerId, fn) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_customer_id', $1, true)", [customerId]);
      const result = await fn(queryFor(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };
  return sql;
}
