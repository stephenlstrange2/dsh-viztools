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

    def test_ptc_dispatch_error_shape_is_top_level(self) -> None:
        directory, session = self.fixture()
        self.addCleanup(directory.cleanup)
        explanation = explain_plan(session)
        ptc = next(call for call in explanation.calls if call["call_id"] == "test-1")
        self.assertTrue(ptc["is_error"])
        self.assertEqual(ptc["error_code"], "EXIT_1")
        self.assertEqual(ptc["duration_ms"], 300)

    def test_reports_approved_rules_and_refusals(self) -> None:
        directory, session = self.fixture()
        self.addCleanup(directory.cleanup)
        session.events.append({
            "type": "viztools-run-rules/change", "seq": 10, "time": 2_000,
            "data": {"kind": "approved", "version": 1, "callId": "rules", "rules": {
                "version": 1, "allow": ["read"], "deny": ["bash"], "limits": {"read": 1}, "notes": ["no edits"],
            }},
        })
        session.events.append({
            "type": "viztools-run-rules/change", "seq": 11, "time": 2_100,
            "data": {"kind": "refused-call", "version": 1, "callId": "blocked", "tool": "bash", "reason": "denied"},
        })
        explanation = explain_plan(session)
        self.assertTrue(explanation.summary["approved_run_rules"])
        self.assertEqual(explanation.summary["run_rule_refusals"], 1)
        self.assertEqual(len(explanation.rules), 3)
        self.assertEqual(explanation.rules[-1]["enforcement"], "advisory-not-enforced")

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

    def standard_mode_session(self):
        records = [
            {"version": 4},
            {"type": "user/message", "seq": 1, "time": 1, "data": {"turn": 1, "message": {"content": [{"type": "text", "text": "build it"}]}}},
            {"type": "tool/call", "seq": 2, "time": 2, "data": {"callId": "x", "name": "read", "arguments": json.dumps({"file_path": "src/api.py"})}},
            {"type": "tool/result", "seq": 3, "time": 3, "data": {"message": {"toolCallId": "x", "isError": False, "content": []}}},
        ]
        directory = tempfile.TemporaryDirectory()
        path = Path(directory.name, "session.v4.jsonl")
        path.write_text("".join(json.dumps(row) + "\n" for row in records), encoding="utf-8")
        return directory, load_session(path)

    def test_missing_plan_returns_execution_only_evidence(self) -> None:
        directory, session = self.standard_mode_session()
        self.addCleanup(directory.cleanup)
        explanation = explain_plan(session)
        self.assertEqual(explanation.plan["source"], "not-observed")
        self.assertEqual(explanation.plan["markdown"], None)
        self.assertFalse(explanation.summary["comparison_available"])
        self.assertEqual(explanation.summary["execution_calls"], 1)
        self.assertEqual(explanation.calls[0]["attribution"], "not-observed")

    def test_user_provided_plan_uses_explicit_boundary(self) -> None:
        directory, session = self.standard_mode_session()
        self.addCleanup(directory.cleanup)
        explanation = explain_plan(
            session,
            plan_markdown="# API plan\n\n## Inspect API\nRead src/api.py.",
            source="user-provided",
            boundary_seq=1,
        )
        self.assertEqual(explanation.plan["source"], "user-provided")
        self.assertEqual(explanation.plan["approval"], "not-observed")
        self.assertTrue(explanation.summary["comparison_available"])
        self.assertEqual(explanation.summary["boundary"], "explicit-seq")
        self.assertEqual(explanation.summary["execution_calls"], 1)
        self.assertEqual(explanation.calls[0]["phase"], "Inspect API")

    def test_reconstructed_plan_is_labelled(self) -> None:
        directory, session = self.standard_mode_session()
        self.addCleanup(directory.cleanup)
        explanation = session.explain_plan(
            plan_markdown="# Reconstructed work\n\n## Read API\nInspect src/api.py.",
            source="reconstructed",
            boundary="first-user-message",
        )
        self.assertEqual(explanation.summary["plan_source"], "reconstructed")
        self.assertEqual(explanation.summary["approval"], "not-observed")
        self.assertEqual(explanation.summary["boundary_seq"], 1)


if __name__ == "__main__":
    unittest.main()
