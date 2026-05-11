from __future__ import annotations

import unittest

from app.services.vocab_service import _detect_conflicts, _diff_snapshots


class SyncDiffTest(unittest.TestCase):
    def test_diff_snapshots_counts_create_update_delete(self):
        base = {
            "profile": {"nickname": "A"},
            "sentences": [{"uuid": "s-1", "example_ja": "旧"}],
            "vocab_items": [{"uuid": "v-1", "surface": "猫"}],
        }
        target = {
            "profile": {"nickname": "B"},
            "sentences": [{"uuid": "s-1", "example_ja": "新"}, {"uuid": "s-2", "example_ja": "新增"}],
            "vocab_items": [],
        }
        changes = _diff_snapshots(base, target)
        created = {(item["type"], item["uuid"]) for item in changes["created"]}
        updated = {(item["type"], item["uuid"]) for item in changes["updated"]}
        deleted = {(item["type"], item["uuid"]) for item in changes["deleted"]}
        self.assertIn(("sentences", "s-2"), created)
        self.assertIn(("sentences", "s-1"), updated)
        self.assertIn(("profile", "profile"), updated)
        self.assertIn(("vocab_items", "v-1"), deleted)

    def test_detect_conflicts_on_same_entity_uuid(self):
        local = {
            "created": [{"type": "sentences", "uuid": "s-1", "value": {"example_ja": "本地创建"}}],
            "updated": [{"type": "vocab_items", "uuid": "v-1", "value": {"surface": "猫"}}],
            "deleted": [],
        }
        remote = {
            "created": [],
            "updated": [{"type": "sentences", "uuid": "s-1", "value": {"example_ja": "云端修改"}}],
            "deleted": [{"type": "vocab_items", "uuid": "v-1", "value": {"surface": "狗"}}],
        }
        conflicts = _detect_conflicts(local, remote)
        conflict_keys = {(item["type"], item["uuid"]) for item in conflicts}
        self.assertIn(("sentences", "s-1"), conflict_keys)
        self.assertIn(("vocab_items", "v-1"), conflict_keys)
        sentence_conflict = next(item for item in conflicts if item["type"] == "sentences")
        self.assertEqual(sentence_conflict["local_value"]["example_ja"], "本地创建")
        self.assertEqual(sentence_conflict["remote_value"]["example_ja"], "云端修改")


if __name__ == "__main__":
    unittest.main()
