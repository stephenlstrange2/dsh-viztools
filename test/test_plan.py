from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from dsh_viztools.plan import classify_tool, explain_plan, extract_plans
from dsh_viztools.session import load_session


class PlanExplanationTest(unittest.TestCase):
    def fixture(self):
        plan = """# Ship search integration

## Inspect API
Read the search client and configuration.

## Implement MCP search
Use context7 search and edit the client.

## Verify tests
Run tests and confirm failures are fixed.
"""
        records = [
            {"version": 4, "cwd": "/work", "createdAt": 1_000},
            {"type": "plan/mode", "seq": 1, "time": 1_000, "data": {"active": True}},
            {"type": "tool/call", "seq": 2, "time": 1_100, "data": {"turn": 1, "step": 1, "callId": "plan-1", "name": "exit_plan_mode", "arguments": json.dumps({"plan": plan})}},
            {"type": "tool/result", "seq": 3, "time": 1_200, "data": {"turn": 1, "step": 1, "message": {"toolCallId": "plan-1", "isError": False, "content": [{"type": "text", "text": "approved"}]}}},
            {"type": "tool/call", "seq": 4, "time": 1_300, "data": {"turn": 2, "step": 1, "callId": "read-1", "name": "read", "arguments": json.dumps({"file_path": "src/search-client.ts"})}},
            {"type": "tool/result", "seq": 5, "time": 1_350, "data": {"turn": 2, "step": 1, "message": {"toolCallId": "read-1", "isError": False, "content": []}}},
            {"type": "tool/call", "seq": 6, "time": 1_400, "data": {"turn": 2, "step": 1, "callId": "mcp-1", "name": "mcp__context7__search", "arguments": json.dumps({"query": "search client API"})}},
            {"type": "tool/result", "seq": 7, "time": 1_500, "data": {"turn": 2, "step": 1, "message": {"toolCallId": "mcp-1", "isError": False, "content": []}}},
            {"type": "tool/ptc-dispatch-start", "seq": 8, "time": 1_600, "data": {"rootCallId": "root", "parentCallId": "root", "subCallId": "test-1", "name": "bash", "arguments": {"command": "pnpm test"}}},
            {"type": "tool/ptc-dispatch", "seq": 9, "time": 1_900, "data": {"rootCallId": "root", "parentCallId": "root", "subCallId": "test-1", "name": "bash", "arguments": {"command": "pnpm test"}, "isError": True, "content": [], "error": {"name": "Error", "code": "EXIT_1"}}},
        ]
        directory = tempfile.TemporaryDirectory()
        path = Path(directory.name, "session.v4.jsonl")
        path.write_text("".join(json.dumps(row) + "\n" for row in records), encoding="utf-8")
        return directory, load_session(path)

    def test_classifies_mcp_names(self) -> None:
        self.assertEqual(classify_tool("read")["kind"], "native")
        self.assertEqual(classify_tool("mcp__context7__search"), {
            "kind": "mcp",
            "server": "context7",
            "operation": "search",
        })

    def test_extracts_plan_and_explains_post_submission_calls(self) -> None:
        directory, session = self.fixture()
        self.addCleanup(directory.cleanup)
        plans = extract_plans(session)
        self.assertEqual(len(plans), 1)
        self.assertEqual(plans[0]["title"], "Ship search integration")

        explanation = explain_plan(session)
        self.assertEqual(explanation.summary["phases"], 3)
        self.assertEqual(explanation.summary["execution_calls"], 3)
        self.assertEqual(explanation.summary["native_calls"], 2)
        self.assertEqual(explanation.summary["mcp_calls"], 1)
        self.assertEqual(explanation.summary["failed_calls"], 1)
        self.assertEqual(explanation.summary["mcp_servers"], ["context7"])
        self.assertEqual(explanation.mcp_inventory[0], {
            "server": "context7",
            "operation": "search",
            "calls": 1,
        })
        ptc = next(call for call in explanation.calls if call["call_id"] == "test-1")
        self.assertEqual(ptc["duration_ms"], 300)
        self.assertEqual(ptc["error_code"], "EXIT_1")
        self.assertEqual(ptc["transport"], "ptc")
        self.assertIn(ptc["attribution"], {"heuristic", "not-observed"})

    def test_requires_a_submitted_plan(self) -> None:
        records = [
            {"version": 4},
            {"type": "tool/call", "seq": 1, "time": 1, "data": {"callId": "x", "name": "read", "arguments": "{}"}},
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "session.v4.jsonl")
            path.write_text("".join(json.dumps(row) + "\n" for row in records), encoding="utf-8")
            session = load_session(path)
        with self.assertRaisesRegex(ValueError, "no valid exit_plan_mode"):
            explain_plan(session)


if __name__ == "__main__":
    unittest.main()
