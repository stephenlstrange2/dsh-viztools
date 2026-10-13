from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from dsh_viztools.plugin_state import compact_tool_rows, gate_records, plan_approval, rules_vs_outcome


def plan_call(call_id: str = "plan") -> list[dict]:
    return [
        {"type": "tool/call", "seq": 1, "time": 1, "data": {"callId": call_id, "name": "exit_plan_mode", "arguments": json.dumps({"plan": "# Validate snoop\n\n1. Replay once"})}},
    ]


class PluginStateTest(unittest.TestCase):
    def sidecar(self, records: list[dict]) -> Path:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / "s.gate.jsonl"
        path.write_text("".join(json.dumps(record) + "\n" for record in records) + '{"torn', encoding="utf-8")
        return path

    def test_reads_sidecar_records_and_ignores_a_torn_tail(self) -> None:
        path = self.sidecar([{"i": 0, "prev": "", "kind": "plan-approved", "data": {"planCallId": "plan"}, "t": 1_700_000_000_000}])
        session = SimpleNamespace(events=[], tool_calls=[], plugin_gate_path=str(path))
        self.assertEqual([record["kind"] for record in gate_records(session)], ["plan-approved"])

    def test_reads_plugin_records_from_the_log(self) -> None:
        session = SimpleNamespace(events=[{"type": "plugin:dsh-viztools/gate", "seq": 0, "ignorable": True, "data": {"kind": "started", "data": {"callId": "c", "tool": "t"}, "t": 1}}], tool_calls=[])
        self.assertEqual(gate_records(session)[0]["kind"], "started")

    def test_plan_text_and_approval_time(self) -> None:
        path = self.sidecar([{"kind": "plan-approved", "data": {"planCallId": "plan"}, "t": 1_700_000_000_000}])
        session = SimpleNamespace(events=plan_call(), tool_calls=[], plugin_gate_path=str(path))
        approval = plan_approval(session)
        self.assertEqual(approval["title"], "Validate snoop")
        self.assertTrue(approval["approved"])
        self.assertEqual(approval["approved_at"], "2023-11-14T22:13:20Z")
        self.assertIn("Replay once", approval["markdown"])

    def test_rules_vs_outcome_counts_starts_and_refusals_including_before_approval(self) -> None:
        records = [
            {"kind": "refused", "data": {"callId": "c0", "tool": "mcp__otx__replay_tx_only", "code": "PLAN_NOT_APPROVED", "beforeApproval": True}, "t": 1},
            {"kind": "plan-approved", "data": {"planCallId": "plan"}, "t": 2},
            {"kind": "rules-approved", "data": {"rules": {"deny": ["mcp__otx__emit_otx"], "limits": {"mcp__otx__replay_tx_only": 1}}}, "t": 3},
            {"kind": "started", "data": {"callId": "c1", "tool": "mcp__otx__replay_tx_only"}, "t": 4},
            {"kind": "started", "data": {"callId": "c9", "tool": "mcp__otx__replay_tx_only"}, "t": 5},
            {"kind": "not-started", "data": {"callId": "c9", "tool": "mcp__otx__replay_tx_only"}, "t": 6},
            {"kind": "refused", "data": {"callId": "c2", "tool": "mcp__otx__replay_tx_only", "code": "RUN_RULE_LIMIT", "beforeApproval": False}, "t": 7},
            {"kind": "refused", "data": {"callId": "c3", "tool": "mcp__otx__emit_otx", "code": "RUN_RULE_DENIED", "beforeApproval": False}, "t": 8},
        ]
        session = SimpleNamespace(events=[], tool_calls=[], plugin_gate_path=str(self.sidecar(records)))
        rows = {row["tool"]: row for row in rules_vs_outcome(session)}
        replay = rows["otx/replay_tx_only"]
        self.assertEqual((replay["rule"], replay["limit"], replay["started"], replay["refused before approval"], replay["refused after approval"], replay["result"]), ("allowed", 1, 1, 1, 1, "limit reached"))
        emit = rows["otx/emit_otx"]
        self.assertEqual((emit["rule"], emit["started"], emit["refused after approval"], emit["result"]), ("denied", 0, 1, "blocked"))

    def test_compact_tool_rows_drop_arguments_for_the_sidebar(self) -> None:
        session = SimpleNamespace(events=[], tool_calls=[{"tool_name": "mcp__otx__diff", "arguments": "{\"secret\": 1}", "duration_ms": 12, "is_error": False}])
        self.assertEqual(compact_tool_rows(session), [{"#": 1, "tool": "otx/diff", "status": "ok", "ms": 12}])

    def test_attaches_state_to_a_real_frozen_session(self) -> None:
        from dsh_viztools.plugin_state import attach_plugin_state
        from dsh_viztools.session import load_session

        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        log = Path(directory.name) / "session.v4.jsonl"
        log.write_text(json.dumps({"type": "session", "version": 4, "id": "s", "createdAt": 1}) + "\n" + json.dumps(plan_call()[0]) + "\n", encoding="utf-8")
        gate = self.sidecar([{"kind": "plan-approved", "data": {"planCallId": "plan"}, "t": 1_700_000_000_000}])
        session = attach_plugin_state(load_session(log), {"backend": "sidecar", "gate": str(gate), "report": None, "status": None})
        self.assertTrue(plan_approval(session)["approved"])


if __name__ == "__main__":
    unittest.main()
