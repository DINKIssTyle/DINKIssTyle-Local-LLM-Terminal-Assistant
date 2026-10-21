"""Audit the primary experiment's tokenizer budgets without re-running inference."""
import json
import os
from pathlib import Path
import sys

os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", USE_TF="0")
from transformers import AutoTokenizer
from laya.agent import Agent
from laya.common import build_head, build_sequence, encode_text, render_options
from cases import QUESTIONS

model_path, results_path = map(Path, sys.argv[1:])
tok = AutoTokenizer.from_pretrained(str(model_path / "tokenizer"), local_files_only=True)
cfg = json.loads((model_path / "rl_agent_config.json").read_text())
run = json.loads(results_path.read_text())
for row in run["rows"]:
    question = {"type": "choice", **QUESTIONS[row["group"]]}
    if row["variant"] == "reversed":
        question["criteria"] = dict(reversed(list(question["criteria"].items())))
    q = Agent._to_internal(question)
    _, markers, _ = build_head(tok, q, cfg["head_max_len"])
    instruction_tokens = len(encode_text(tok, f'{q["t"]} question: {q["ins"]}', add_special_tokens=False)["input_ids"])
    option_lengths = [len(encode_text(tok, " " + opt, add_special_tokens=False)["input_ids"])
                      for opt in render_options(q)]
    _, _, head, state = build_sequence(tok, row["state"], q, max_len=cfg["max_len"],
                                      head_max_len=cfg["head_max_len"], return_stats=True,
                                      return_truncation_stats=True)
    row["input_audit"] = {**head, **state, "instruction_tokens": instruction_tokens,
                          "instruction_tokens_used": markers[0] - 2,
                          "option_tokens_before_cap": option_lengths}
run["input_audit_summary"] = {
    "state_truncated": sum(r["input_audit"]["truncated"] for r in run["rows"]),
    "instruction_truncated": sum(r["input_audit"]["instruction_tokens_used"] < r["input_audit"]["instruction_tokens"] for r in run["rows"]),
    "option_over_48_tokens": sum(any(n > 48 for n in r["input_audit"]["option_tokens_before_cap"]) for r in run["rows"]),
    "options_collapsed": sum(r["input_audit"]["options"] != r["input_audit"]["options_distinct"] for r in run["rows"]),
}
results_path.write_text(json.dumps(run, ensure_ascii=False, indent=2) + "\n")
print(json.dumps(run["input_audit_summary"], indent=2))
