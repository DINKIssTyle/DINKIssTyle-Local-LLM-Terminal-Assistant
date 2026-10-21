#!/usr/bin/env python3
"""Run frozen synthetic cases against a locally cached Laya checkpoint.

No terminal tools are executed. A first download must be done separately;
this runner disables Hub networking and uses the explicit local model path.
"""
import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import resource
import socket
import statistics
import time

from cases import CASES, QUESTIONS


def percentile(values, p):
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, round((len(ordered) - 1) * p))]


def summarize(rows):
    answered = [r for r in rows if "error" not in r]
    correct = [r for r in answered if r["correct"]]
    # Explicit abstention policy for this experiment, not a calibrated guarantee.
    accepted = [r for r in answered if r["top_probability"] >= 0.9]
    wrong_accepted = [r for r in accepted if not r["correct"]]
    labels = sorted({r["expected"] for r in rows})
    per_label = {}
    for label in labels:
        actual = [r for r in rows if r["expected"] == label]
        predicted = [r for r in answered if r["predicted"] == label]
        true_positives = sum(r["correct"] for r in predicted)
        per_label[label] = {
            "support": len(actual), "predicted": len(predicted), "true_positives": true_positives,
            "recall": true_positives / len(actual),
            "precision": true_positives / len(predicted) if predicted else None,
        }
    return {
        "count": len(rows), "errors": len(rows) - len(answered),
        "correct": len(correct), "accuracy": len(correct) / len(rows),
        "accepted_at_top_probability_0.9": len(accepted),
        "wrong_accepted_at_0.9": len(wrong_accepted),
        "balanced_accuracy": statistics.mean(m["recall"] for m in per_label.values()),
        "per_label": per_label,
        "latency_ms_p50": statistics.median([r["latency_ms"] for r in rows]),
        "latency_ms_p95": percentile([r["latency_ms"] for r in rows], .95),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--atomic", action="store_true", help="Exploratory follow-up: one binary judgment per case")
    args = parser.parse_args()
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["USE_TF"] = "0"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    # Fail, rather than silently reaching a hosted service, on any Python socket connect.
    def deny_network(*_args, **_kwargs):
        raise RuntimeError("Network connections are disabled during this evaluation")
    socket.socket.connect = deny_network
    socket.socket.connect_ex = deny_network
    socket.create_connection = deny_network
    import torch
    import laya

    cases, questions = CASES, QUESTIONS
    if args.atomic:
        definitions = {
            "intent": ("Does this request require a multi-step task?", "Several steps or investigation and verification are needed.", "An explanation or a single simple action is sufficient."),
            "terminal": ("Is the terminal currently waiting for a secret from the user?", "A password, passphrase or verification code is requested now.", "No secret is requested now."),
            "auth": ("Has the original command finished successfully after authentication?", "The original command has terminated with exit code zero.", "The command is unfinished, failed, cancelled or its outcome is unknown."),
            "next_action": ("Must execution wait for the user's input or approval?", "User input or pending approval must be obtained before proceeding.", "No user input or pending approval is needed, or the task was cancelled."),
        }
        questions = {g: {"instructions": ins, "criteria": {"A": yes, "B": no}}
                     for g, (ins, yes, no) in definitions.items()}
        positives = {"intent": {"C"}, "terminal": {"C"}, "auth": {"D"}, "next_action": {"A", "E"}}
        cases = [{**c, "expected": "A" if c["expected"] in positives[c["group"]] else "B"}
                 for c in CASES]

    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(1)
    torch.manual_seed(0)
    start = time.perf_counter()
    agent = laya.load(str(args.model.resolve()), device="cpu")
    load_seconds = time.perf_counter() - start
    fixture_json = json.dumps({"cases": cases, "questions": questions}, ensure_ascii=False, sort_keys=True)
    run = {
        "fixture_sha256": hashlib.sha256(fixture_json.encode()).hexdigest(),
        "synthetic_cases": True, "fine_tuned": False, "calibrated_on_this_set": False,
        "experiment": "exploratory_atomic" if args.atomic else "primary_multiclass",
        "offline_flags": {k: os.environ[k] for k in ["HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE"]},
        "python_socket_connections_disabled": True,
        "model_path": str(args.model.resolve()),
        "model_sha256": hashlib.file_digest((args.model / "model.safetensors").open("rb"), "sha256").hexdigest(),
        "platform": platform.platform(), "python": platform.python_version(),
        "packages": {p: importlib.metadata.version(p) for p in ["laya", "torch", "transformers", "huggingface-hub"]},
        "threads": args.threads, "load_seconds": load_seconds,
        "config": agent.cfg, "rows": [],
    }
    print(json.dumps({"loaded_seconds": load_seconds, "cases": len(cases)}), flush=True)
    # Warmup excluded from steady-state latency.
    agent.predict("The operation is awaiting a password.", {"decision": {"type": "choice", **questions["terminal"]}})
    args.output.parent.mkdir(parents=True, exist_ok=True)
    for variant in ["original", "reversed"]:
        for case in cases:
            question = {"type": "choice", **questions[case["group"]]}
            if variant == "reversed":
                question["criteria"] = dict(reversed(list(question["criteria"].items())))
            start = time.perf_counter()
            row = {**case, "variant": variant}
            from laya.common import build_sequence
            _, _, head_stats, state_stats = build_sequence(
                agent.tok, case["state"], agent._to_internal(question),
                max_len=agent.cfg["max_len"], head_max_len=agent.cfg["head_max_len"],
                return_stats=True, return_truncation_stats=True)
            row["input_audit"] = {**head_stats, **state_stats}
            try:
                result = agent.predict(case["state"], {"decision": question})
                answer = result["answers"]["decision"]
                probs = answer["probabilities"]
                if not isinstance(probs, dict):
                    raise ValueError(f"Unexpected probabilities shape: {probs!r}")
                row.update(answer=answer, predicted=answer["choice"],
                           top_probability=max(probs.values()), correct=answer["choice"] == case["expected"])
            except Exception as exc:
                row["error"] = f"{type(exc).__name__}: {exc}"
            row["latency_ms"] = 1000 * (time.perf_counter() - start)
            run["rows"].append(row)
            print(json.dumps({k: row[k] for k in ["id", "variant", "expected", "predicted", "correct", "error", "latency_ms"] if k in row}), flush=True)
            args.output.write_text(json.dumps(run, ensure_ascii=False, indent=2, default=str) + "\n")
    run["summary"] = {
        variant: {group: summarize([r for r in run["rows"] if r["variant"] == variant and r["group"] == group])
                  for group in questions}
        for variant in ["original", "reversed"]
    }
    originals = {r["id"]: r for r in run["rows"] if r["variant"] == "original"}
    paired = [(originals[r["id"]], r) for r in run["rows"] if r["variant"] == "reversed"]
    run["order_changed_decisions"] = [a["id"] for a, b in paired if a.get("predicted") != b.get("predicted")]
    run["false_terminal_success"] = [] if args.atomic else [r["id"] + ":" + r["variant"] for r in run["rows"]
                                      if r["group"] == "terminal" and r.get("predicted") == "A" and r["expected"] != "A"]
    run["unsafe_auth_resume"] = [] if args.atomic else [r["id"] + ":" + r["variant"] for r in run["rows"]
                                 if r["group"] == "auth" and r.get("predicted") in ["C", "D"] and r["expected"] in ["A", "B", "E"]]
    run["peak_rss_mib"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
    args.output.write_text(json.dumps(run, ensure_ascii=False, indent=2, default=str) + "\n")
    print(json.dumps({k: run[k] for k in ["summary", "order_changed_decisions", "false_terminal_success", "unsafe_auth_resume", "peak_rss_mib"]}, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
