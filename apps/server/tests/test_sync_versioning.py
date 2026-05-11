from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

from fastapi.testclient import TestClient


class SyncVersioningTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        db_path = Path(__file__).resolve().parents[1] / "server.sqlite3"
        if db_path.exists():
            db_path.unlink()
        module_path = Path(__file__).resolve().parents[1] / "app" / "main.py"
        spec = importlib.util.spec_from_file_location("server_sync_main", module_path)
        if spec is None or spec.loader is None:
            raise RuntimeError("failed to load server main module")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.init_db()
        cls.client = TestClient(module.app)

    def _register(self, username: str) -> str:
        invite_res = self.client.post("/admin/invite-codes?token=drama-debug", json={})
        self.assertEqual(invite_res.status_code, 200, invite_res.text)
        invite_code = invite_res.json()["code"]
        response = self.client.post(
            "/auth/register",
            json={"username": username, "password": "password123", "invite_code": invite_code},
        )
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["access_token"]

    def _push(self, token: str, base_version: int, snapshot: dict):
        return self.client.post(
            "/sync/push",
            json={"direction": "push_pull", "base_version": base_version, "data": snapshot},
            headers={"Authorization": f"Bearer {token}"},
        )

    def test_sync_push_rejects_when_remote_ahead(self):
        token = self._register("sync_user_a")
        snapshot_v1 = {
            "profile": {"nickname": "A"},
            "sentences": [{"uuid": "s-1", "example_ja": "こんにちは"}],
            "vocab_items": [{"uuid": "v-1", "surface": "今日", "dictionary_form": "今日"}],
        }
        r1 = self._push(token, 0, snapshot_v1)
        self.assertEqual(r1.status_code, 200, r1.text)
        self.assertTrue(r1.json()["ok"])
        self.assertEqual(r1.json()["version"], 1)

        snapshot_v2 = {
            "profile": {"nickname": "A2"},
            "sentences": [{"uuid": "s-1", "example_ja": "こんばんは"}],
            "vocab_items": [{"uuid": "v-1", "surface": "明日", "dictionary_form": "明日"}],
        }
        # stale base_version should be blocked
        r2 = self._push(token, 0, snapshot_v2)
        self.assertEqual(r2.status_code, 200, r2.text)
        payload = r2.json()
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["state"], "needs_pull")
        self.assertEqual(payload["latest_version"], 1)
        remote_change_types = {f"{c['type']}:{c['uuid']}" for c in payload["remote_changes"]["created"] + payload["remote_changes"]["updated"]}
        self.assertIn("profile:profile", remote_change_types)
        self.assertIn("sentences:s-1", remote_change_types)
        self.assertIn("vocab_items:v-1", remote_change_types)

    def test_sync_changes_reports_delta_since_version(self):
        token = self._register("sync_user_b")
        v1 = {
            "profile": {"nickname": "B"},
            "sentences": [{"uuid": "s-2", "example_ja": "1回目"}],
            "vocab_items": [{"uuid": "v-2", "surface": "猫", "dictionary_form": "猫"}],
        }
        r1 = self._push(token, 0, v1)
        self.assertEqual(r1.status_code, 200, r1.text)
        self.assertTrue(r1.json()["ok"])
        self.assertEqual(r1.json()["version"], 1)

        v2 = {
            "profile": {"nickname": "B"},
            "sentences": [{"uuid": "s-2", "example_ja": "2回目"}],
            "vocab_items": [],
        }
        r2 = self._push(token, 1, v2)
        self.assertEqual(r2.status_code, 200, r2.text)
        self.assertTrue(r2.json()["ok"])
        self.assertEqual(r2.json()["version"], 2)

        delta = self.client.get("/sync/changes?since_version=1", headers={"Authorization": f"Bearer {token}"})
        self.assertEqual(delta.status_code, 200, delta.text)
        body = delta.json()
        self.assertEqual(body["latest_version"], 2)
        updated = {(item["type"], item["uuid"]) for item in body["changes"]["updated"]}
        deleted = {(item["type"], item["uuid"]) for item in body["changes"]["deleted"]}
        self.assertIn(("sentences", "s-2"), updated)
        self.assertIn(("vocab_items", "v-2"), deleted)


if __name__ == "__main__":
    unittest.main()
