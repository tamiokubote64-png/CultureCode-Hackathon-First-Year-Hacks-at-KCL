"""Safe extraction and classification of provider errors, without request data."""

import math
import re
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

from openai import APIError


def sanitise(value, secret=""):
    if value is None:
        return None
    text = str(value)
    if secret:
        text = text.replace(secret, "[REDACTED]")
    text = re.sub(r"data:image/[^\s]+", "[IMAGE REDACTED]", text, flags=re.I)
    text = re.sub(r"Bearer\s+\S+", "[AUTH REDACTED]", text, flags=re.I)
    text = re.sub(r"\b(?:sk-|org-|proj_)[\w-]+", "[REDACTED]", text)
    text = re.sub(r"[A-Za-z0-9+/=_-]{64,}", "[LONG VALUE REDACTED]", text)
    text = re.sub(r"[\w.+-]+@[\w.-]+", "[EMAIL REDACTED]", text)
    return " ".join(text.split())[:1500]


def retry_interval(headers):
    """Parse Retry-After seconds/date and retry-after-ms; never shorten a delay."""
    delays = []
    for name, divisor in (("retry-after", 1), ("retry-after-ms", 1000)):
        value = headers.get(name)
        if not value:
            continue
        try:
            seconds = float(value) / divisor
        except (ValueError, TypeError, OverflowError):
            if name != "retry-after":
                continue
            try:
                timestamp = parsedate_to_datetime(value)
                if timestamp.tzinfo is None:
                    timestamp = timestamp.replace(tzinfo=timezone.utc)
                seconds = (timestamp - datetime.now(timezone.utc)).total_seconds()
            except (ValueError, TypeError, OverflowError):
                continue
        if math.isfinite(seconds) and seconds >= 0:
            delays.append(math.ceil(seconds))
    return max(delays) if delays else None


def provider_error_details(exc: APIError, secret=""):
    body = getattr(exc, "body", None)
    body = body if isinstance(body, dict) else {}
    nested = body.get("error")
    error = nested if isinstance(nested, dict) else body
    headers = getattr(getattr(exc, "response", None), "headers", {})
    return {
        "status": getattr(exc, "status_code", None),
        "code": sanitise(error.get("code") or getattr(exc, "code", None), secret),
        "type": sanitise(error.get("type") or getattr(exc, "type", None), secret),
        "message": sanitise(error.get("message", "No structured provider message."), secret),
        "retry_after": retry_interval(headers),
    }


def classify_provider_error(details):
    status = details["status"]
    code = (details["code"] or "").lower()
    error_type = (details["type"] or "").lower()
    message = (details["message"] or "").lower()
    signals = {code, error_type}

    # Billing evidence must take precedence over generic rate-limit wording.
    if signals & {"billing_hard_limit_reached", "spend_limit_exceeded",
                  "spending_limit_exceeded", "organization_spend_limit_exceeded",
                  "project_spend_limit_exceeded"} or any(term in message for term in (
                      "spending limit", "spend limit", "billing hard limit")):
        return "spending_limit"
    if signals & {"credits_exhausted", "insufficient_credits", "credit_balance_exhausted"} or any(
        term in message for term in (
            "insufficient credits", "credits exhausted", "credit balance",
            "run out of credits", "exhausted your credits",
        )
    ):
        return "credits_exhausted"
    if signals & {"insufficient_quota", "quota_exceeded", "quota_error",
                  "billing_not_active", "billing_error", "usage_limit_reached"} or any(
        term in message for term in (
            "exceeded your current quota", "check your plan and billing",
            "billing is not active", "usage limit",
        )
    ):
        return "quota_exhausted"
    if status == 429:
        if signals & {"rate_limit_exceeded", "rate_limit_error", "requests", "tokens"} or any(
            term in message for term in ("rate limit reached", "rate limit exceeded",
                                         "requests per min", "tokens per min")
        ):
            return "rate_limited"
        return "restriction_unknown"
    return {
        401: "invalid_credentials", 403: "model_access", 404: "model_access",
        400: "invalid_request", None: "connection_failed",
    }.get(status, "unavailable")
