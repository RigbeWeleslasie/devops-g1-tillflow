"""SNS -> Slack renderer for TillFlow alarms.

DRI: Meron (plumbing). Alert contract: docs/runbook.md (Rigbe).

Every CloudWatch alarm's `alarm_description` is the 9-field JSON contract.
This function does not invent wording; it renders what the alarm already
carries, plus firing vs recovery from the SNS envelope. If the webhook secret
is still the placeholder, we log and return 200 so SNS does not retry.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

import boto3

SECRET_ARN = os.environ["SLACK_WEBHOOK_SECRET_ARN"]
PLACEHOLDER = "PLACEHOLDER_SET_OUT_OF_BAND"

_secrets = boto3.client("secretsmanager")


def _webhook_url() -> str | None:
    raw = _secrets.get_secret_value(SecretId=SECRET_ARN)["SecretString"]
    parsed = json.loads(raw) if raw.startswith("{") else {"webhook_url": raw}
    url = parsed.get("webhook_url") or parsed.get("url") or ""
    if not url or PLACEHOLDER in url:
        return None
    return url


def _contract(message: dict) -> dict:
    desc = message.get("AlarmDescription") or "{}"
    try:
        body = json.loads(desc)
        if isinstance(body, dict):
            return body
    except json.JSONDecodeError:
        pass
    return {"symptom": desc}


def _blocks(state: str, alarm_name: str, contract: dict) -> dict:
    firing = state == "ALARM"
    header = "FIRING" if firing else "RECOVERED"
    color = "#E01E5A" if firing else "#2EB67D"
    grafana = (
        contract.get("grafana")
        or os.environ.get("GRAFANA_URL")
        or "AMG workspace not provisioned yet"
    )
    fields = [
        ("environment", contract.get("environment", "?")),
        ("service", contract.get("service", "?")),
        ("owner", contract.get("owner", "?")),
        ("observed", contract.get("observed", message_state(state))),
        ("grafana", grafana),
        ("runbook", contract.get("runbook", "docs/runbook.md")),
        ("first safe action", contract.get("first_action") or contract.get("firstAction") or "see runbook"),
    ]
    return {
        "attachments": [
            {
                "color": color,
                "blocks": [
                    {
                        "type": "header",
                        "text": {"type": "plain_text", "text": f"{header}  {alarm_name}"[:150]},
                    },
                    {
                        "type": "section",
                        "text": {
                            "type": "mrkdwn",
                            "text": (
                                f"*symptom:* {contract.get('symptom', alarm_name)}\n"
                                f"*user/SLO impact:* {contract.get('impact', 'see SLO doc')}"
                            ),
                        },
                    },
                    {
                        "type": "section",
                        "fields": [
                            {"type": "mrkdwn", "text": f"*{k}:*\n{v}"} for k, v in fields
                        ],
                    },
                ],
            }
        ]
    }


def message_state(state: str) -> str:
    return f"CloudWatch state {state}"


def handler(event, _context):
    url = _webhook_url()
    if url is None:
        print("slack webhook is placeholder; dropping notification")
        return {"delivered": 0, "reason": "placeholder"}

    delivered = 0
    for record in event.get("Records", []):
        raw = record["Sns"]["Message"]
        message = json.loads(raw) if isinstance(raw, str) else raw
        state = message.get("NewStateValue", "UNKNOWN")
        name = message.get("AlarmName", "unnamed")
        payload = json.dumps(_blocks(state, name, _contract(message))).encode()
        req = urllib.request.Request(
            url,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=8) as resp:
                print(f"slack {name} {state} -> {resp.status}")
                delivered += 1
        except urllib.error.HTTPError as err:
            body = err.read()[:200]
            print(f"slack http {err.code}: {body!r}")
            # 5xx is Slack being down -- let SNS retry. 4xx is our payload;
            # retrying the same JSON will not help and pages nobody extra.
            if err.code >= 500:
                raise
    return {"delivered": delivered}
