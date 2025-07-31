#!/usr/bin/env bash

echo "Running SMS Dashboard Daemon Tests..."
echo "===================================="

# Run the tests
if zig test src/tests.zig; then
    echo ""
    echo "✅ Test suite completed successfully!"
    echo ""
    
    # Run coverage report
    if zig build-exe coverage.zig 2>/dev/null; then
        ./coverage
        rm -f coverage coverage.o
    fi
    
    exit 0
else
    echo ""
    echo "❌ Some tests failed!"
    exit 1
fi