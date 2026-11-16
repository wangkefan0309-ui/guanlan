"""One authenticated Top page. Input/output are JSON; credentials never leave local files."""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile


async def search(request):
    from loguru import logger
    logger.remove()  # Upstream diagnostics may include account/session information.
    from twscrape import API
    from twscrape.api import OP_SearchTimeline
    from twscrape.models import parse_tweets
    logger.remove()
    # libcurl on Windows fails with error 77 for a Unicode CA bundle path.
    # Copy public CA certificates to an ASCII temp path; keep TLS verification on.
    import certifi
    ca_bytes = Path(certifi.where()).read_bytes()
    ca_path = Path(tempfile.gettempdir()) / f"source-workbench-ca-{hashlib.sha256(ca_bytes).hexdigest()[:16]}.pem"
    if not str(ca_path).isascii():
        return {"ok": False, "reason": "ascii-ca-path-required"}
    if not ca_path.exists():
        ca_path.write_bytes(ca_bytes)
    os.environ["REQUESTS_CA_BUNDLE"] = str(ca_path)

    directory = Path(request["directory"]).resolve()
    query = request["query"]
    if not isinstance(query, str) or not 2 <= len(query) <= 512:
        raise ValueError("query")
    auth = json.loads((directory / "auth.json").read_text(encoding="utf-8"))
    secrets = [auth["authToken"], auth["ct0"]]
    if any(not isinstance(value, str) or not 16 <= len(value) <= 4096 or any(char in value for char in ";\r\n") for value in secrets):
        raise ValueError("auth")
    proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
    api = API(str(directory / "accounts.db"), proxy=proxy, raise_when_no_account=True, wait_timeout=10, wait_interval=1)
    fingerprint = hashlib.sha256(";".join(secrets).encode()).hexdigest()
    marker = directory / "imported-auth.sha256"
    if not marker.exists() or marker.read_text() != fingerprint:
        await api.pool.add_account_cookies("workbench", f"auth_token={secrets[0]}; ct0={secrets[1]}")
        marker.write_text(fingerprint)
    # Pinning the upstream commit makes this private, single-page method explicit.
    # search_raw follows cursors, even after empty pages; this trial never does.
    response = await api._gql_item(OP_SearchTimeline, {
        "rawQuery": query, "count": 20, "product": "Top", "querySource": "typed_query",
    }, field_toggles={"withArticleRichContentState": True})
    if response is None:
        return {"ok": False, "reason": "account-or-interface-unavailable"}
    raw = response.json()
    if raw.get("errors") and not raw.get("data"):
        return {"ok": False, "reason": "x-response-error"}
    originals = {}

    def index(value):
        if isinstance(value, dict):
            if isinstance(value.get("legacy"), dict) and value.get("rest_id"):
                originals[str(value["rest_id"])] = value["legacy"]
            for nested in value.values():
                index(nested)
        elif isinstance(value, list):
            for nested in value:
                index(nested)

    index(raw)
    tweets = []
    for tweet in parse_tweets(response, limit=20):
        legacy = originals.get(str(tweet.id), {})
        item = {"id_str": str(tweet.id), "full_text": tweet.rawContent,
                "user": {"screen_name": tweet.user.username}}
        if legacy.get("created_at"):
            item["tweet_created_at"] = tweet.date.isoformat()
        # Missing counts remain missing even when the library supplies a default.
        for name in ["favorite_count", "retweet_count", "reply_count"]:
            value = legacy.get(name)
            if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                item[name] = value
        if tweet.viewCount is not None:
            item["views_count"] = tweet.viewCount
        if isinstance(legacy.get("entities"), dict):
            item["entities"] = {"urls": legacy["entities"].get("urls", [])}
        tweets.append(item)
    payload = {"ok": True, "tweets": tweets, "raw": raw}
    serialized = json.dumps(payload, ensure_ascii=False)
    if any(value in serialized for value in secrets):
        return {"ok": False, "reason": "unsafe-response"}
    return payload


async def main():
    try:
        request = json.loads(sys.stdin.read(8192))
        result = await asyncio.wait_for(search(request), timeout=55)
    except FileNotFoundError:
        result = {"ok": False, "reason": "login-required"}
    except TimeoutError:
        result = {"ok": False, "reason": "timeout"}
    except Exception:
        # No stack traces, cookie values, account details or upstream bodies.
        result = {"ok": False, "reason": "account-network-or-interface-error"}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())
