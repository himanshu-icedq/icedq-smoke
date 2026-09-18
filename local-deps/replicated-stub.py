#!/usr/bin/env python3
"""
Stand-in for the real replicated-sdk-image container.

The real SDK (v1.19.9) hard-requires a live k8s API at bootstrap (fetches a
"replicated-sdk" configmap for its replicated/app IDs) even in
--integration-license-id mode -- confirmed by running the real image and
reading its logs, not assumed. Running it standalone in docker is not
possible without a real cluster.

This stub serves the same two endpoints admin-service's
ReplicatedServiceImpl.fetchLicense() calls (icedq.security.replicated.*),
using the REAL license/licenseFields data pulled from the live .82 cluster's
`replicated` k8s Secret (replicated-config.yaml, gitignored -- production
credential, never committed) -- not fabricated numbers. It does not
replicate the SDK's live proxy.icedq.com validation.

Usage: python3 replicated-stub.py [config.yaml] [port]
"""
import sys
import json
import yaml
from http.server import BaseHTTPRequestHandler, HTTPServer

CONFIG_PATH = sys.argv[1] if len(sys.argv) > 1 else "/etc/replicated/config.yaml"
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 3000


def load():
    with open(CONFIG_PATH) as f:
        outer = yaml.safe_load(f)
    license_inner = yaml.safe_load(outer["license"])
    entitlements = license_inner["spec"]["entitlements"]
    license_fields = outer["licenseFields"]

    info = {"licenseType": license_inner["spec"].get("licenseType", "")}

    fields = {}
    for name, f in license_fields.items():
        ent = entitlements.get(name, {})
        fields[name] = {
            "value": str(f.get("value", "")),
            "valueType": ent.get("valueType", "String"),
            "title": ent.get("title", ""),
            "description": f.get("description", ""),
        }
    return info, fields


class Handler(BaseHTTPRequestHandler):
    def _json(self, body):
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        # Re-read on every request (file is tiny) so edits to
        # replicated-config.yaml show up without restarting this container --
        # admin-service's own license cache (@Cacheable) is the only
        # remaining staleness, same as it would be against a real replicated.
        try:
            info, fields = load()
        except Exception as e:
            self.send_response(500)
            self.end_headers()
            self.wfile.write(str(e).encode())
            return
        if self.path.startswith("/api/v1/license/info"):
            self._json(info)
        elif self.path.startswith("/api/v1/license/fields"):
            self._json(fields)
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("[replicated-stub] " + (fmt % args) + "\n")


if __name__ == "__main__":
    HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
