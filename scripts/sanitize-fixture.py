#!/usr/bin/env python3
"""Sanitize an Auto-Group Tabs storage export so it can be committed.

Input:  {"sync": {"groups": "<base64 LZMA-alone JSON>"}, "local": {...}}
Output: the same shape. GitHub org names are replaced, repos under those
orgs are renamed repo-1..N (titles too), and ids become deterministic UUIDs.

Usage:
  python3 -I scripts/sanitize-fixture.py fixtures/auto-group-tabs.real.json \
      fixtures/auto-group-tabs.json --org realorg=acme
"""
import argparse
import base64
import json
import lzma
import re
import sys
import uuid


def decode_groups(blob: str) -> list:
    return json.loads(lzma.decompress(base64.b64decode(blob), format=lzma.FORMAT_ALONE))


def encode_groups(groups: list) -> str:
    raw = json.dumps(groups, separators=(",", ":")).encode()
    # Match Auto-Group Tabs' lzma-js output: LZMA-alone, dict size 8 MiB (header 5d 00 00 80 00).
    filters = [{"id": lzma.FILTER_LZMA1, "dict_size": 1 << 23, "lc": 3, "lp": 0, "pb": 2}]
    return base64.b64encode(lzma.compress(raw, format=lzma.FORMAT_ALONE, filters=filters)).decode()


def sanitize(groups: list, orgs: dict[str, str]) -> list:
    repo_names: dict[str, str] = {}
    org_re = re.compile("|".join(re.escape(o) for o in orgs), re.IGNORECASE) if orgs else None

    def new_org(match: re.Match) -> str:
        replacement = orgs[match.group(0).lower()]
        return replacement.capitalize() if match.group(0)[0].isupper() else replacement

    def rename_repo(org: str, repo: str) -> str:
        key = f"{org.lower()}/{repo}"
        if key not in repo_names:
            repo_names[key] = f"repo-{len(repo_names) + 1}"
        return repo_names[key]

    out = []
    for g in groups:
        matchers = []
        for m in g["matchers"]:
            def sub_repo(mm: re.Match) -> str:
                org, repo = mm.group(1), mm.group(2)
                if org.lower() not in orgs:
                    return mm.group(0)
                return f"github.com/{org}/{rename_repo(org, repo)}"
            m = re.sub(r"github\.com/([^/*]+)/([^/*?#]+)", sub_repo, m)
            matchers.append(org_re.sub(new_org, m) if org_re else m)
        title = g["title"]
        for key, name in repo_names.items():
            if title == key.split("/", 1)[1]:
                title = name
        title = org_re.sub(new_org, title) if org_re else title
        out.append({**g, "id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"tabchef-fixture:{len(out)}")),
                    "title": title, "matchers": matchers})
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--org", action="append", default=[], help="real=placeholder, e.g. realorg=acme")
    args = ap.parse_args()
    orgs = {k.lower(): v for k, v in (pair.split("=", 1) for pair in args.org)}

    data = json.load(open(args.src))
    groups = sanitize(decode_groups(data["sync"]["groups"]), orgs)
    data["sync"]["groups"] = encode_groups(groups)

    leaked = [o for o in orgs if o in json.dumps(groups).lower()]
    if leaked:
        print(f"refusing to write: still contains {leaked}", file=sys.stderr)
        return 1
    json.dump(data, open(args.dst, "w"), indent=2)
    print(json.dumps(groups, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
