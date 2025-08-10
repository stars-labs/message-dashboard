#!/usr/bin/env node

// Script to manually fix modem_state records that are missing signal data

const modemStateFixes = [
  {
    modem_id: '865827078904323',
    connection_status: 'registered',
    signal_percent: 100,
    rssi: -44,
    rsrq: -4,
    rsrp: -68,
    snr: 30
  }
];

async function fixModemStates() {
  console.log('Fixing modem_state records...');
  
  // Create SQL statements
  const statements = modemStateFixes.map(fix => {
    return `
      INSERT INTO modem_state (modem_id, connection_status, signal_percent, rssi, rsrq, rsrp, snr, updated_at)
      VALUES ('${fix.modem_id}', '${fix.connection_status}', ${fix.signal_percent}, ${fix.rssi}, ${fix.rsrq}, ${fix.rsrp}, ${fix.snr}, CURRENT_TIMESTAMP)
      ON CONFLICT(modem_id) DO UPDATE SET
        connection_status = excluded.connection_status,
        signal_percent = excluded.signal_percent,
        rssi = excluded.rssi,
        rsrq = excluded.rsrq,
        rsrp = excluded.rsrp,
        snr = excluded.snr,
        updated_at = CURRENT_TIMESTAMP;
    `;
  });
  
  console.log('SQL statements to execute:');
  statements.forEach(stmt => console.log(stmt));
  
  console.log('\nTo apply these fixes, run:');
  console.log('npx wrangler d1 execute sms-dashboard --command "..." --remote');
}

fixModemStates();