-- Synthetic nonproduction subscription bindings. Provisioning is operator-owned;
-- webhook payloads can never create or rebind a tenant's provider identity.
CREATE TABLE IF NOT EXISTS pilot_billing_accounts (
  customer_id UUID PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  stripe_customer_id TEXT NOT NULL UNIQUE,
  stripe_subscription_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'inactive' CHECK (status IN
    ('inactive','active','trialing','past_due','canceled','unpaid','incomplete','incomplete_expired','paused')),
  last_event_created BIGINT NOT NULL DEFAULT 0,
  last_event_id TEXT,
  reconciliation_required BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS pilot_billing_events (
  event_id TEXT PRIMARY KEY,
  customer_id UUID NOT NULL REFERENCES pilot_billing_accounts(customer_id) ON DELETE CASCADE,
  event_created BIGINT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE pilot_billing_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pilot_billing_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE pilot_billing_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE pilot_billing_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pilot_billing_accounts_isolation ON pilot_billing_accounts;
CREATE POLICY pilot_billing_accounts_isolation ON pilot_billing_accounts FOR ALL
  USING (customer_id=app_current_customer_id()) WITH CHECK (customer_id=app_current_customer_id());
DROP POLICY IF EXISTS pilot_billing_events_isolation ON pilot_billing_events;
CREATE POLICY pilot_billing_events_isolation ON pilot_billing_events FOR ALL
  USING (customer_id=app_current_customer_id()) WITH CHECK (customer_id=app_current_customer_id());
