"""The HTTP transport never sends a loopback request, or its credential, through a proxy.

Every test runs with HTTP_PROXY / http_proxy / HTTPS_PROXY / ALL_PROXY pointing at a local fake
proxy and with NO_PROXY unset, which is the configuration that used to route a local MagicPot
request (and its Bearer token) to the proxy.
"""

import asyncio
import json
import os
import socket
import threading
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

from magicpot_agent_sdk import AsyncMagicAgentClient, GraphRunRequest, HttpAgentTransport
from magicpot_agent_sdk.http_transport import _is_loopback_host

TOKEN = "proxy-test-secret-token"


class _Recorder:
    """A loopback HTTP server that records every request it receives.

    As a proxy it receives absolute-form request targets (``POST http://host/path``)."""

    def __init__(self, host="127.0.0.1", family=socket.AF_INET):
        self.requests = []
        self.redirect_to = None
        recorder = self

        class Server(ThreadingHTTPServer):
            address_family = family
            daemon_threads = True

        class Handler(BaseHTTPRequestHandler):
            def _handle(self):
                length = int(self.headers.get("content-length") or 0)
                if length:
                    self.rfile.read(length)
                recorder.requests.append({
                    "method": self.command,
                    "target": self.path,
                    "authorization": self.headers.get("authorization"),
                })
                location = recorder.redirect_to(self.path) if recorder.redirect_to else None
                if location is not None:
                    self.send_response(302)
                    self.send_header("location", location)
                    self.send_header("content-length", "0")
                    self.end_headers()
                    return
                if self.path.endswith("/graphRun.attach"):
                    body = b'{"eventId":"one"}\n{"eventId":"two"}\n'
                    content_type = "application/x-ndjson"
                else:
                    body = json.dumps({"runId": "run", "status": "completed", "target": self.path}).encode()
                    content_type = "application/json"
                self.send_response(200)
                self.send_header("content-type", content_type)
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            do_GET = _handle
            do_POST = _handle

            def log_message(self, *_args):
                pass

        self.server = Server((host, 0), Handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()

    def tokens_seen(self):
        return [request["authorization"] for request in self.requests if request["authorization"]]


def _proxy_environment(proxy_url):
    environment = {
        key: value for key, value in os.environ.items() if not key.lower().endswith("_proxy")
    }
    for name in ("HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"):
        environment[name] = proxy_url
    return environment


def _ipv6_loopback_available():
    if not socket.has_ipv6:
        return False
    try:
        with socket.socket(socket.AF_INET6, socket.SOCK_STREAM) as probe:
            probe.bind(("::1", 0))
        return True
    except OSError:
        return False


class ProxyEnvironmentTest(unittest.TestCase):
    def setUp(self):
        self.proxy = _Recorder()
        self.target = _Recorder()
        environment = patch.dict(os.environ, _proxy_environment(f"http://127.0.0.1:{self.proxy.port}"), clear=True)
        environment.start()
        self.addCleanup(environment.stop)
        # urlopen caches the default opener, and with it the proxies it read at that time.
        urllib.request.install_opener(None)
        self.addCleanup(urllib.request.install_opener, None)
        self.addCleanup(self.proxy.close)
        self.addCleanup(self.target.close)

    def test_the_environment_routes_plain_urllib_loopback_requests_to_the_fake_proxy(self):
        # Control: without the SDK's fix this is the path its requests took.
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.target.port}/v2/sdk/agent.run",
            data=b"{}",
            headers={"authorization": f"Bearer {TOKEN}"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=5) as response:
            response.read()
        self.assertEqual(len(self.proxy.requests), 1)
        self.assertEqual(self.proxy.tokens_seen(), [f"Bearer {TOKEN}"])
        self.assertEqual(self.target.requests, [])

    def test_loopback_requests_go_direct_and_the_token_never_reaches_the_proxy(self):
        for host in ("127.0.0.1", "127.1", "2130706433", "localhost", "LOCALHOST"):
            with self.subTest(host=host):
                self.target.requests.clear()
                transport = HttpAgentTransport(f"http://{host}:{self.target.port}", TOKEN, timeout=5)
                self.assertEqual(transport.request("agent.run", {})["status"], "completed")
                with transport.stream("graphRun.attach", {}) as stream:
                    self.assertEqual([event["eventId"] for event in stream], ["one", "two"])
                self.assertEqual(
                    [request["target"] for request in self.target.requests],
                    ["/v2/sdk/agent.run", "/v2/sdk/graphRun.attach"],
                )
                self.assertEqual(self.target.tokens_seen(), [f"Bearer {TOKEN}"] * 2)
        self.assertEqual(self.proxy.requests, [])

    @unittest.skipUnless(_ipv6_loopback_available(), "IPv6 loopback is not available")
    def test_ipv6_loopback_requests_go_direct(self):
        target = _Recorder("::1", socket.AF_INET6)
        self.addCleanup(target.close)
        for base_url in (f"http://[::1]:{target.port}", f"http://[0:0:0:0:0:0:0:1]:{target.port}/"):
            with self.subTest(base_url=base_url):
                HttpAgentTransport(base_url, TOKEN, timeout=5).request("agent.run", {})
        self.assertEqual(target.tokens_seen(), [f"Bearer {TOKEN}"] * 2)
        self.assertEqual(self.proxy.requests, [])

    def test_async_client_requests_and_streams_go_direct_for_loopback(self):
        client = AsyncMagicAgentClient(HttpAgentTransport(f"http://localhost:{self.target.port}", TOKEN, timeout=5))

        async def main():
            await client.run_graph(GraphRunRequest("graph", "hello", {"channel": "sdk", "scopeType": "run", "scopeId": "run"}))
            events = client.attach_graph_run("run", {"channel": "sdk", "scopeType": "run", "scopeId": "run"})
            try:
                return [event["eventId"] async for event in events]
            finally:
                await events.aclose()

        self.assertEqual(asyncio.run(main()), ["one", "two"])
        self.assertEqual(
            [request["target"] for request in self.target.requests],
            ["/v2/sdk/graph.run", "/v2/sdk/graphRun.attach"],
        )
        self.assertEqual(self.proxy.requests, [])

    def test_a_remote_base_url_still_uses_the_configured_proxy(self):
        transport = HttpAgentTransport("http://magicpot.example.test:8080", TOKEN, timeout=5)
        value = transport.request("agent.run", {})
        with transport.stream("graphRun.attach", {}) as stream:
            self.assertEqual([event["eventId"] for event in stream], ["one", "two"])
        self.assertEqual(value["target"], "http://magicpot.example.test:8080/v2/sdk/agent.run")
        self.assertEqual(
            [request["target"] for request in self.proxy.requests],
            ["http://magicpot.example.test:8080/v2/sdk/agent.run", "http://magicpot.example.test:8080/v2/sdk/graphRun.attach"],
        )
        self.assertEqual(self.target.requests, [])

    def test_a_remote_base_url_still_honours_no_proxy(self):
        os.environ["NO_PROXY"] = os.environ["no_proxy"] = "magicpot.example.test"
        with patch("magicpot_agent_sdk.http_transport.urlopen", wraps=urllib.request.urlopen) as opened:
            with self.assertRaises(OSError):
                # Direct, so the made-up name does not resolve; the proxy must not see it.
                HttpAgentTransport("http://magicpot.example.test:8080", TOKEN, timeout=5).request("agent.run", {})
        self.assertEqual(opened.call_count, 1)
        self.assertEqual(self.proxy.requests, [])


class RedirectTest(unittest.TestCase):
    def setUp(self):
        self.proxy = _Recorder()
        self.target = _Recorder()
        self.other = _Recorder()
        environment = patch.dict(os.environ, _proxy_environment(f"http://127.0.0.1:{self.proxy.port}"), clear=True)
        environment.start()
        self.addCleanup(environment.stop)
        urllib.request.install_opener(None)
        self.addCleanup(urllib.request.install_opener, None)
        for server in (self.proxy, self.target, self.other):
            self.addCleanup(server.close)

    def test_a_loopback_redirect_to_another_origin_is_refused(self):
        for location in (
            f"http://127.0.0.1:{self.other.port}/steal",  # same host, other port
            f"http://localhost:{self.other.port}/steal",
            "http://magicpot.example.test/steal",  # a remote host: would bypass the user's proxy
        ):
            with self.subTest(location=location):
                self.target.redirect_to = lambda _path, location=location: location
                transport = HttpAgentTransport(f"http://127.0.0.1:{self.target.port}", TOKEN, timeout=5)
                with self.assertRaisesRegex(RuntimeError, "redirect to another origin"):
                    transport.request("agent.run", {})
                with self.assertRaisesRegex(RuntimeError, "redirect to another origin"):
                    transport.stream("graphRun.attach", {})
        self.assertEqual(self.other.requests, [])
        self.assertEqual(self.proxy.requests, [])

    def test_a_same_origin_loopback_redirect_is_followed_without_the_token(self):
        self.target.redirect_to = lambda path: "/moved" if path == "/v2/sdk/agent.run" else None
        HttpAgentTransport(f"http://127.0.0.1:{self.target.port}", TOKEN, timeout=5).request("agent.run", {})
        self.assertEqual(
            [(request["method"], request["target"], request["authorization"]) for request in self.target.requests],
            [("POST", "/v2/sdk/agent.run", f"Bearer {TOKEN}"), ("GET", "/moved", None)],
        )
        self.assertEqual(self.proxy.requests, [])

    def test_a_remote_redirect_does_not_carry_the_token_to_the_new_host(self):
        self.proxy.redirect_to = lambda target: (
            "http://elsewhere.example.test/collect" if target.startswith("http://magicpot.example.test") else None
        )
        for headers, token in (({}, TOKEN), ({"Authorization": f"Bearer {TOKEN}"}, None)):
            with self.subTest(custom_header=bool(headers)):
                self.proxy.requests.clear()
                HttpAgentTransport("http://magicpot.example.test", token, timeout=5, headers=headers).request(
                    "agent.run", {}
                )
                self.assertEqual(
                    [(request["target"], request["authorization"]) for request in self.proxy.requests],
                    [
                        ("http://magicpot.example.test/v2/sdk/agent.run", f"Bearer {TOKEN}"),
                        ("http://elsewhere.example.test/collect", None),
                    ],
                )


class LoopbackHostTest(unittest.TestCase):
    def test_loopback_spellings(self):
        for host in (
            "127.0.0.1", "127.1", "127.0.1", "127.255.255.254", "0x7f.1", "0x7F000001", "2130706433",
            "017700000001", "::1", "[::1]", "0:0:0:0:0:0:0:1", "::1%25lo", "::ffff:127.0.0.1",
            "::ffff:7f00:1", "localhost", "LOCALHOST", "LocalHost", "localhost.", "app.localhost",
            "%31%32%37.0.0.1", "127.0.0.1.", "0.0.0.0", "::",
        ):
            with self.subTest(host=host):
                self.assertTrue(_is_loopback_host(host))

    def test_other_hosts(self):
        for host in (
            None, "", ".", "128.0.0.1", "10.0.0.1", "126.255.255.255", "1.127.0.0", "::2", "fe80::1",
            "::ffff:10.0.0.1", "example.com", "localhost.example.com", "localhostx", "mylocalhost",
            "127.0.0.1.example.com", "127.0.0.1 example.com", "localhost..", "127.0.0.1:80",
        ):
            with self.subTest(host=host):
                self.assertFalse(_is_loopback_host(host))


if __name__ == "__main__":
    unittest.main()
