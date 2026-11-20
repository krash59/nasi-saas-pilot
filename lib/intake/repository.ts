import { getSql, withCustomerContext, type SqlClient } from "@/lib/db/client";
import { requireCustomer } from "@/lib/tenant/customer";
import { PROTOCOL_VERSION } from "@/lib/intake/protocol";
import { projectIntake, type IntakeEvent, type IntakeEventType, type IntakeView } from "@/lib/intake/project";

/**
 * Append-only intake log (design v3 R1). Each project's events carry seq 1, 2, 3 ... (UNIQUE (project_id, seq)).
 * The project row is locked (SELECT ... FOR UPDATE) BEFORE the log is read, so every action sees the latest state and
 * concurrent actions on one project run one after another; seq = max+1 is then gap-free (UNIQUE (project_id, seq) backs it).
 * There is deliberately no automatic retry: re-running an answer on a newer state could bind it to a question the
 * customer never saw (verified against PostgreSQL/Marten/KurrentDB docs, implementation_verification.md).
 */
type NewEvent = Omit<IntakeEvent, "seq"> & { event_type: IntakeEventType };

async function readEvents(tx: SqlClient, projectId: string): Promise<IntakeEvent[]> {
  const rows = await tx`SELECT seq, event_type, question_id, message_id, item_id, verbatim_text, status
    FROM intake_events WHERE project_id = ${projectId}::uuid ORDER BY seq ASC`;
  return (rows as unknown as IntakeEvent[]).map((r) => ({ ...r, message_id: r.message_id ? String(r.message_id) : null }));
}

/** Caller must hold the project lock (withIntake takes it). */
export async function appendIntakeEventsTx(tx: SqlClient, projectId: string, customerId: string, events: NewEvent[]) {
  const max = await tx`SELECT COALESCE(MAX(seq), 0)::int AS n FROM intake_events WHERE project_id = ${projectId}::uuid`;
  let n = Number((max[0] as { n: number }).n);
  for (const e of events) {
    n += 1;
    await tx`INSERT INTO intake_events (project_id, customer_id, seq, protocol_version, event_type, question_id, message_id, item_id, verbatim_text, status)
      VALUES (${projectId}::uuid, ${customerId}::uuid, ${n}, ${PROTOCOL_VERSION}, ${e.event_type}, ${e.question_id ?? null},
              ${e.message_id ?? null}::uuid, ${e.item_id ?? null}, ${e.verbatim_text ?? null}, ${e.status ?? null})`;
  }
  return projectIntake(await readEvents(tx, projectId));
}

export async function withIntake<T>(projectId: string, fn: (tx: SqlClient, customerId: string, view: IntakeView, events: IntakeEvent[]) => Promise<T>) {
  const customer = await requireCustomer();
  return withCustomerContext(getSql(process.env.DATABASE_URL!), customer.id, async (tx) => {
    const locked = await tx`SELECT id FROM projects WHERE id = ${projectId}::uuid FOR UPDATE`;
    if (!locked.length) throw new Error("NOT_FOUND");
    const events = await readEvents(tx, projectId);
    return fn(tx, customer.id, projectIntake(events), events);
  });
}

export async function getIntakeView(projectId: string) {
  return withIntake(projectId, async (_tx, _c, view, events) => ({ view, eventCount: events.length }));
}

/**
 * v3 applies to a project that already has intake events, or that has no customer chat messages yet (new projects).
 * Projects whose chat began under the old flow keep the old summary editor (no position-based backfill: that would be ad hoc).
 */
export async function intakeModeTx(tx: SqlClient, projectId: string): Promise<"v3" | "legacy"> {
  const r = await tx`SELECT
      EXISTS (SELECT 1 FROM intake_events WHERE project_id = ${projectId}::uuid) AS has_events,
      EXISTS (SELECT 1 FROM design_messages WHERE project_id = ${projectId}::uuid AND role = 'customer') AS has_customer_msgs`;
  const row = r[0] as { has_events: boolean; has_customer_msgs: boolean };
  return row.has_events || !row.has_customer_msgs ? "v3" : "legacy";
}

export async function getIntakeMode(projectId: string) {
  const customer = await requireCustomer();
  return withCustomerContext(getSql(process.env.DATABASE_URL!), customer.id, (tx) => intakeModeTx(tx, projectId));
}
