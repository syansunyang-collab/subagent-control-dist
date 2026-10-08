"""Codex subscription usage of the account Pi is signed in with: GET https://chatgpt.com/backend-api/wham/usage with the
same headers Pi's Codex provider sends (Bearer access token, chatgpt-account-id, originator: pi). Credentials are read
from ~/.pi/agent/auth.json in memory only and never printed. Output: one JSON line per window with used/remaining
percent and reset time.

  python codex_quota.py            # JSON summary
  python codex_quota.py --raw-keys # also list the response's field names (no values of other fields)
"""
import json
import sys
import time
import urllib.request
from pathlib import Path

AUTH = Path.home() / '.pi/agent/auth.json'


def fetch():
    cred = json.loads(AUTH.read_text(encoding='utf-8'))['openai-codex']
    request = urllib.request.Request('https://chatgpt.com/backend-api/wham/usage', headers={
        'Authorization': f"Bearer {cred['access']}", 'chatgpt-account-id': cred['accountId'], 'originator': 'pi',
        'User-Agent': 'pi', 'Accept': 'application/json'})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode('utf-8'))


def windows(data):
    limits = data.get('rate_limit') or data.get('rate_limits') or {}
    found = []
    for name in ('primary_window', 'secondary_window'):
        w = limits.get(name)
        if w:
            found.append((name, w))
    for extra in data.get('additional_rate_limits') or []:
        for name in ('primary_window', 'secondary_window'):
            w = (extra.get('rate_limit') or extra).get(name)
            if w:
                found.append((f"{extra.get('limit_name') or extra.get('metered_feature') or 'additional'}.{name}", w))
    return found


def summary(data):
    out = {'time': time.strftime('%Y-%m-%d %H:%M:%S'), 'plan': data.get('plan_type'), 'windows': []}
    for name, w in windows(data):
        used = w.get('used_percent')
        reset = w.get('reset_at') or w.get('resets_at')
        out['windows'].append({'window': name, 'seconds': w.get('limit_window_seconds'), 'usedPercent': used,
                               'remainingPercent': None if used is None else round(100 - used, 1),
                               'resetAt': time.strftime('%Y-%m-%d %H:%M', time.localtime(reset)) if isinstance(reset, (int, float)) else reset,
                               'resetAfterSeconds': w.get('reset_after_seconds')})
    return out


if __name__ == '__main__':
    data = fetch()
    if '--raw-keys' in sys.argv:
        print(json.dumps({k: (sorted(v) if isinstance(v, dict) else type(v).__name__) for k, v in data.items()}))
    print(json.dumps(summary(data), ensure_ascii=False))
