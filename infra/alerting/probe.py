"""External uptime probe — TillFlow / devops-g1.

Runs as a Lambda OUTSIDE the VPC and calls the public API Gateway edge, the
same path an attendant's browser takes. ECS and ALB health checks cannot see
an API Gateway 5xx, a dead VPC Link, or a bad route.

Asserts /ready, not /health: /health is liveness and stays 200 with the
database down. Success requires 2xx AND JSON `{status: ready, service: <name>}`
so a 200 HTML error page, or /pos/ready served by web, is a failure.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

import boto3

BASE_URL = os.environ["TARGET_BASE_URL"].rstrip("/")
TARGETS = [s.strip() for s in os.environ["TARGET_SERVICES"].split(",") if s.strip()]
NAMESPACE = "CloudWatchSynthetics"
CANARY_NAME = os.environ["CANARY_NAME"]
TIMEOUT = 10

cw = boto3.client("cloudwatch")


def _put(success_percent: float) -> None:
    cw.put_metric_data(
        Namespace=NAMESPACE,
        MetricData=[
            {
                "MetricName": "SuccessPercent",
                "Dimensions": [{"Name": "CanaryName", "Value": CANARY_NAME}],
                "Value": success_percent,
                "Unit": "Percent",
            }
        ],
    )


def _probe(service: str) -> None:
    url = f"{BASE_URL}/{service}/ready"
    req = urllib.request.Request(url, headers={"User-Agent": "tillflow-uptime-probe"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            body = resp.read().decode()
            status = resp.status
    except urllib.error.HTTPError as err:
        raise RuntimeError(f"{service}: expected 2xx, got {err.code}") from err
    except Exception as err:
        raise RuntimeError(f"{service}: {err}") from err

    if status < 200 or status > 299:
        raise RuntimeError(f"{service}: expected 2xx, got {status} -- {body[:200]}")
    try:
        parsed = json.loads(body)
    except json.JSONDecodeError as err:
        raise RuntimeError(f"{service}: 200 but body was not JSON -- {body[:200]}") from err
    if parsed.get("status") != "ready":
        raise RuntimeError(f"{service}: expected status 'ready', got '{parsed.get('status')}'")
    if parsed.get("service") != service:
        raise RuntimeError(
            f"{service}: response came from '{parsed.get('service')}' -- edge mis-routing"
        )


def handler(_event, _context):
    if not TARGETS:
        raise RuntimeError("TARGET_SERVICES is empty -- nothing to probe")
    failures = []
    for service in TARGETS:
        try:
            _probe(service)
        except Exception as err:  # noqa: BLE001 — each target is independent
            failures.append(str(err))
    _put(0.0 if failures else 100.0)
    # Do not raise after publishing: EventBridge would retry the same minute
    # and the alarm already has its datapoint. The error string is in logs.
    if failures:
        print("probe failures: " + "; ".join(failures))
        return {"ok": False, "failures": failures}
    return {"ok": True, "targets": TARGETS}
