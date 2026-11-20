#!/usr/bin/env python3
"""Google Search Console for this venture's Pages site only.

Usage:
  python3 scripts/gsc.py token      # get a FILE verification token, write docs/<token>.html
  python3 scripts/gsc.py verify     # verify ownership (after the file is live), add the site, submit the sitemap
  python3 scripts/gsc.py status     # sitemap status + last 28 days of search analytics

Reads CWS_CLIENT_ID / CWS_CLIENT_SECRET / GSC_REFRESH_TOKEN from the studio .env. Never prints them.
Touches nothing but SITE (charter: other sites visible to the token are off limits).
"""
import json, sys, urllib.parse, urllib.request, urllib.error, datetime, pathlib

SITE = "https://janwan2003.github.io/vscode-api-client/"
SITEMAP = SITE + "sitemap.xml"
ROOT = pathlib.Path(__file__).resolve().parent.parent
ENV = pathlib.Path("/home/janek/fun/money/.env")


def env():
    out = {}
    for line in ENV.read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def access_token():
    e = env()
    data = urllib.parse.urlencode(dict(client_id=e["CWS_CLIENT_ID"], client_secret=e["CWS_CLIENT_SECRET"],
                                       refresh_token=e["GSC_REFRESH_TOKEN"], grant_type="refresh_token")).encode()
    return json.load(urllib.request.urlopen("https://oauth2.googleapis.com/token", data))["access_token"]


def call(method, url, body=None, at=None):
    req = urllib.request.Request(url, method=method, headers={"Authorization": f"Bearer {at}",
                                                              "Content-Type": "application/json"},
                                 data=json.dumps(body).encode() if body is not None else None)
    try:
        r = urllib.request.urlopen(req)
        txt = r.read()
        return r.status, (json.loads(txt) if txt else {})
    except urllib.error.HTTPError as err:
        return err.code, err.read()[:400].decode(errors="replace")


def main(cmd):
    at = access_token()
    enc = urllib.parse.quote(SITE, safe="")
    if cmd == "token":
        s, r = call("POST", "https://www.googleapis.com/siteVerification/v1/token",
                    {"site": {"type": "SITE", "identifier": SITE}, "verificationMethod": "FILE"}, at)
        print(s, r if s != 200 else "token ok")
        if s == 200:
            name = r["token"]  # e.g. googleXXXX.html
            (ROOT / "docs" / name).write_text(f"google-site-verification: {name}")
            print("wrote docs/" + name)
    elif cmd == "verify":
        s, r = call("POST", "https://www.googleapis.com/siteVerification/v1/webResource?verificationMethod=FILE",
                    {"site": {"type": "SITE", "identifier": SITE}}, at)
        print("verify", s, r)
        s, r = call("PUT", f"https://www.googleapis.com/webmasters/v3/sites/{enc}", None, at)
        print("add site", s, r)
        s, r = call("PUT", f"https://www.googleapis.com/webmasters/v3/sites/{enc}/sitemaps/"
                    + urllib.parse.quote(SITEMAP, safe=""), None, at)
        print("submit sitemap", s, r)
    elif cmd == "status":
        s, r = call("GET", f"https://www.googleapis.com/webmasters/v3/sites/{enc}/sitemaps", None, at)
        print("sitemaps", s, json.dumps(r, indent=1))
        end = datetime.date.today()
        start = end - datetime.timedelta(days=28)
        s, r = call("POST", f"https://www.googleapis.com/webmasters/v3/sites/{enc}/searchAnalytics/query",
                    {"startDate": str(start), "endDate": str(end), "dimensions": ["query"], "rowLimit": 25}, at)
        print("analytics", start, end, s, json.dumps(r, indent=1))
    else:
        print(__doc__)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "")
