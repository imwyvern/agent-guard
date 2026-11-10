# agent-guard v0.1 local benchmark

Generated 2026-11-10T10:20:43.835Z. Node v24.22.1; linux 6.12.113+ x64; Intel(R) Xeon(R) Processor; 8 logical CPUs.

All requests target local demo listeners and a local signed webhook receiver; DNS is injected. No external sites are contacted. Raw results: bench/results/ (ignored). Medians use three runs.

## simulate

```json
{
  "status": "passed",
  "runs": [
    {
      "demo": "express",
      "transport": "127.0.0.1 TCP",
      "sessions": {
        "S1": 200,
        "S2": 20,
        "S3": 20,
        "S4": 50,
        "S5": 50
      },
      "requests": 6979,
      "humanFalsePositives": 0,
      "verifiedFalsePositives": 0,
      "verified404": 100,
      "maliciousDetected": 120,
      "maliciousSessions": 120,
      "detectionRate": 1,
      "replays": 350,
      "expectedReplays": 350,
      "replayDetection": 1,
      "invalidSignatures": 0,
      "alerts": 600,
      "alertLatencyMs": {
        "p50": 2.3099739999997837,
        "p95": 7.617757999999867,
        "p99": 32.224678999999924
      }
    },
    {
      "demo": "node",
      "transport": "127.0.0.1 TCP",
      "sessions": {
        "S1": 200,
        "S2": 20,
        "S3": 20,
        "S4": 50,
        "S5": 50
      },
      "requests": 7105,
      "humanFalsePositives": 0,
      "verifiedFalsePositives": 0,
      "verified404": 100,
      "maliciousDetected": 120,
      "maliciousSessions": 120,
      "detectionRate": 1,
      "replays": 350,
      "expectedReplays": 350,
      "replayDetection": 1,
      "invalidSignatures": 0,
      "alerts": 600,
      "alertLatencyMs": {
        "p50": 1.650589000000764,
        "p95": 5.042928999999276,
        "p99": 8.86595699999998
      }
    }
  ]
}
```

## latency

```json
{
  "status": "failed",
  "transport": "autocannon TCP",
  "warmup": "3 seconds per mode",
  "runs": 3,
  "connections": 100,
  "durationSeconds": 30,
  "rows": [
    {
      "demo": "express",
      "samples": {
        "on": [
          {
            "p50": 4,
            "p99": 8
          },
          {
            "p50": 4,
            "p99": 8
          },
          {
            "p50": 4,
            "p99": 7
          }
        ],
        "off": [
          {
            "p50": 3,
            "p99": 5
          },
          {
            "p50": 3,
            "p99": 5
          },
          {
            "p50": 3,
            "p99": 5
          }
        ]
      },
      "off": {
        "p50": 3,
        "p99": 5
      },
      "on": {
        "p50": 4,
        "p99": 8
      },
      "delta": {
        "p50": 1,
        "p99": 3
      }
    },
    {
      "demo": "node",
      "samples": {
        "on": [
          {
            "p50": 4,
            "p99": 7
          },
          {
            "p50": 4,
            "p99": 8
          },
          {
            "p50": 4,
            "p99": 7
          }
        ],
        "off": [
          {
            "p50": 2,
            "p99": 4
          },
          {
            "p50": 2,
            "p99": 4
          },
          {
            "p50": 2,
            "p99": 4
          }
        ]
      },
      "off": {
        "p50": 2,
        "p99": 4
      },
      "on": {
        "p50": 4,
        "p99": 7
      },
      "delta": {
        "p50": 2,
        "p99": 3
      }
    }
  ],
  "memory": {
    "clients": 50000,
    "heapDeltaBytes": 8241040,
    "gc": true
  },
  "numericPassed": false
}
```

## lighthouse

```json
{
  "status": "skipped",
  "reason": "Chrome cannot start in sandbox: [46:46:1110/020902.162651:ERROR:third_party/crashpad/crashpad/util/linux/socket.cc:45] setsockopt: Operation not permitted (1)"
}
```
