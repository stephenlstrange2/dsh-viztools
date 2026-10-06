from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from dsh_viztools.session import load_session


class SessionLoaderTest(unittest.TestCase):
    def test_plaintext_timeline_and_tool_duration(self) -> None:
        records = [
            {"version": 4, "cwd": "/work", "createdAt": 1_000},
            {"type": "user/message", "seq": 1, "time": 1_000, "data": {"turn": 1, "message": {"content": [{"type": "text", "text": "hello"}]}}},
            {"type": "tool/call", "seq": 2, "time": 1_100, "data": {"turn": 1, "step": 1, "callId": "call-1", "name": "read", "arguments": "{}"}},
            {"type": "tool/result", "seq": 3, "time": 1_350, "data": {"turn": 1, "step": 1, "message": {"toolCallId": "call-1", "isError": False, "content": [{"type": "text", "text": "ok"}]}}},
            {"type": "assistant/message", "seq": 4, "time": 1_500, "data": {"turn": 1, "step": 1, "message": {"content": [{"type": "text", "text": "done"}]}, "usage": {"inputTokens": 7, "outputTokens": 3}}},
            {"type": "assistant/attempt", "seq": 5, "time": 1_600, "data": {"turn": 1, "step": 2, "stream": []}},
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "session.v4.jsonl")
            path.write_text("".join(json.dumps(row) + "\n" for row in records), encoding="utf-8")
            session = load_session(path)

        self.assertEqual(session.header["version"], 4)
        self.assertEqual(session.summary["events"], 5)
        self.assertEqual(session.summary["tool_calls"], 1)
        self.assertEqual(session.summary["total_tokens"], 10)
        self.assertEqual(session.summary["assistant_attempts_without_message"], 1)
        self.assertEqual(session.tool_calls[0]["duration_ms"], 250)
        self.assertEqual(session.timeline[0]["summary"], "hello")

    def test_result_id_and_error_on_content_block(self) -> None:
        # The shape DSH 0.2 writes: id on message.source and the tool-result block, isError on the block.
        records = [
            {"version": 4},
            {"type": "tool/call", "seq": 1, "time": 2_000, "data": {"turn": 1, "step": 1, "callId": "c1", "name": "mcp__otx__diff", "arguments": "{}"}},
            {"type": "tool/result", "seq": 2, "time": 2_400, "data": {"turn": 1, "step": 1, "message": {"id": "m", "role": "tool", "source": {"kind": "tool", "callId": "c1"}, "content": [{"type": "tool-result", "toolCallId": "c1", "isError": False, "content": []}]}}},
            {"type": "tool/call", "seq": 3, "time": 3_000, "data": {"turn": 1, "step": 2, "callId": "c2", "name": "read", "arguments": "{}"}},
            {"type": "tool/result", "seq": 4, "time": 3_100, "data": {"turn": 1, "step": 2, "error": {"name": "FsError", "code": "FS_NOT_FOUND"}, "message": {"source": {"kind": "tool", "callId": "c2"}, "content": [{"type": "tool-result", "toolCallId": "c2", "isError": True, "content": []}]}}},
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "session.v4.jsonl")
            path.write_text("".join(json.dumps(row) + "\n" for row in records), encoding="utf-8")
            session = load_session(path)

        first, second = session.tool_calls
        self.assertEqual((first["duration_ms"], first["is_error"]), (400, False))
        self.assertEqual((second["duration_ms"], second["is_error"], second["error_code"]), (100, True, "FS_NOT_FOUND"))
        self.assertEqual(session.summary["failed_tool_calls"], 1)


if __name__ == "__main__":
    unittest.main()
