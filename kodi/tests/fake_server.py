"""A Subsonic server in a dictionary, plugged in as the client's opener."""

import io
import json
import urllib.parse


class FakeServer:
    def __init__(self, answers=None):
        self.answers = answers or {}
        self.calls = []

    def __call__(self, request, timeout=None):
        address = request.full_url
        view = urllib.parse.urlsplit(address).path.split("/rest/", 1)[1][: -len(".view")]
        query = request.data.decode() if request.data else urllib.parse.urlsplit(address).query
        params = urllib.parse.parse_qs(query)
        self.calls.append((view, params))
        answer = self.answers.get(view, {})
        if callable(answer):
            answer = answer(params)
        body = {"subsonic-response": dict({"status": "ok", "version": "1.16.1"}, **answer)}
        return io.BytesIO(json.dumps(body).encode())

    def views(self):
        return [view for view, _ in self.calls]
