#!/usr/bin/env python3
"""Parity tests for the annotation server's consensus rules.

`lib/consensus.mjs` and `annotate_server.py` implement the same resolution rule
on purpose (the browser UI is Python, the exporter is Node).  These fixtures are
the same ones used in `annotate.test.mjs`, so a drift between the two shows up
as a failing test on one side.
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import annotate_server as srv  # noqa: E402


def row(**over) -> dict:
    base = {"id": "a>b", "dependency": 0.5, "similarity": 0.25, "rationale": ""}
    base.update(over)
    return base


class ResolvePairTest(unittest.TestCase):
    def test_empty_is_unlabeled(self):
        self.assertEqual(srv.resolve_pair([])["status"], "unlabeled")

    def test_prelabel_is_never_the_second_rater(self):
        with_prelabel = [
            row(reviewerId=srv.PRELABEL_ID, role=srv.ROLE_PRELABEL),
            row(reviewerId="jia"),
        ]
        self.assertEqual(srv.resolve_pair(with_prelabel)["status"], "single")

        only = [row(reviewerId=srv.PRELABEL_ID, role=srv.ROLE_PRELABEL)]
        resolved = srv.resolve_pair(only)
        self.assertEqual(resolved["status"], "prelabel")
        self.assertTrue(resolved["prelabelOnly"])

    def test_agreement_and_adjudication(self):
        agreed = srv.resolve_pair([row(reviewerId="jia"), row(reviewerId="yi")])
        self.assertEqual(agreed["status"], "agreed")
        self.assertEqual((agreed["dependency"], agreed["similarity"]), (0.5, 0.25))
        self.assertEqual(agreed["raterCount"], 2)

        clash_rows = [
            row(reviewerId="jia", dependency=0.5),
            row(reviewerId="yi", dependency=0.75),
        ]
        pending = srv.resolve_pair(clash_rows)
        self.assertEqual(pending["status"], "needs_adjudication")
        self.assertIsNone(pending["dependency"])
        self.assertIsNone(pending["similarity"])

        decided = srv.resolve_pair(
            clash_rows + [row(reviewerId="bing", role=srv.ROLE_ADJUDICATOR, dependency=0.75)]
        )
        self.assertEqual(decided["status"], "adjudicated")
        self.assertEqual(decided["dependency"], 0.75)
        self.assertEqual(decided["reviewerId"], "bing")

    def test_role_falls_back_to_annotator_id(self):
        self.assertEqual(srv.role_of({"annotatorId": "prelabel_v1"}), srv.ROLE_PRELABEL)
        self.assertEqual(srv.role_of({"annotatorId": "jia"}), srv.ROLE_REVIEWER)
        self.assertEqual(srv.role_of({"reviewerId": "bing", "role": "adjudicator"}), srv.ROLE_ADJUDICATOR)


class AgreementReportTest(unittest.TestCase):
    def test_kappa_and_within_step_match_the_js_fixture(self):
        plan = [
            ("p1", 0, 0, 0, 0),
            ("p2", 0.25, 0.25, 0.25, 0.25),
            ("p3", 0.5, 0.5, 0.5, 0.5),
            ("p4", 1, 1, 0.5, 0.75),
        ]
        index: dict[str, list[dict]] = {}
        for pair_id, dl, dr, sl, sr in plan:
            index[pair_id] = [
                {"id": pair_id, "reviewerId": "jia", "role": "reviewer", "dependency": dl, "similarity": sl},
                {"id": pair_id, "reviewerId": "yi", "role": "reviewer", "dependency": dr, "similarity": sr},
            ]
        report = srv.agreement_report(index, {pair_id: "test" for pair_id, *_ in plan}, split="test")
        self.assertEqual(report["pairsWithTwoRaters"], 4)
        self.assertEqual(report["kappaDependency"], 1)
        self.assertEqual(report["kappaSimilarity"], 0.6667)
        self.assertEqual(report["exactSimilarity"], 0.75)
        self.assertEqual(report["withinStepBoth"], 1)
        self.assertEqual(report["maeSimilarity"], 0.0625)
        self.assertEqual(report["statuses"]["agreed"], 3)
        self.assertEqual(report["statuses"]["needs_adjudication"], 1)
        self.assertEqual(report["perReviewer"], {"jia": 4, "yi": 4})

    def test_split_filter_excludes_other_splits(self):
        index = {
            "p1": [row(reviewerId="jia"), row(reviewerId="yi")],
            "p2": [row(id="p2", reviewerId="jia"), row(id="p2", reviewerId="yi")],
        }
        split_of = {"p1": "test", "p2": "train"}
        self.assertEqual(srv.agreement_report(index, split_of, split="test")["pairsWithTwoRaters"], 1)
        self.assertEqual(srv.agreement_report(index, split_of, split="")["pairsWithTwoRaters"], 2)


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="cpdb-store-"))
        self.cards = self.dir / "cards.jsonl"
        self.labels = self.dir / "labels.jsonl"
        self.pairs = self.dir / "pairs.jsonl"
        cards = [
            {"id": "a>b", "split": "test", "kind": "facet_twin", "left": {}, "right": {},
             "teacher": {"dependency": 0.75, "similarity": 0}},
            {"id": "c>d", "split": "train", "kind": "hard_negative", "left": {}, "right": {},
             "teacher": {"dependency": 0, "similarity": 0}},
        ]
        self.cards.write_text("".join(json.dumps(card, ensure_ascii=False) + "\n" for card in cards), encoding="utf-8")
        self.labels.write_text("", encoding="utf-8")
        self.pairs.write_text(
            "".join(json.dumps({"id": card["id"], "initDependency": card["teacher"]["dependency"],
                                "initSimilarity": card["teacher"]["similarity"]}, ensure_ascii=False) + "\n"
                    for card in cards),
            encoding="utf-8",
        )
        self.store = srv.Store(self.cards, self.labels, self.pairs)

    def test_second_reviewer_does_not_overwrite_the_first(self):
        self.store.label({"id": "a>b", "reviewerId": "jia", "role": "reviewer",
                          "dependency": 0.5, "similarity": 0.25})
        self.store.label({"id": "a>b", "reviewerId": "yi", "role": "reviewer",
                          "dependency": 0.5, "similarity": 0.25})
        self.assertEqual(self.store.resolved("a>b")["status"], "agreed")
        self.assertEqual(len(self.store.rows_for("a>b")), 2)

        reloaded = srv.Store(self.cards, self.labels, self.pairs)
        self.assertEqual(len(reloaded.rows_for("a>b")), 2)
        self.assertEqual(reloaded.resolved("a>b")["status"], "agreed")

    def test_adjudicator_only_runs_on_a_disagreement(self):
        with self.assertRaises(ValueError):
            self.store.label({"id": "a>b", "reviewerId": "bing", "role": "adjudicator",
                              "dependency": 0.5, "similarity": 0.25})
        self.store.label({"id": "a>b", "reviewerId": "jia", "role": "reviewer",
                          "dependency": 0.5, "similarity": 0.25})
        self.store.label({"id": "a>b", "reviewerId": "yi", "role": "reviewer",
                          "dependency": 0.75, "similarity": 0.25})
        self.assertEqual(self.store.resolved("a>b")["status"], "needs_adjudication")
        self.store.label({"id": "a>b", "reviewerId": "bing", "role": "adjudicator",
                          "dependency": 0.75, "similarity": 0.25})
        self.assertEqual(self.store.resolved("a>b")["status"], "adjudicated")

    def test_combined_score_and_reserved_reviewer_are_rejected(self):
        with self.assertRaises(ValueError):
            self.store.label({"id": "a>b", "reviewerId": "jia", "combined": 0.5,
                              "dependency": 0.5, "similarity": 0.25})
        with self.assertRaises(ValueError):
            self.store.label({"id": "a>b", "reviewerId": "prelabel_v2",
                              "dependency": 0.5, "similarity": 0.25})

    def test_todo_queue_is_per_reviewer_and_blind_for_test(self):
        self.store.label({"id": "a>b", "reviewerId": "jia", "role": "reviewer",
                          "dependency": 0.5, "similarity": 0.25})
        self.assertEqual(len(self.store.filtered("test", "", "todo", "jia")), 0)
        self.assertEqual(len(self.store.filtered("test", "", "todo", "yi")), 1)
        self.assertEqual(len(self.store.filtered("test", "", "mine", "jia")), 1)
        self.assertEqual(len(self.store.filtered("test", "", "prelabel", "")), 0)

    def test_parse_score_only_accepts_scale_steps(self):
        self.assertEqual(srv.parse_score("0.5"), 0.5)
        self.assertEqual(srv.parse_score(1), 1)
        self.assertIsNone(srv.parse_score(0.4))
        self.assertIsNone(srv.parse_score(None))


if __name__ == "__main__":
    unittest.main(verbosity=2)
