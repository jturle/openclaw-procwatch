#!/bin/bash
# Procwatch test script - runs for ~60 seconds

echo "Starting procwatch test (60 seconds)..."
echo "PID: $$"

for i in {1..15}; do
    echo "[$(date +%H:%M:%S)] tick $i - all good"
    sleep 2
done

echo "[$(date +%H:%M:%S)] WARNING: Something looks off..."
sleep 2

echo "[$(date +%H:%M:%S)] ERROR: Test failure triggered!"
sleep 2

for i in {16..25}; do
    echo "[$(date +%H:%M:%S)] tick $i - recovering"
    sleep 2
done

echo "[$(date +%H:%M:%S)] Test complete (60 seconds)."
