-- A postpaid bill stream is discovered from the SIM that actually receives an
-- authentic carrier bill SMS. Concurrent ingestion must not create two active
-- streams for the same receiving SIM.

CREATE UNIQUE INDEX idx_carrier_billing_accounts_active_notification_sim
    ON carrier_billing_accounts(notification_sim_iccid)
    WHERE status = 'active';
