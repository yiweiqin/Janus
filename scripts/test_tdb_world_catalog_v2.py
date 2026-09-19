import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class TdbWorldCatalogV2Test(unittest.TestCase):
    def test_public_gold_boundary_and_independent_replay(self):
        with tempfile.TemporaryDirectory() as temp:
            temp = Path(temp); raw = temp / "raw"; evaluated = temp / "evaluated"
            subprocess.run([sys.executable, str(ROOT / "scripts/generate_tdb_world_catalog_v2.py"), "--output", str(raw), "--families", "60", "--instances-per-family", "4", "--worlds-per-instance", "4", "--seed", "17"], check=True, capture_output=True, text=True)
            subprocess.run(["node", str(ROOT / "experiments/tdb_probe_benchmark/scripts/evaluate_tdb_world_catalog_v2.mjs"), str(raw), str(evaluated)], check=True, capture_output=True, text=True)
            verified = subprocess.run(["node", str(ROOT / "experiments/tdb_probe_benchmark/scripts/verify_tdb_evaluated_v2.mjs"), str(evaluated)], check=True, capture_output=True, text=True)
            self.assertTrue(json.loads(verified.stdout)["allValid"])
            public = [json.loads(line) for line in (evaluated / "public.jsonl").read_text(encoding="utf-8").splitlines()]
            gold = [json.loads(line) for line in (evaluated / "gold.offline.jsonl").read_text(encoding="utf-8").splitlines()]
            self.assertEqual({row["split"] for row in public}, {"train", "development", "calibration"})
            self.assertTrue(all("worldCatalog" not in row and "currentWorldId" not in row and "utilityGold" not in row for row in public))
            self.assertTrue(all("utilityGold" in row and "statePosterior" in row and "projection" in row for row in gold))
            self.assertTrue(any(item["status"] in {"UNKNOWN", "CONFLICT", "STALE"} for row in gold for item in row["statePosterior"].values()))
            registry = json.loads((raw / "access_registry.jsonl").read_text(encoding="utf-8"))
            self.assertEqual(registry["status"], "generated_frozen_not_evaluated")
            self.assertTrue((raw / "test.frozen.jsonl").exists())


if __name__ == "__main__": unittest.main()
