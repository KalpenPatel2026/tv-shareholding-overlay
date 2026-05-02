"""
Tiny local HTTP server. Serves extension/data.json on 127.0.0.1:8765
with CORS headers permitting fetch from tradingview.com.

The Chrome extension calls:
    fetch("http://127.0.0.1:8765/data.json")

Run via Windows Task Scheduler at user logon (see setup_scheduler.ps1).

Usage:
  python data_server.py                # default 127.0.0.1:8765
  python data_server.py --port 9000
"""
import argparse, http.server, json, pathlib, socket, socketserver, sys, urllib.request

HERE = pathlib.Path(__file__).parent
DATA = HERE / "extension" / "data.json"

ALLOWED_ORIGINS = (
    "https://www.tradingview.com",
    "https://in.tradingview.com",
    "https://tradingview.com",
)


class Handler(http.server.BaseHTTPRequestHandler):
    def _set_cors(self):
        origin = self.headers.get("Origin", "")
        if origin in ALLOWED_ORIGINS or origin.endswith(".tradingview.com"):
            self.send_header("Access-Control-Allow-Origin", origin)
        else:
            self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        # Chrome Private Network Access: HTTPS pages fetching HTTP localhost.
        # Server must opt-in by acknowledging the preflight header.
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Cache-Control", "no-store")

    def do_OPTIONS(self):
        self.send_response(204)
        self._set_cors()
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/data.json"):
            if not DATA.exists():
                self.send_response(404)
                self._set_cors()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"error":"data.json not found - run scrape_shareholding.py"}')
                return
            body = DATA.read_bytes()
            self.send_response(200)
            self._set_cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path == "/health":
            self.send_response(200)
            self._set_cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"ok":true}')
        else:
            self.send_response(404)
            self._set_cors()
            self.end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))


class ReusableTCPServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def _already_running(host, port):
    try:
        with urllib.request.urlopen(f"http://{host}:{port}/health", timeout=1) as r:
            return r.status == 200 and b'"ok":true' in r.read()
    except Exception:
        return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()

    if _already_running(args.host, args.port):
        print(f"data_server already running on {args.host}:{args.port}. "
              f"Skipping start (this instance exits cleanly).")
        return

    try:
        srv = ReusableTCPServer((args.host, args.port), Handler)
    except OSError as e:
        print(f"Cannot bind {args.host}:{args.port}: {e}", file=sys.stderr)
        print("Another process is using that port but isn't a TVOverlay server.", file=sys.stderr)
        print("Find and stop it, or pass --port 8766.", file=sys.stderr)
        sys.exit(1)

    with srv:
        print(f"Serving {DATA} on http://{args.host}:{args.port}/data.json")
        print("Press Ctrl-C to stop.")
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down.")


if __name__ == "__main__":
    main()
