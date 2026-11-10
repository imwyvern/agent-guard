# agent-guard v0.1 local benchmark

Generated 2026-11-10T10:58:25.234Z. Node v24.22.1; linux 6.12.113+ x64; Intel(R) Xeon(R) Processor; 8 logical CPUs.

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
      "requests": 7223,
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
        "p50": 1.8743949999998222,
        "p95": 9.025605999999698,
        "p99": 12.323093999999855
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
      "requests": 7094,
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
        "p50": 2.184473999999682,
        "p95": 5.961912000000666,
        "p99": 11.901676999999836
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
            "p99": 9
          },
          {
            "p50": 4,
            "p99": 9
          },
          {
            "p50": 5,
            "p99": 9
          }
        ],
        "off": [
          {
            "p50": 3,
            "p99": 7
          },
          {
            "p50": 3,
            "p99": 7
          },
          {
            "p50": 3,
            "p99": 7
          }
        ]
      },
      "off": {
        "p50": 3,
        "p99": 7
      },
      "on": {
        "p50": 4,
        "p99": 9
      },
      "delta": {
        "p50": 1,
        "p99": 2
      }
    },
    {
      "demo": "node",
      "samples": {
        "on": [
          {
            "p50": 4,
            "p99": 10
          },
          {
            "p50": 4,
            "p99": 9
          },
          {
            "p50": 4,
            "p99": 8
          }
        ],
        "off": [
          {
            "p50": 3,
            "p99": 7
          },
          {
            "p50": 3,
            "p99": 7
          },
          {
            "p50": 3,
            "p99": 7
          }
        ]
      },
      "off": {
        "p50": 3,
        "p99": 7
      },
      "on": {
        "p50": 4,
        "p99": 9
      },
      "delta": {
        "p50": 1,
        "p99": 2
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
  "status": "failed",
  "error": "expected five Lighthouse reports per URL"
}
```
