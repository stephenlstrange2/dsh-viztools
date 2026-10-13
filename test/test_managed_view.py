from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path

import html
import shutil
import subprocess

from dsh_viztools.managed_view import STORAGE_SHIM, is_safe_session_id, load_gate_status, load_view_state, report_frame, safe_report_url, with_storage_shim


class ManagedViewTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name) / "reports"
        self.root.mkdir()
        self.outside = Path(self._tmp.name) / "outside"
        self.outside.mkdir()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def publish(self, session: str, state: dict) -> Path:
        directory = self.root / session
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "state.json").write_text(json.dumps(state), encoding="utf-8")
        return directory

    def test_rejects_traversal_session_ids_before_filesystem_access(self) -> None:
        for value in ["../outside", "a/b", "..", ".hidden", "a..b", "a\\b", "x" * 200]:
            self.assertFalse(is_safe_session_id(value), value)
            self.assertEqual(load_view_state(value, self.root)["status"], "invalid")

    def test_missing_state_is_pending(self) -> None:
        self.assertEqual(load_view_state("s1", self.root)["status"], "pending")
        self.assertEqual(load_view_state("", self.root)["status"], "pending")

    def test_available_state_embeds_contained_report(self) -> None:
        directory = self.publish("s1", {"status": "available", "sessionId": "s1", "html": str(self.root / "s1" / "report.html")})
        (directory / "report.html").write_text("<h1>ok</h1>", encoding="utf-8")
        view = load_view_state("s1", self.root)
        self.assertEqual(view["status"], "available")
        self.assertEqual(view["html"], "<h1>ok</h1>")

    def test_refuses_reports_outside_the_session_directory(self) -> None:
        (self.outside / "report.html").write_text("secret", encoding="utf-8")
        self.publish("s1", {"status": "available", "sessionId": "s1", "html": str(self.outside / "report.html")})
        self.assertEqual(load_view_state("s1", self.root)["status"], "invalid")
        directory = self.publish("s2", {"status": "available", "sessionId": "s2", "html": str(self.root / "s2" / "report.html")})
        os.symlink(self.outside / "report.html", directory / "report.html")
        view = load_view_state("s2", self.root)
        self.assertEqual(view["status"], "invalid")
        self.assertNotIn("secret", view["html"])

    def test_refuses_state_for_another_session(self) -> None:
        self.publish("s1", {"status": "available", "sessionId": "other", "html": ""})
        self.assertEqual(load_view_state("s1", self.root)["status"], "invalid")

    def test_failed_state_surfaces_reason(self) -> None:
        self.publish("s1", {"status": "failed", "sessionId": "s1", "reason": "export timed out"})
        view = load_view_state("s1", self.root)
        self.assertEqual((view["status"], view["reason"]), ("failed", "export timed out"))

    def test_report_url_must_target_the_authenticated_route(self) -> None:
        self.assertEqual(safe_report_url("http://127.0.0.1:3185/api/viztools/report?session=s1"), "http://127.0.0.1:3185/api/viztools/report?session=s1")
        for value in ["javascript:alert(1)", "/api/viztools/report?session=s1", "http://x/api/other", "file:///etc/passwd"]:
            self.assertEqual(safe_report_url(value), "", value)

    def test_report_frame_has_a_fixed_height_and_no_marimo_auto_resize(self) -> None:
        frame = report_frame('<html><body onload="x()">"quoted" & <b>bold</b></body></html>')
        self.assertIn("height:80vh", frame)
        self.assertNotIn("__resizeIframe", frame)
        self.assertNotIn("onload=", frame.split("srcdoc=")[0])
        self.assertIn('sandbox="allow-scripts allow-popups allow-downloads"', frame)
        self.assertNotIn("allow-same-origin", frame)
        self.assertIn("&quot;quoted&quot; &amp; &lt;b&gt;", frame)

    def test_viewer_app_does_not_use_mo_iframe(self) -> None:
        source = (Path(__file__).resolve().parents[1] / "python" / "dsh_viztools" / "managed_report_app.py").read_text(encoding="utf-8")
        self.assertNotIn("mo.iframe(", source)
        self.assertIn("report_frame(", source)

    def test_gate_status_notices_are_shown_and_contained(self) -> None:
        state = Path(self._tmp.name) / "state"
        state.mkdir()
        (state / "s1.status.json").write_text(json.dumps({"sessionId": "s1", "planNotice": "Plan mode is unavailable in this deployment"}), encoding="utf-8")
        (state / "s2.status.json").write_text(json.dumps({"sessionId": "other", "planNotice": "x"}), encoding="utf-8")
        self.assertEqual(load_gate_status("s1", state), ["Plan mode is unavailable in this deployment"])
        (state / "s3.status.json").write_text(json.dumps({"sessionId": "s3", "stateBroken": "gate record #2 is malformed"}), encoding="utf-8")
        self.assertEqual(load_gate_status("s3", state), ["gate record #2 is malformed"])
        self.assertEqual(load_gate_status("s2", state), [])
        self.assertEqual(load_gate_status("../s1", state), [])
        self.assertEqual(load_gate_status("missing", state), [])

    def test_storage_shim_is_the_first_element_of_head_and_keeps_the_sandbox(self) -> None:
        document = '<!DOCTYPE html><html lang="en"><head data-x="1"><meta charset="utf-8"><title>r</title></head><body>DSH session report</body></html>'
        shimmed = with_storage_shim(document)
        self.assertTrue(shimmed.split('<head data-x="1">', 1)[1].startswith('<script data-viztools-storage-shim="1">'))
        self.assertIn("DSH session report", shimmed)
        frame = report_frame(document)
        self.assertNotIn("allow-same-origin", frame)
        self.assertIn('sandbox="allow-scripts allow-popups allow-downloads"', frame)
        srcdoc = html.unescape(frame.split('srcdoc="', 1)[1].rsplit('"', 1)[0])
        self.assertEqual(srcdoc.count("data-viztools-storage-shim"), 1)
        self.assertLess(srcdoc.index("data-viztools-storage-shim"), srcdoc.index("<meta"))
        self.assertIn("<head>" + STORAGE_SHIM, with_storage_shim("<html><body>x</body></html>"))

    def test_storage_shim_targets_the_real_head_not_decoys_in_comments_or_scripts(self) -> None:
        document = (
            "<!DOCTYPE html>\r\n<!-- an old <head> in a comment -->"
            "<html><script>var markup = \"<head data-decoy=1>\";</script>\n"
            "<head data-real=\"1\"><meta charset=\"utf-8\"></head><body><p>&lt;head&gt;</p></body></html>"
        )
        shimmed = with_storage_shim(document)
        self.assertEqual(shimmed.count("data-viztools-storage-shim"), 1)
        self.assertTrue(shimmed.split('<head data-real="1">', 1)[1].startswith(STORAGE_SHIM))
        self.assertIn('var markup = "<head data-decoy=1>";', shimmed)
        self.assertIn("<!-- an old <head> in a comment -->", shimmed)
        no_head = with_storage_shim("<!-- <head> --><html lang=\"en\"><body>x</body></html>")
        self.assertIn('<html lang="en"><head>' + STORAGE_SHIM + "</head>", no_head)

    @unittest.skipIf(shutil.which("node") is None, "node is required to execute the shim")
    def test_storage_shim_replaces_throwing_storage_with_memory_storage(self) -> None:
        script = STORAGE_SHIM.split(">", 1)[1].rsplit("</script>", 1)[0]
        harness = """
const insecure = () => { const e = new Error('The operation is insecure.'); e.name = 'SecurityError'; throw e; };
const window = {};
for (const name of ['localStorage', 'sessionStorage', 'indexedDB']) Object.defineProperty(window, name, { get: insecure, configurable: true });
globalThis.window = window;
""" + script + """
window.localStorage.setItem('k', 1);
window.sessionStorage.setItem('s', 'v');
if (window.localStorage.getItem('k') !== '1' || window.localStorage.length !== 1 || window.localStorage.key(0) !== 'k') throw new Error('localStorage shim');
if (window.sessionStorage.getItem('s') !== 'v' || window.sessionStorage.getItem('missing') !== null) throw new Error('sessionStorage shim');
window.localStorage.removeItem('k'); window.localStorage.clear();
if (window.localStorage.length !== 0) throw new Error('clear');
if (window.indexedDB !== undefined) throw new Error('indexedDB should be stubbed when it throws');
console.log('ok');
"""
        result = subprocess.run(["node", "-e", harness], capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "ok")


if __name__ == "__main__":
    unittest.main()
