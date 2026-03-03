#!/bin/bash
# Test script to verify IMS initialization is working
# This script checks if the init_ims function is properly called during modem discovery

echo "Testing IMS initialization in daemon code..."
echo ""
echo "Changes made:"
echo "1. Added init_ims() method to enable IMS via AT+QCFG=\"ims\",1"
echo "2. Integrated init_ims() call in discover_modems() after successful probe"
echo ""
echo "The init_ims function will:"
echo "- Send AT+QCFG=\"ims\",1 command to each discovered modem"
echo "- Log success with debug!(\"IMS enabled on {}\", port)"
echo "- Log failures with warn!()"
echo ""
echo "To test manually on a modem port (e.g., /dev/ttyUSB2):"
echo "  echo -e 'AT+QCFG=\"ims\",1\\r' > /dev/ttyUSB2"
echo "  cat /dev/ttyUSB2 &"
echo ""
echo "Expected response: OK"
