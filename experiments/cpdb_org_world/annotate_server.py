#!/usr/bin/env python3
"""Local browser annotator for CPDB dependency / similarity cards.

Three-person protocol (see ANNOTATION.zh-CN.md):

  * ``human_labels.jsonl`` is a union of rows keyed by ``(pairId, reviewerId)``.
    A second reviewer never overwrites the first one.
  * ``role`` is one of ``prelabel`` (the rule-based AI pass), ``reviewer``
    (an independent blind human pass) or ``adjudicator`` (the tie-break).
  * The ``test`` split is blind: prelabels, the reference/teacher scores and
    other reviewers' answers are withheld until the reader has answered.
  * Gold exists only when two raters agree *exactly* on both axes, or when an
    adjudicator rules. Anything else stays in the adjudication queue.
"""
from __future__ import annotations

import argparse
import json
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

SCALE = [0.0, 0.25, 0.5, 0.75, 1.0]
SPLIT_RANK = {"test": 0, "development": 1, "train": 2}
BLIND_SPLITS = {"test"}
PRELABEL_ID = "prelabel_v1"

ROLE_PRELABEL = "prelabel"
ROLE_REVIEWER = "reviewer"
ROLE_ADJUDICATOR = "adjudicator"
ROLES = {ROLE_PRELABEL, ROLE_REVIEWER, ROLE_ADJUDICATOR}

GOLD_STATUSES = ("single", "agreed", "adjudicated")
OPEN_STATUSES = ("unlabeled", "prelabel", "needs_adjudication")
STATUSES = ("unlabeled", "prelabel", "single", "agreed", "needs_adjudication", "adjudicated")
ROLE_ORDER = {ROLE_PRELABEL: 0, ROLE_REVIEWER: 1, ROLE_ADJUDICATOR: 2}

HTML_PATH = Path(__file__).with_name("annotate.html")
ROOT = Path(__file__).resolve().parent
DEFAULT_CARDS = ROOT / "data" / "full" / "annotation_cards.jsonl"
DEFAULT_LABELS = ROOT / "data" / "full" / "human_labels.jsonl"
DEFAULT_PAIRS = ROOT / "data" / "full" / "pairs.jsonl"


# --------------------------------------------------------------------------- #
# row helpers (mirrors lib/consensus.mjs -- keep the two in sync)
# --------------------------------------------------------------------------- #

def reviewer_id_of(row: dict) -> str:
    return str(row.get("reviewerId") or row.get("annotatorId") or "").strip()


def is_prelabel_row(row: dict) -> bool:
    if not row:
        return False
    if str(row.get("role") or "") == ROLE_PRELABEL:
        return True
    return reviewer_id_of(row).startswith("prelabel")


def role_of(row: dict) -> str:
    role = str(row.get("role") or "").strip()
    if role in ROLES:
        return role
    return ROLE_PRELABEL if is_prelabel_row(row) else ROLE_REVIEWER


def is_blind_split(split) -> bool:
    return str(split or "") in BLIND_SPLITS


def raters_of(rows: list[dict]) -> list[dict]:
    return [row for row in rows if role_of(row) == ROLE_REVIEWER]


def adjudicators_of(rows: list[dict]) -> list[dict]:
    return [row for row in rows if role_of(row) == ROLE_ADJUDICATOR]


def prelabel_of(rows: list[dict]) -> dict | None:
    return next((row for row in rows if is_prelabel_row(row)), None)


def review_of(rows: list[dict], reviewer: str) -> dict | None:
    want = str(reviewer or "").strip()
    if not want:
        return None
    matches = [row for row in rows if reviewer_id_of(row) == want]
    return matches[-1] if matches else None


def _scores(row: dict | None) -> tuple[float, float]:
    if not row:
        return None, None
    return row.get("dependency"), row.get("similarity")


def resolve_pair(rows: list[dict]) -> dict:
    """Resolve one pair's rows into a status plus gold scores."""
    adjudications = adjudicators_of(rows)
    raters = raters_of(rows)
    prelabel = prelabel_of(rows)

    if adjudications:
        last = adjudications[-1]
        dependency, similarity = _scores(last)
        return {
            "status": "adjudicated",
            "reviewerId": reviewer_id_of(last),
            "dependency": dependency,
            "similarity": similarity,
            "rationale": str(last.get("rationale") or ""),
            "raterCount": len(raters),
            "prelabelOnly": False,
        }

    if len(raters) >= 2:
        dependencies = [row.get("dependency") for row in raters]
        similarities = [row.get("similarity") for row in raters]
        agreed = len(set(dependencies)) == 1 and len(set(similarities)) == 1
        if agreed:
            first = raters[0]
            return {
                "status": "agreed",
                "reviewerId": reviewer_id_of(first),
                "dependency": dependencies[0],
                "similarity": similarities[0],
                "rationale": str(first.get("rationale") or ""),
                "raterCount": len(raters),
                "prelabelOnly": False,
            }
        return {
            "status": "needs_adjudication",
            "reviewerId": "",
            "dependency": None,
            "similarity": None,
            "rationale": "",
            "raterCount": len(raters),
            "prelabelOnly": False,
        }

    if len(raters) == 1:
        first = raters[0]
        dependency, similarity = _scores(first)
        return {
            "status": "single",
            "reviewerId": reviewer_id_of(first),
            "dependency": dependency,
            "similarity": similarity,
            "rationale": str(first.get("rationale") or ""),
            "raterCount": 1,
            "prelabelOnly": False,
        }

    if prelabel:
        dependency, similarity = _scores(prelabel)
        return {
            "status": "prelabel",
            "reviewerId": reviewer_id_of(prelabel),
            "dependency": dependency,
            "similarity": similarity,
            "rationale": str(prelabel.get("rationale") or ""),
            "raterCount": 0,
            "prelabelOnly": True,
        }

    return {
        "status": "unlabeled",
        "reviewerId": "",
        "dependency": None,
        "similarity": None,
        "rationale": "",
        "raterCount": 0,
        "prelabelOnly": False,
    }


def cohen_kappa(pairs: list[tuple[float, float]]) -> float | None:
    usable = [(left, right) for left, right in pairs if left in SCALE and right in SCALE]
    if not usable:
        return None
    size = len(SCALE)
    matrix = [[0] * size for _ in range(size)]
    for left, right in usable:
        matrix[SCALE.index(left)][SCALE.index(right)] += 1
    total = len(usable)
    row_sums = [sum(row) for row in matrix]
    col_sums = [sum(matrix[i][j] for i in range(size)) for j in range(size)]
    observed = sum(matrix[i][i] for i in range(size))
    po = observed / total
    pe = sum((row_sums[i] / total) * (col_sums[i] / total) for i in range(size))
    if abs(1 - pe) < 1e-9:
        return 1.0
    return (po - pe) / (1 - pe)


def agreement_report(review_index: dict, split_of: dict, split: str = "") -> dict:
    report = {
        "split": split or "all",
        "pairsWithTwoRaters": 0,
        "exactDependency": 0.0,
        "exactSimilarity": 0.0,
        "exactBoth": 0.0,
        "withinStepDependency": 0.0,
        "withinStepSimilarity": 0.0,
        "withinStepBoth": 0.0,
        "maeDependency": 0.0,
        "maeSimilarity": 0.0,
        "kappaDependency": None,
        "kappaSimilarity": None,
        "statuses": {name: 0 for name in STATUSES},
        "perReviewer": {},
    }
    dependency_pairs: list[tuple[float, float]] = []
    similarity_pairs: list[tuple[float, float]] = []
    abs_dependency = 0.0
    abs_similarity = 0.0

    for pair_id, rows in review_index.items():
        resolved = resolve_pair(rows)
        if resolved["status"] in report["statuses"]:
            report["statuses"][resolved["status"]] += 1
        for row in raters_of(rows):
            who = reviewer_id_of(row)
            if who:
                report["perReviewer"][who] = report["perReviewer"].get(who, 0) + 1
        if split and split_of.get(pair_id) != split:
            continue
        raters = raters_of(rows)
        if len(raters) < 2:
            continue
        left, right = raters[0], raters[1]
        dl, sl = _scores(left)
        dr, sr = _scores(right)
        if dl is None or dr is None or sl is None or sr is None:
            continue

        report["pairsWithTwoRaters"] += 1
        dependency_pairs.append((dl, dr))
        similarity_pairs.append((sl, sr))
        abs_dependency += abs(dl - dr)
        abs_similarity += abs(sl - sr)
        same_d = dl == dr
        same_s = sl == sr
        near_d = abs(dl - dr) <= 0.25
        near_s = abs(sl - sr) <= 0.25
        report["exactDependency"] += 1 if same_d else 0
        report["exactSimilarity"] += 1 if same_s else 0
        report["exactBoth"] += 1 if (same_d and same_s) else 0
        report["withinStepDependency"] += 1 if near_d else 0
        report["withinStepSimilarity"] += 1 if near_s else 0
        report["withinStepBoth"] += 1 if (near_d and near_s) else 0

    count = report["pairsWithTwoRaters"]
    report["maeDependency"] = round4(abs_dependency / count) if count else 0.0
    report["maeSimilarity"] = round4(abs_similarity / count) if count else 0.0
    report["kappaDependency"] = round4(cohen_kappa(dependency_pairs))
    report["kappaSimilarity"] = round4(cohen_kappa(similarity_pairs))
    for key in (
        "exactDependency", "exactSimilarity", "exactBoth",
        "withinStepDependency", "withinStepSimilarity", "withinStepBoth",
    ):
        report[key] = round4(report[key] / count) if count else 0.0
    return report


def round4(value):
    if value is None or not isinstance(value, (int, float)):
        return None
    number = float(value)
    if number != number or number in (float("inf"), float("-inf")):
        return None
    return round(number * 10000) / 10000


# --------------------------------------------------------------------------- #
# store
# --------------------------------------------------------------------------- #

class Store:
    def __init__(self, cards: Path, labels: Path, pairs: Path):
        self.cards_path = cards
        self.labels_path = labels
        self.pairs_path = pairs
        self.lock = threading.Lock()
        self.cards = read_jsonl(cards)
        self.split_of = {card.get("id"): card.get("split") for card in self.cards}

        # flat rows keyed by (pairId, reviewerId); the pair index is derived.
        rows = [row for row in read_jsonl(labels) if row.get("id")]
        self.rows: dict[tuple[str, str], dict] = {}
        for row in rows:
            clean = normalize_row(row)
            self.rows[(clean["id"], clean["reviewerId"])] = clean
        self.reindex()

        self.teacher = {}
        if pairs.exists():
            for row in read_jsonl(pairs):
                self.teacher[row.get("id")] = {
                    "dependency": row.get("initDependency"),
                    "similarity": row.get("initSimilarity"),
                }

    # -- derived indexes ---------------------------------------------------- #

    def reindex(self) -> None:
        self.by_pair: dict[str, list[dict]] = {}
        for (pair_id, _), row in self.rows.items():
            self.by_pair.setdefault(pair_id, []).append(row)
        for bucket in self.by_pair.values():
            bucket.sort(key=lambda row: (ROLE_ORDER.get(role_of(row), 9), reviewer_id_of(row)))

    def rows_for(self, pair_id: str) -> list[dict]:
        return self.by_pair.get(pair_id, [])

    def resolved(self, pair_id: str) -> dict:
        return resolve_pair(self.rows_for(pair_id))

    def resolved_all(self) -> dict:
        return {card.get("id"): resolve_pair(self.rows_for(card.get("id"))) for card in self.cards}

    # -- persistence -------------------------------------------------------- #

    def save_rows(self) -> None:
        self.labels_path.parent.mkdir(parents=True, exist_ok=True)
        ordered = sorted(self.rows.values(), key=lambda row: (str(row.get("id")), reviewer_id_of(row)))
        write_jsonl(self.labels_path, ordered)

    # -- queries ------------------------------------------------------------ #

    def stats(self, reviewer: str = "") -> dict:
        who = reviewer.strip()
        splits: dict[str, dict] = {}
        statuses = {name: 0 for name in STATUSES}
        for card in self.cards:
            split = card.get("split") or "train"
            bucket = splits.setdefault(split, {"total": 0, "mine": 0, **{name: 0 for name in STATUSES}})
            bucket["total"] += 1
            resolved = self.resolved(card.get("id"))
            status = resolved["status"]
            if status in bucket:
                bucket[status] += 1
            if status in statuses:
                statuses[status] += 1
            if who and review_of(self.rows_for(card.get("id")), who):
                bucket["mine"] += 1

        reviewers: dict[str, dict] = {}
        for (_, reviewer_id), row in self.rows.items():
            if is_prelabel_row(row) or not reviewer_id:
                continue
            bucket = reviewers.setdefault(reviewer_id, {"all": 0, "role": role_of(row)})
            bucket["all"] += 1
            bucket[row.get("split") or "unknown"] = bucket.get(row.get("split") or "unknown", 0) + 1

        return {
            "total": len(self.cards),
            "reviewer": who,
            "statuses": statuses,
            "splits": splits,
            "reviewers": reviewers,
            "prelabelId": PRELABEL_ID,
            "blindSplits": sorted(BLIND_SPLITS),
        }

    def agreement(self, split: str = "") -> dict:
        return agreement_report(self.by_pair, self.split_of, split)

    def _status(self, card: dict) -> str:
        return self.resolved(card.get("id"))["status"]

    def filtered(self, split: str, kind: str, queue: str, reviewer: str) -> list[dict]:
        who = reviewer.strip()
        rows = []
        for card in self.cards:
            if split and card.get("split") != split:
                continue
            if kind and card.get("kind") != kind:
                continue
            pair_id = card.get("id")
            status = self._status(card)
            mine = bool(who) and review_of(self.rows_for(pair_id), who) is not None
            if queue == "todo":
                # my own independent pass: already-answered pairs drop out even
                # if somebody else answered them too.
                if mine or status == "adjudicated":
                    continue
            elif queue == "mine":
                if not mine:
                    continue
            elif queue == "adjudicate":
                if status != "needs_adjudication":
                    continue
            elif queue == "prelabel":
                if status != "prelabel":
                    continue
            elif queue == "reviewed":
                if status in ("unlabeled", "prelabel"):
                    continue
            elif queue == "open":
                if status not in OPEN_STATUSES:
                    continue
            rows.append(card)
        rows.sort(key=lambda card: (SPLIT_RANK.get(card.get("split"), 9), str(card.get("id"))))
        return rows

    def pick(self, split, kind, queue, reviewer, after, direction) -> dict | None:
        rows = self.filtered(split, kind, queue, reviewer)
        if not rows:
            return None
        if not after:
            return rows[0]
        ids = [card.get("id") for card in rows]
        try:
            index = ids.index(after)
        except ValueError:
            return rows[0]
        if direction == "prev":
            return rows[index - 1] if index > 0 else rows[0]
        if index + 1 < len(rows):
            return rows[index + 1]
        return None

    # -- writes ------------------------------------------------------------- #

    def label(self, payload: dict) -> dict:
        pair_id = str(payload.get("id") or "")
        reviewer = str(payload.get("reviewerId") or payload.get("annotatorId") or "").strip()
        role = str(payload.get("role") or ROLE_REVIEWER).strip() or ROLE_REVIEWER
        dependency = parse_score(payload.get("dependency"))
        similarity = parse_score(payload.get("similarity"))

        if not pair_id or not reviewer:
            raise ValueError("id_annotator_required")
        if dependency is None or similarity is None:
            raise ValueError("both_scores_required")
        if payload.get("combined") is not None:
            raise ValueError("combined_score_forbidden")
        if role not in (ROLE_REVIEWER, ROLE_ADJUDICATOR):
            raise ValueError("bad_role")
        if reviewer.startswith("prelabel"):
            raise ValueError("reserved_reviewer_id")

        card = next((item for item in self.cards if item.get("id") == pair_id), None)
        if card is None:
            raise KeyError("card_not_found")
        if role == ROLE_ADJUDICATOR and not payload.get("force"):
            if self.resolved(pair_id)["status"] != "needs_adjudication":
                raise ValueError("not_in_adjudication")

        row = {
            "id": pair_id,
            "reviewerId": reviewer,
            "role": role,
            "dependency": dependency,
            "similarity": similarity,
            "rationale": str(payload.get("rationale") or "").strip(),
            "split": card.get("split"),
            "kind": card.get("kind"),
            "blind": bool(payload.get("blind")),
            "at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
        self.rows[(pair_id, reviewer)] = row
        self.reindex()
        self.save_rows()
        return row


# --------------------------------------------------------------------------- #
# http
# --------------------------------------------------------------------------- #

class Handler(BaseHTTPRequestHandler):
    store: Store

    def send_json(self, status: int, payload) -> None:
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def send_html(self) -> None:
        raw = HTML_PATH.read_text(encoding="utf-8").encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        first = lambda key, default="": (query.get(key) or [default])[0]

        if parsed.path in ("/", "/index.html"):
            self.send_html()
            return

        if parsed.path == "/api/stats":
            with self.store.lock:
                self.send_json(200, self.store.stats(reviewer=first("reviewer")))
            return

        if parsed.path == "/api/agreement":
            with self.store.lock:
                self.send_json(200, self.store.agreement(split=first("split")))
            return

        if parsed.path == "/api/card":
            queue = first("queue")
            split = first("split")
            reviewer = first("reviewer") or first("annotatorId")
            blind_param = first("blind")
            with self.store.lock:
                card = self.store.pick(
                    split=split,
                    kind=first("kind"),
                    queue=queue,
                    reviewer=reviewer,
                    after=first("after"),
                    direction=first("dir") or "next",
                )
                payload = self.card_payload(card, reviewer, blind_param, queue, first("teacher") == "1")
            self.send_json(200, payload)
            return

        self.send_json(404, {"error": "not_found"})

    def card_payload(self, card, reviewer: str, blind_param: str, queue: str, want_teacher: bool) -> dict:
        if not card:
            return {"card": None, "teacher": None}
        pair_id = card.get("id")
        rows = self.store.rows_for(pair_id)
        resolved = resolve_pair(rows)
        mine = review_of(rows, reviewer)
        if blind_param == "1":
            blind = True
        elif blind_param == "0":
            blind = False
        else:
            blind = is_blind_split(card.get("split")) and queue != "adjudicate"

        public = dict(card)
        public.pop("teacher", None)
        public["status"] = resolved["status"]
        public["blind"] = blind
        public["raterCount"] = resolved["raterCount"]
        public["mine"] = public_row(mine)
        public["peers"] = []

        if blind and mine is None:
            # withhold everything that could anchor an independent pass
            public.pop("human", None)
            public["human"] = None
            return {"card": public, "teacher": None}

        if blind and mine is not None:
            public["human"] = public_row(mine)
        else:
            public["human"] = {
                "dependency": resolved["dependency"],
                "similarity": resolved["similarity"],
                "annotatorId": resolved["reviewerId"],
                "rationale": resolved["rationale"],
                "status": resolved["status"],
            }
            if resolved["status"] in ("needs_adjudication", "adjudicated"):
                public["peers"] = [
                    {
                        "reviewerId": reviewer_id_of(row),
                        "role": role_of(row),
                        "dependency": row.get("dependency"),
                        "similarity": row.get("similarity"),
                        "rationale": str(row.get("rationale") or ""),
                    }
                    for row in rows
                ]

        teacher = self.store.teacher.get(pair_id) if (want_teacher and not blind) else None
        return {"card": public, "teacher": teacher}

    def do_POST(self) -> None:
        if self.path != "/api/label":
            self.send_json(404, {"error": "not_found"})
            return
        length = int(self.headers.get("Content-Length") or 0)
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception:
            self.send_json(400, {"error": "invalid_json"})
            return
        try:
            with self.store.lock:
                row = self.store.label(payload)
                resolved = self.store.resolved(row["id"])
            self.send_json(200, {"ok": True, "label": row, "status": resolved["status"]})
        except ValueError as error:
            self.send_json(400, {"error": str(error)})
        except KeyError as error:
            self.send_json(404, {"error": str(error)})

    def log_message(self, *_args) -> None:
        return


def public_row(row: dict | None) -> dict | None:
    if not row:
        return None
    return {
        "dependency": row.get("dependency"),
        "similarity": row.get("similarity"),
        "reviewerId": reviewer_id_of(row),
        "role": role_of(row),
        "rationale": str(row.get("rationale") or ""),
        "at": row.get("at") or "",
    }


def normalize_row(row: dict) -> dict:
    """Rewrite legacy `annotatorId`-only rows into the canonical union shape."""
    normalized = dict(row)
    role = role_of(row)
    normalized["reviewerId"] = reviewer_id_of(row)
    normalized["role"] = role
    if role == ROLE_PRELABEL:
        normalized["status"] = "prelabel"
    else:
        normalized.pop("status", None)
    return normalized


def parse_score(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    quantized = min(SCALE, key=lambda item: abs(item - number))
    return quantized if abs(quantized - number) < 0.001 else None


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    rows = []
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        if line.strip():
            rows.append(json.loads(line))
    return rows


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")


class AnnotateServer(ThreadingHTTPServer):
    # Windows honours SO_REUSEADDR by letting a *second* process bind the same
    # port, and then either process may answer.  That silently serves stale
    # labels, so refuse the second bind instead of sharing the port.
    allow_reuse_address = False
    daemon_threads = True


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cards", default=str(DEFAULT_CARDS))
    parser.add_argument("--labels", default=str(DEFAULT_LABELS))
    parser.add_argument("--pairs", default=str(DEFAULT_PAIRS))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--report", action="store_true", help="print progress + agreement and exit")
    parser.add_argument("--split", default="", help="restrict --report to one split")
    args = parser.parse_args()

    Handler.store = Store(Path(args.cards), Path(args.labels), Path(args.pairs))

    if args.report:
        store = Handler.store
        print(json.dumps({
            "stats": store.stats(),
            "agreement": store.agreement(split=args.split),
        }, ensure_ascii=False, indent=2))
        return

    try:
        server = AnnotateServer((args.host, args.port), Handler)
    except OSError as error:
        raise SystemExit(
            f"端口 {args.port} 已被占用（{error}）。另一个标注服务还在跑，先关掉它再启动；"
            "否则两边会各写一份标签文件。"
        )

    stats = Handler.store.stats()
    print(f"http://{args.host}:{args.port}/", flush=True)
    print(f"cards={args.cards}", flush=True)
    print(f"rows={len(Handler.store.rows)} prelabel={stats['statuses']['prelabel']}", flush=True)
    print("三人流程：甲/乙先在 test 盲标（互不可见），丙仲裁 test 分歧并复核 train/development 预标。", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
