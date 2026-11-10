# agent-guard v0.1 local benchmark

Generated 2026-11-10T12:03:01.409Z. Node v24.22.1; linux 6.12.113+ x64; Intel(R) Xeon(R) Processor; 8 logical CPUs.

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
      "requests": 7181,
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
        "p50": 2.435860000000048,
        "p95": 7.96491200000014,
        "p99": 37.06471399999987
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
      "requests": 7060,
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
        "p50": 2.1555799999987357,
        "p95": 6.1698469999992085,
        "p99": 8.945114000000103
      }
    }
  ]
}
```

## latency

The TCP latency gate remains autocannon on the home page with a browser UA, 100 connections, 30 seconds per run, and medians of three runs: on-minus-off p50 <= 0.2 ms, p99 <= 1 ms, plus the 50k-client memory limit. Each TCP demo server runs in a separate child process.

Supplementary measurements are **non-gating**: a fixed overallRate near 50% of median saturated off throughput, the same rate for both modes, 100 connections, and three 10-second runs per mode. JSON preserves unrounded autocannon latency histogram fields (including p50, p97_5, and p99 when available); integer-ms quantization in autocannon is not additional precision. serviceTimeDeltaUs is 1e6/rps_on - 1e6/rps_off using median saturated throughput, a throughput-derived estimate rather than direct service timing. An EPERM fallback is partial, skips these TCP measurements, and cannot establish a TCP gate pass.

```json
{
  "status": "failed",
  "transport": "autocannon TCP; each demo server in a separate child process",
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
            "p50": 2,
            "p99": 3,
            "p97_5": 2,
            "latency": {
              "average": 1.62,
              "mean": 1.62,
              "stddev": 1.54,
              "min": 1,
              "max": 126,
              "p0_001": 0,
              "p0_01": 0,
              "p0_1": 0,
              "p1": 1,
              "p2_5": 1,
              "p10": 1,
              "p25": 1,
              "p50": 2,
              "p75": 2,
              "p90": 2,
              "p97_5": 2,
              "p99": 3,
              "p99_9": 11,
              "p99_99": 66,
              "p99_999": 126,
              "totalCount": 1418871
            },
            "requestsPerSecond": 47279.94001999333,
            "errors": 0,
            "timeouts": 0,
            "non2xx": 0
          },
          {
            "p50": 2,
            "p99": 3,
            "p97_5": 2,
            "latency": {
              "average": 1.71,
              "mean": 1.71,
              "stddev": 1.3,
              "min": 1,
              "max": 112,
              "p0_001": 0,
              "p0_01": 0,
              "p0_1": 0,
              "p1": 1,
              "p2_5": 1,
              "p10": 1,
              "p25": 1,
              "p50": 2,
              "p75": 2,
              "p90": 2,
              "p97_5": 2,
              "p99": 3,
              "p99_9": 7,
              "p99_99": 56,
              "p99_999": 112,
              "totalCount": 1401147
            },
            "requestsPerSecond": 46689.3368877041,
            "errors": 0,
            "timeouts": 0,
            "non2xx": 0
          },
          {
            "p50": 2,
            "p99": 4,
            "p97_5": 3,
            "latency": {
              "average": 1.89,
              "mean": 1.89,
              "stddev": 1.33,
              "min": 1,
              "max": 129,
              "p0_001": 0,
              "p0_01": 0,
              "p0_1": 0,
              "p1": 1,
              "p2_5": 1,
              "p10": 1,
              "p25": 2,
              "p50": 2,
              "p75": 2,
              "p90": 2,
              "p97_5": 3,
              "p99": 4,
              "p99_9": 9,
              "p99_99": 29,
              "p99_999": 129,
              "totalCount": 1363368
            },
            "requestsPerSecond": 45430.45651449516,
            "errors": 0,
            "timeouts": 0,
            "non2xx": 0
          }
        ],
        "off": [
          {
            "p50": 1,
            "p99": 2,
            "p97_5": 2,
            "latency": {
              "average": 1.14,
              "mean": 1.14,
              "stddev": 1.47,
              "min": 1,
              "max": 142,
              "p0_001": 0,
              "p0_01": 0,
              "p0_1": 0,
              "p1": 1,
              "p2_5": 1,
              "p10": 1,
              "p25": 1,
              "p50": 1,
              "p75": 1,
              "p90": 2,
              "p97_5": 2,
              "p99": 2,
              "p99_9": 7,
              "p99_99": 62,
              "p99_999": 142,
              "totalCount": 1644094
            },
            "requestsPerSecond": 54784.87170943019,
            "errors": 0,
            "timeouts": 0,
            "non2xx": 0
          },
          {
            "p50": 1,
            "p99": 3,
            "p97_5": 2,
            "latency": {
              "average": 1.09,
              "mean": 1.09,
              "stddev": 1.25,
              "min": 1,
              "max": 101,
              "p0_001": 0,
              "p0_01": 0,
              "p0_1": 0,
              "p1": 0,
              "p2_5": 1,
              "p10": 1,
              "p25": 1,
              "p50": 1,
              "p75": 1,
              "p90": 1,
              "p97_5": 2,
              "p99": 3,
              "p99_9": 6,
              "p99_99": 91,
              "p99_999": 101,
              "totalCount": 1769573
            },
            "requestsPerSecond": 58966.11129623459,
            "errors": 0,
            "timeouts": 0,
            "non2xx": 0
          },
          {
            "p50": 1,
            "p99": 3,
            "p97_5": 2,
            "latency": {
              "average": 1.1,
              "mean": 1.1,
              "stddev": 0.53,
              "min": 1,
              "max": 23,
              "p0_001": 0,
              "p0_01": 0,
              "p0_1": 0,
              "p1": 0,
              "p2_5": 1,
              "p10": 1,
              "p25": 1,
              "p50": 1,
              "p75": 1,
              "p90": 1,
              "p97_5": 2,
              "p99": 3,
              "p99_9": 5,
              "p99_99": 22,
              "p99_999": 23,
              "totalCount": 1753242
            },
            "requestsPerSecond": 58421.926024658445,
            "errors": 0,
            "timeouts": 0,
            "non2xx": 0
          }
        ]
      },
      "off": {
        "p50": 1,
        "p99": 3,
        "p97_5": 2,
        "requestsPerSecond": 58421.926024658445
      },
      "on": {
        "p50": 2,
        "p99": 3,
        "p97_5": 2,
        "requestsPerSecond": 46689.3368877041
      },
      "delta": {
        "p50": 1,
        "p99": 0
      },
      "supplementary": {
        "gating": false,
        "overallRate": 29210,
        "fractionOfOffThroughput": 0.49998351625160703,
        "connections": 100,
        "durationSeconds": 10,
        "runs": 3,
        "latencyUnit": "ms",
        "precision": "Unrounded autocannon histogram values; installed autocannon may quantize percentiles to integer ms",
        "serviceTimeDeltaUs": 4.301305467193387,
        "serviceTimeMethod": "1e6 / median saturated on rps - 1e6 / median saturated off rps; throughput-derived estimate, not a direct service-time measurement",
        "status": "measured",
        "samples": {
          "on": [
            {
              "p50": 1,
              "p99": 22,
              "p97_5": 4,
              "latency": {
                "average": 2.09,
                "mean": 2.09,
                "stddev": 5.3,
                "min": 1,
                "max": 79,
                "p0_001": 0,
                "p0_01": 0,
                "p0_1": 0,
                "p1": 1,
                "p2_5": 1,
                "p10": 1,
                "p25": 1,
                "p50": 1,
                "p75": 2,
                "p90": 2,
                "p97_5": 4,
                "p99": 22,
                "p99_9": 74,
                "p99_99": 79,
                "p99_999": 79,
                "totalCount": 568964
              },
              "requestsPerSecond": 29181.21878121878,
              "errors": 0,
              "timeouts": 0,
              "non2xx": 0
            },
            {
              "p50": 1,
              "p99": 4,
              "p97_5": 3,
              "latency": {
                "average": 1.5,
                "mean": 1.5,
                "stddev": 0.79,
                "min": 1,
                "max": 16,
                "p0_001": 0,
                "p0_01": 0,
                "p0_1": 0,
                "p1": 1,
                "p2_5": 1,
                "p10": 1,
                "p25": 1,
                "p50": 1,
                "p75": 2,
                "p90": 2,
                "p97_5": 3,
                "p99": 4,
                "p99_9": 11,
                "p99_99": 16,
                "p99_999": 16,
                "totalCount": 509332
              },
              "requestsPerSecond": 29183.416583416583,
              "errors": 0,
              "timeouts": 0,
              "non2xx": 0
            },
            {
              "p50": 1,
              "p99": 3,
              "p97_5": 2,
              "latency": {
                "average": 1.59,
                "mean": 1.59,
                "stddev": 2.41,
                "min": 1,
                "max": 98,
                "p0_001": 0,
                "p0_01": 0,
                "p0_1": 0,
                "p1": 1,
                "p2_5": 1,
                "p10": 1,
                "p25": 1,
                "p50": 1,
                "p75": 2,
                "p90": 2,
                "p97_5": 2,
                "p99": 3,
                "p99_9": 46,
                "p99_99": 81,
                "p99_999": 94,
                "totalCount": 538250
              },
              "requestsPerSecond": 29180.81918081918,
              "errors": 0,
              "timeouts": 0,
              "non2xx": 0
            }
          ],
          "off": [
            {
              "p50": 1,
              "p99": 4,
              "p97_5": 3,
              "latency": {
                "average": 1.18,
                "mean": 1.18,
                "stddev": 0.76,
                "min": 1,
                "max": 26,
                "p0_001": 0,
                "p0_01": 0,
                "p0_1": 0,
                "p1": 0,
                "p2_5": 1,
                "p10": 1,
                "p25": 1,
                "p50": 1,
                "p75": 1,
                "p90": 2,
                "p97_5": 3,
                "p99": 4,
                "p99_9": 10,
                "p99_99": 23,
                "p99_999": 26,
                "totalCount": 332200
              },
              "requestsPerSecond": 29181.718281718284,
              "errors": 0,
              "timeouts": 0,
              "non2xx": 0
            },
            {
              "p50": 1,
              "p99": 13,
              "p97_5": 4,
              "latency": {
                "average": 1.4,
                "mean": 1.4,
                "stddev": 2.2,
                "min": 1,
                "max": 30,
                "p0_001": 0,
                "p0_01": 0,
                "p0_1": 0,
                "p1": 0,
                "p2_5": 1,
                "p10": 1,
                "p25": 1,
                "p50": 1,
                "p75": 1,
                "p90": 2,
                "p97_5": 4,
                "p99": 13,
                "p99_9": 28,
                "p99_99": 30,
                "p99_999": 30,
                "totalCount": 338967
              },
              "requestsPerSecond": 29193.106893106895,
              "errors": 0,
              "timeouts": 0,
              "non2xx": 0
            },
            {
              "p50": 1,
              "p99": 48,
              "p97_5": 25,
              "latency": {
                "average": 2.62,
                "mean": 2.62,
                "stddev": 7.47,
                "min": 1,
                "max": 75,
                "p0_001": 0,
                "p0_01": 0,
                "p0_1": 0,
                "p1": 0,
                "p2_5": 1,
                "p10": 1,
                "p25": 1,
                "p50": 1,
                "p75": 1,
                "p90": 2,
                "p97_5": 25,
                "p99": 48,
                "p99_9": 71,
                "p99_99": 75,
                "p99_999": 75,
                "totalCount": 340320
              },
              "requestsPerSecond": 29180.81918081918,
              "errors": 0,
              "timeouts": 0,
              "non2xx": 0
            }
          ]
        },
        "off": {
          "p50": 1,
          "p99": 13,
          "p97_5": 4,
          "requestsPerSecond": 29181.718281718284
        },
        "on": {
          "p50": 1,
          "p99": 4,
          "p97_5": 3,
          "requestsPerSecond": 29181.21878121878
        },
        "delta": {
          "p50": 0,
          "p99": -9
        }
      }
    },
    {
      "demo": "node",
      "samples": {
        "on": [
          {
            "p50": 1,
            "p99": 3,
            "p97_5": 2,
            "latency": {
              "average": 1.11,
              "mean": 1.11,
              "stddev": 1.07,
              "min": 1,
              "max": 103,
              "p0_001": 0,
              "p0_01": 0,
              "p0_1": 0,
              "p1": 0,
              "p2_5": 1,
              "p10": 1,
              "p25": 1,
              "p50": 1,
              "p75": 1,
              "p90": 1,
              "p97_5": 2,
              "p99": 3,
              "p99_9": 6,
              "p99_99": 45,
              "p99_999": 103,
              "totalCount": 1753921
            },
            "requestsPerSecond": 58444.55181606131,
            "errors": 0,
            "timeouts": 0,
            "non2xx": 0
          },
          {
            "p50": 1,
            "p99": 3,
            "p97_5": 2,
            "latency": {
              "average": 1.12,
              "mean": 1.12,
              "stddev": 1.62,
              "min": 1,
              "max": 193,
              "p0_001": 0,
              "p0_01": 0,
              "p0_1": 0,
              "p1": 0,
              "p2_5": 1,
              "p10": 1,
              "p25": 1,
              "p50": 1,
              "p75": 1,
              "p90": 1,
              "p97_5": 2,
              "p99": 3,
              "p99_9": 7,
              "p99_99": 27,
              "p99_999": 193,
              "totalCount": 1685889
            },
            "requestsPerSecond": 56177.57414195268,
            "errors": 0,
            "timeouts": 0,
            "non2xx": 0
          },
          {
            "p50": 1,
            "p99": 3,
            "p97_5": 2,
            "latency": {
              "average": 1.13,
              "mean": 1.13,
              "stddev": 1.19,
              "min": 1,
              "max": 107,
              "p0_001": 0,
              "p0_01": 0,
              "p0_1": 0,
              "p1": 0,
              "p2_5": 1,
              "p10": 1,
              "p25": 1,
              "p50": 1,
              "p75": 1,
              "p90": 1,
              "p97_5": 2,
              "p99": 3,
              "p99_9": 6,
              "p99_99": 67,
              "p99_999": 107,
              "totalCount": 1733314
            },
            "requestsPerSecond": 57757.880706431184,
            "errors": 0,
            "timeouts": 0,
            "non2xx": 0
          }
        ],
        "off": [
          {
            "p50": 1,
            "p99": 2,
            "p97_5": 2,
            "latency": {
              "average": 1.03,
              "mean": 1.03,
              "stddev": 1.21,
              "min": 1,
              "max": 100,
              "p0_001": 0,
              "p0_01": 0,
              "p0_1": 0,
              "p1": 0,
              "p2_5": 0,
              "p10": 1,
              "p25": 1,
              "p50": 1,
              "p75": 1,
              "p90": 1,
              "p97_5": 2,
              "p99": 2,
              "p99_9": 8,
              "p99_99": 61,
              "p99_999": 99,
              "totalCount": 2248357
            },
            "requestsPerSecond": 74920.25991336221,
            "errors": 0,
            "timeouts": 0,
            "non2xx": 0
          },
          {
            "p50": 1,
            "p99": 2,
            "p97_5": 2,
            "latency": {
              "average": 1.02,
              "mean": 1.02,
              "stddev": 1,
              "min": 1,
              "max": 122,
              "p0_001": 0,
              "p0_01": 0,
              "p0_1": 0,
              "p1": 0,
              "p2_5": 0,
              "p10": 1,
              "p25": 1,
              "p50": 1,
              "p75": 1,
              "p90": 1,
              "p97_5": 2,
              "p99": 2,
              "p99_9": 5,
              "p99_99": 31,
              "p99_999": 121,
              "totalCount": 2230727
            },
            "requestsPerSecond": 74332.7890703099,
            "errors": 0,
            "timeouts": 0,
            "non2xx": 0
          },
          {
            "p50": 1,
            "p99": 3,
            "p97_5": 2,
            "latency": {
              "average": 1.03,
              "mean": 1.03,
              "stddev": 0.81,
              "min": 1,
              "max": 74,
              "p0_001": 0,
              "p0_01": 0,
              "p0_1": 0,
              "p1": 0,
              "p2_5": 0,
              "p10": 1,
              "p25": 1,
              "p50": 1,
              "p75": 1,
              "p90": 1,
              "p97_5": 2,
              "p99": 3,
              "p99_9": 5,
              "p99_99": 42,
              "p99_999": 74,
              "totalCount": 2221673
            },
            "requestsPerSecond": 74031.08963678773,
            "errors": 0,
            "timeouts": 0,
            "non2xx": 0
          }
        ]
      },
      "off": {
        "p50": 1,
        "p99": 2,
        "p97_5": 2,
        "requestsPerSecond": 74332.7890703099
      },
      "on": {
        "p50": 1,
        "p99": 3,
        "p97_5": 2,
        "requestsPerSecond": 57757.880706431184
      },
      "delta": {
        "p50": 0,
        "p99": 1
      },
      "supplementary": {
        "gating": false,
        "overallRate": 37166,
        "fractionOfOffThroughput": 0.4999946923133131,
        "connections": 100,
        "durationSeconds": 10,
        "runs": 3,
        "latencyUnit": "ms",
        "precision": "Unrounded autocannon histogram values; installed autocannon may quantize percentiles to integer ms",
        "serviceTimeDeltaUs": 3.8606413521535554,
        "serviceTimeMethod": "1e6 / median saturated on rps - 1e6 / median saturated off rps; throughput-derived estimate, not a direct service-time measurement",
        "status": "measured",
        "samples": {
          "on": [
            {
              "p50": 1,
              "p99": 6,
              "p97_5": 4,
              "latency": {
                "average": 1.41,
                "mean": 1.41,
                "stddev": 2.71,
                "min": 1,
                "max": 94,
                "p0_001": 0,
                "p0_01": 0,
                "p0_1": 0,
                "p1": 0,
                "p2_5": 1,
                "p10": 1,
                "p25": 1,
                "p50": 1,
                "p75": 1,
                "p90": 2,
                "p97_5": 4,
                "p99": 6,
                "p99_9": 50,
                "p99_99": 81,
                "p99_999": 91,
                "totalCount": 454211
              },
              "requestsPerSecond": 37131.568431568434,
              "errors": 0,
              "timeouts": 0,
              "non2xx": 0
            },
            {
              "p50": 1,
              "p99": 82,
              "p97_5": 44,
              "latency": {
                "average": 3.69,
                "mean": 3.69,
                "stddev": 13.36,
                "min": 1,
                "max": 131,
                "p0_001": 0,
                "p0_01": 0,
                "p0_1": 0,
                "p1": 0,
                "p2_5": 1,
                "p10": 1,
                "p25": 1,
                "p50": 1,
                "p75": 1,
                "p90": 2,
                "p97_5": 44,
                "p99": 82,
                "p99_9": 126,
                "p99_99": 131,
                "p99_999": 131,
                "totalCount": 508765
              },
              "requestsPerSecond": 37133.24250681199,
              "errors": 0,
              "timeouts": 0,
              "non2xx": 0
            },
            {
              "p50": 1,
              "p99": 48,
              "p97_5": 30,
              "latency": {
                "average": 2.94,
                "mean": 2.94,
                "stddev": 7.88,
                "min": 1,
                "max": 75,
                "p0_001": 0,
                "p0_01": 0,
                "p0_1": 0,
                "p1": 0,
                "p2_5": 1,
                "p10": 1,
                "p25": 1,
                "p50": 1,
                "p75": 1,
                "p90": 3,
                "p97_5": 30,
                "p99": 48,
                "p99_9": 71,
                "p99_99": 75,
                "p99_999": 75,
                "totalCount": 460876
              },
              "requestsPerSecond": 37134.76523476523,
              "errors": 0,
              "timeouts": 0,
              "non2xx": 0
            }
          ],
          "off": [
            {
              "p50": 1,
              "p99": 5,
              "p97_5": 3,
              "latency": {
                "average": 1.16,
                "mean": 1.16,
                "stddev": 1.29,
                "min": 1,
                "max": 22,
                "p0_001": 0,
                "p0_01": 0,
                "p0_1": 0,
                "p1": 0,
                "p2_5": 0,
                "p10": 1,
                "p25": 1,
                "p50": 1,
                "p75": 1,
                "p90": 1,
                "p97_5": 3,
                "p99": 5,
                "p99_9": 19,
                "p99_99": 22,
                "p99_999": 22,
                "totalCount": 403239
              },
              "requestsPerSecond": 37132.76723276723,
              "errors": 0,
              "timeouts": 0,
              "non2xx": 0
            },
            {
              "p50": 1,
              "p99": 6,
              "p97_5": 4,
              "latency": {
                "average": 1.23,
                "mean": 1.23,
                "stddev": 1.84,
                "min": 1,
                "max": 70,
                "p0_001": 0,
                "p0_01": 0,
                "p0_1": 0,
                "p1": 0,
                "p2_5": 0,
                "p10": 1,
                "p25": 1,
                "p50": 1,
                "p75": 1,
                "p90": 1,
                "p97_5": 4,
                "p99": 6,
                "p99_9": 31,
                "p99_99": 56,
                "p99_999": 66,
                "totalCount": 411097
              },
              "requestsPerSecond": 37136.96303696304,
              "errors": 0,
              "timeouts": 0,
              "non2xx": 0
            },
            {
              "p50": 1,
              "p99": 3,
              "p97_5": 2,
              "latency": {
                "average": 1.04,
                "mean": 1.04,
                "stddev": 0.49,
                "min": 1,
                "max": 7,
                "p0_001": 0,
                "p0_01": 0,
                "p0_1": 0,
                "p1": 0,
                "p2_5": 0,
                "p10": 1,
                "p25": 1,
                "p50": 1,
                "p75": 1,
                "p90": 1,
                "p97_5": 2,
                "p99": 3,
                "p99_9": 5,
                "p99_99": 6,
                "p99_999": 6,
                "totalCount": 394906
              },
              "requestsPerSecond": 37136.76323676324,
              "errors": 0,
              "timeouts": 0,
              "non2xx": 0
            }
          ]
        },
        "off": {
          "p50": 1,
          "p99": 5,
          "p97_5": 3,
          "requestsPerSecond": 37136.76323676324
        },
        "on": {
          "p50": 1,
          "p99": 48,
          "p97_5": 30,
          "requestsPerSecond": 37133.24250681199
        },
        "delta": {
          "p50": 0,
          "p99": 43
        }
      }
    }
  ],
  "memory": {
    "clients": 50000,
    "heapDeltaBytes": 8279168,
    "gc": true
  },
  "numericPassed": false
}
```

## lighthouse

```json
{
  "status": "passed",
  "comparisons": [
    {
      "demo": "express",
      "form": "desktop",
      "path": "/",
      "off": {
        "performance": 100,
        "accessibility": 100,
        "best-practices": 96,
        "seo": 91,
        "lcp": 201.0349,
        "tbt": 0,
        "cls": 0
      },
      "on": {
        "performance": 100,
        "accessibility": 100,
        "best-practices": 96,
        "seo": 91,
        "lcp": 200.8363,
        "tbt": 0,
        "cls": 0
      },
      "delta": {
        "performance": 0,
        "accessibility": 0,
        "best-practices": 0,
        "seo": 0,
        "lcp": -0.198599999999999,
        "tbt": 0,
        "cls": 0
      },
      "passed": true
    },
    {
      "demo": "express",
      "form": "desktop",
      "path": "/list",
      "off": {
        "performance": 100,
        "accessibility": 100,
        "best-practices": 96,
        "seo": 91,
        "lcp": 200.6861,
        "tbt": 0,
        "cls": 0
      },
      "on": {
        "performance": 100,
        "accessibility": 100,
        "best-practices": 96,
        "seo": 91,
        "lcp": 200.82139999999998,
        "tbt": 0,
        "cls": 0
      },
      "delta": {
        "performance": 0,
        "accessibility": 0,
        "best-practices": 0,
        "seo": 0,
        "lcp": 0.13529999999997244,
        "tbt": 0,
        "cls": 0
      },
      "passed": true
    },
    {
      "demo": "express",
      "form": "desktop",
      "path": "/item/1",
      "off": {
        "performance": 100,
        "accessibility": 100,
        "best-practices": 96,
        "seo": 91,
        "lcp": 200.78750000000002,
        "tbt": 0,
        "cls": 0
      },
      "on": {
        "performance": 100,
        "accessibility": 100,
        "best-practices": 96,
        "seo": 91,
        "lcp": 200.88549999999998,
        "tbt": 0,
        "cls": 0
      },
      "delta": {
        "performance": 0,
        "accessibility": 0,
        "best-practices": 0,
        "seo": 0,
        "lcp": 0.09799999999995634,
        "tbt": 0,
        "cls": 0
      },
      "passed": true
    },
    {
      "demo": "express",
      "form": "desktop",
      "path": "/login",
      "off": {
        "performance": 100,
        "accessibility": 100,
        "best-practices": 96,
        "seo": 91,
        "lcp": 200.7348,
        "tbt": 0,
        "cls": 0
      },
      "on": {
        "performance": 100,
        "accessibility": 100,
        "best-practices": 96,
        "seo": 91,
        "lcp": 201.17399999999998,
        "tbt": 0,
        "cls": 0
      },
      "delta": {
        "performance": 0,
        "accessibility": 0,
        "best-practices": 0,
        "seo": 0,
        "lcp": 0.43919999999997117,
        "tbt": 0,
        "cls": 0
      },
      "passed": true
    },
    {
      "demo": "express",
      "form": "desktop",
      "path": "/pricing",
      "off": {
        "performance": 100,
        "accessibility": 100,
        "best-practices": 96,
        "seo": 91,
        "lcp": 200.7541,
        "tbt": 0,
        "cls": 0
      },
      "on": {
        "performance": 100,
        "accessibility": 100,
        "best-practices": 96,
        "seo": 91,
        "lcp": 200.8576,
        "tbt": 0,
        "cls": 0
      },
      "delta": {
        "performance": 0,
        "accessibility": 0,
        "best-practices": 0,
        "seo": 0,
        "lcp": 0.10349999999999682,
        "tbt": 0,
        "cls": 0
      },
      "passed": true
    },
    {
      "demo": "express",
      "form": "mobile",
      "path": "/",
      "off": {
        "performance": 100,
        "accessibility": 100,
        "best-practices": 96,
        "seo": 91,
        "lcp": 750.6115,
        "tbt": 0,
        "cls": 0
      },
      "on": {
        "performance": 100,
        "accessibility": 100,
        "best-practices": 96,
        "seo": 91,
        "lcp": 750.8701000000001,
        "tbt": 0,
        "cls": 0
      },
      "delta": {
        "performance": 0,
        "accessibility": 0,
        "best-practices": 0,
        "seo": 0,
        "lcp": 0.25860000000011496,
        "tbt": 0,
        "cls": 0
      },
      "passed": true
    },
    {
      "demo": "express",
      "form": "mobile",
      "path": "/list",
      "off": {
        "performance": 100,
        "accessibility": 100,
        "best-practices": 96,
        "seo": 91,
        "lcp": 750.6176,
        "tbt": 0,
        "cls": 0
      },
      "on": {
        "performance": 100,
        "accessibility": 100,
        "best-practices": 96,
        "seo": 91,
        "lcp": 751.0334,
        "tbt": 0,
        "cls": 0
      },
      "delta": {
        "performance": 0,
        "accessibility": 0,
        "best-practices": 0,
        "seo": 0,
        "lcp": 0.4157999999999902,
        "tbt": 0,
        "cls": 0
      },
      "passed": true
    },
    {
      "demo": "express",
      "form": "mobile",
      "path": "/item/1",
      "off": {
        "performance": 100,
        "accessibility": 100,
        "best-practices": 96,
        "seo": 91,
        "lcp": 750.6341,
        "tbt": 0,
        "cls": 0
      },
      "on": {
        "performance": 100,
        "accessibility": 100,
        "best-practices": 96,
        "seo": 91,
        "lcp": 750.9537,
        "tbt": 0,
        "cls": 0
      },
      "delta": {
        "performance": 0,
        "accessibility": 0,
        "best-practices": 0,
        "seo": 0,
        "lcp": 0.31960000000003674,
        "tbt": 0,
        "cls": 0
      },
      "passed": true
    },
    {
      "demo": "express",
      "form": "mobile",
      "path": "/login",
      "off": {
        "performance": 100,
        "accessibility": 100,
        "best-practices": 96,
        "seo": 91,
        "lcp": 750.6138000000001,
        "tbt": 0,
        "cls": 0
      },
      "on": {
        "performance": 100,
        "accessibility": 100,
        "best-practices": 96,
        "seo": 91,
        "lcp": 750.8563999999999,
        "tbt": 0,
        "cls": 0
      },
      "delta": {
        "performance": 0,
        "accessibility": 0,
        "best-practices": 0,
        "seo": 0,
        "lcp": 0.2425999999998112,
        "tbt": 0,
        "cls": 0
      },
      "passed": true
    },
    {
      "demo": "express",
      "form": "mobile",
      "path": "/pricing",
      "off": {
        "performance": 100,
        "accessibility": 100,
        "best-practices": 96,
        "seo": 91,
        "lcp": 750.6384,
        "tbt": 0,
        "cls": 0
      },
      "on": {
        "performance": 100,
        "accessibility": 100,
        "best-practices": 96,
        "seo": 91,
        "lcp": 750.8717999999999,
        "tbt": 0,
        "cls": 0
      },
      "delta": {
        "performance": 0,
        "accessibility": 0,
        "best-practices": 0,
        "seo": 0,
        "lcp": 0.23339999999984684,
        "tbt": 0,
        "cls": 0
      },
      "passed": true
    },
    {
      "demo": "node",
      "form": "desktop",
      "path": "/",
      "off": {
        "performance": 100,
        "accessibility": 100,
        "best-practices": 96,
        "seo": 91,
        "lcp": 200.666,
        "tbt": 0,
        "cls": 0
      },
      "on": {
        "performance": 100,
        "accessibility": 100,
        "best-practices": 96,
        "seo": 91,
        "lcp": 200.7697,
        "tbt": 0,
        "cls": 0
      },
      "delta": {
        "performance": 0,
        "accessibility": 0,
        "best-practices": 0,
        "seo": 0,
        "lcp": 0.10370000000000346,
        "tbt": 0,
        "cls": 0
      },
      "passed": true
    },
    {
      "demo": "node",
      "form": "desktop",
      "path": "/list",
      "off": {
        "performance": 100,
        "accessibility": 100,
        "best-practices": 96,
        "seo": 91,
        "lcp": 200.56959999999998,
        "tbt": 0,
        "cls": 0
      },
      "on": {
        "performance": 100,
        "accessibility": 100,
        "best-practices": 96,
        "seo": 91,
        "lcp": 200.74919999999997,
        "tbt": 0,
        "cls": 0
      },
      "delta": {
        "performance": 0,
        "accessibility": 0,
        "best-practices": 0,
        "seo": 0,
        "lcp": 0.17959999999999354,
        "tbt": 0,
        "cls": 0
      },
      "passed": true
    },
    {
      "demo": "node",
      "form": "desktop",
      "path": "/item/1",
      "off": {
        "performance": 100,
        "accessibility": 100,
        "best-practices": 96,
        "seo": 91,
        "lcp": 200.4812,
        "tbt": 0,
        "cls": 0
      },
      "on": {
        "performance": 100,
        "accessibility": 100,
        "best-practices": 96,
        "seo": 91,
        "lcp": 200.89569999999998,
        "tbt": 0,
        "cls": 0
      },
      "delta": {
        "performance": 0,
        "accessibility": 0,
        "best-practices": 0,
        "seo": 0,
        "lcp": 0.41449999999997544,
        "tbt": 0,
        "cls": 0
      },
      "passed": true
    },
    {
      "demo": "node",
      "form": "desktop",
      "path": "/login",
      "off": {
        "performance": 100,
        "accessibility": 100,
        "best-practices": 96,
        "seo": 91,
        "lcp": 200.51639999999998,
        "tbt": 0,
        "cls": 0
      },
      "on": {
        "performance": 100,
        "accessibility": 100,
        "best-practices": 96,
        "seo": 91,
        "lcp": 200.87040000000002,
        "tbt": 0,
        "cls": 0
      },
      "delta": {
        "performance": 0,
        "accessibility": 0,
        "best-practices": 0,
        "seo": 0,
        "lcp": 0.35400000000004184,
        "tbt": 0,
        "cls": 0
      },
      "passed": true
    },
    {
      "demo": "node",
      "form": "desktop",
      "path": "/pricing",
      "off": {
        "performance": 100,
        "accessibility": 100,
        "best-practices": 96,
        "seo": 91,
        "lcp": 200.6784,
        "tbt": 0,
        "cls": 0
      },
      "on": {
        "performance": 100,
        "accessibility": 100,
        "best-practices": 96,
        "seo": 91,
        "lcp": 200.68689999999998,
        "tbt": 0,
        "cls": 0
      },
      "delta": {
        "performance": 0,
        "accessibility": 0,
        "best-practices": 0,
        "seo": 0,
        "lcp": 0.008499999999969532,
        "tbt": 0,
        "cls": 0
      },
      "passed": true
    },
    {
      "demo": "node",
      "form": "mobile",
      "path": "/",
      "off": {
        "performance": 100,
        "accessibility": 100,
        "best-practices": 96,
        "seo": 91,
        "lcp": 750.7052000000001,
        "tbt": 0,
        "cls": 0
      },
      "on": {
        "performance": 100,
        "accessibility": 100,
        "best-practices": 96,
        "seo": 91,
        "lcp": 750.7471,
        "tbt": 0,
        "cls": 0
      },
      "delta": {
        "performance": 0,
        "accessibility": 0,
        "best-practices": 0,
        "seo": 0,
        "lcp": 0.04189999999994143,
        "tbt": 0,
        "cls": 0
      },
      "passed": true
    },
    {
      "demo": "node",
      "form": "mobile",
      "path": "/list",
      "off": {
        "performance": 100,
        "accessibility": 100,
        "best-practices": 96,
        "seo": 91,
        "lcp": 750.5786,
        "tbt": 0,
        "cls": 0
      },
      "on": {
        "performance": 100,
        "accessibility": 100,
        "best-practices": 96,
        "seo": 91,
        "lcp": 750.7252000000001,
        "tbt": 0,
        "cls": 0
      },
      "delta": {
        "performance": 0,
        "accessibility": 0,
        "best-practices": 0,
        "seo": 0,
        "lcp": 0.14660000000003492,
        "tbt": 0,
        "cls": 0
      },
      "passed": true
    },
    {
      "demo": "node",
      "form": "mobile",
      "path": "/item/1",
      "off": {
        "performance": 100,
        "accessibility": 100,
        "best-practices": 96,
        "seo": 91,
        "lcp": 750.6799000000001,
        "tbt": 0,
        "cls": 0
      },
      "on": {
        "performance": 100,
        "accessibility": 100,
        "best-practices": 96,
        "seo": 91,
        "lcp": 750.7696000000001,
        "tbt": 0,
        "cls": 0
      },
      "delta": {
        "performance": 0,
        "accessibility": 0,
        "best-practices": 0,
        "seo": 0,
        "lcp": 0.08969999999999345,
        "tbt": 0,
        "cls": 0
      },
      "passed": true
    },
    {
      "demo": "node",
      "form": "mobile",
      "path": "/login",
      "off": {
        "performance": 100,
        "accessibility": 100,
        "best-practices": 96,
        "seo": 91,
        "lcp": 750.6547,
        "tbt": 0,
        "cls": 0
      },
      "on": {
        "performance": 100,
        "accessibility": 100,
        "best-practices": 96,
        "seo": 91,
        "lcp": 750.7032999999999,
        "tbt": 0,
        "cls": 0
      },
      "delta": {
        "performance": 0,
        "accessibility": 0,
        "best-practices": 0,
        "seo": 0,
        "lcp": 0.04859999999985121,
        "tbt": 0,
        "cls": 0
      },
      "passed": true
    },
    {
      "demo": "node",
      "form": "mobile",
      "path": "/pricing",
      "off": {
        "performance": 100,
        "accessibility": 100,
        "best-practices": 96,
        "seo": 91,
        "lcp": 750.5871999999999,
        "tbt": 0,
        "cls": 0
      },
      "on": {
        "performance": 100,
        "accessibility": 100,
        "best-practices": 96,
        "seo": 91,
        "lcp": 750.7273,
        "tbt": 0,
        "cls": 0
      },
      "delta": {
        "performance": 0,
        "accessibility": 0,
        "best-practices": 0,
        "seo": 0,
        "lcp": 0.14010000000007494,
        "tbt": 0,
        "cls": 0
      },
      "passed": true
    }
  ]
}
```
